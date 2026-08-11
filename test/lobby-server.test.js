import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createLobbyServer } from "../src/server.js";

const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function opened(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.messages = [];
    socket.on("message", (data) => socket.messages.push(JSON.parse(data.toString())));
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function createMatch(baseUrl, body, token = "admin-secret") {
  return fetch(`${baseUrl}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("lobby lists configured agents and requires admin authentication", async () => {
  const lobby = createLobbyServer({ agents: [{ id: "alpha", label: "Alpha" }, "beta"], adminToken: "admin-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const agents = await (await fetch(`${baseUrl}/api/agents`)).json();
    assert.deepEqual(agents, { agents: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "beta" }] });

    const unauthorized = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "beta"] }, "wrong");
    assert.equal(unauthorized.status, 401);
    assert.equal(lobby.sessions.size, 0);

    const invalid = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "alpha"] });
    assert.equal(invalid.status, 400);
    assert.equal(lobby.sessions.size, 0);
  } finally {
    await lobby.stop();
  }
});

test("a lobby match waits for both selected agents and uses match-scoped routes", async () => {
  const lobby = createLobbyServer({ agents: ["alpha", "beta", "gamma"], adminToken: "admin-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  let alpha; let beta;
  try {
    const response = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "beta"], dicePerPlayer: 3 });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.match.status, "waiting");
    assert.equal(created.connection.endpoint, "/agent/table-1");
    assert.deepEqual(created.connection.credentials.map(({ player }) => player), ["alpha", "beta"]);
    assert.ok(created.connection.credentials.every(({ token }) => token.length >= 32));
    assert.notEqual(created.connection.credentials[0].token, created.connection.credentials[1].token);
    const tokens = Object.fromEntries(created.connection.credentials.map(({ player, token }) => [player, token]));

    alpha = await opened(`${wsBase}${created.connection.endpoint}?player=alpha&token=${tokens.alpha}`);
    alpha.send(JSON.stringify({ match_id: "table-1", your_turn_seq: 0,
      move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
    await wait();
    assert.equal(alpha.messages.length, 0);
    assert.equal(lobby.getMatch("table-1").status, "waiting");
    assert.equal(lobby.getMatch("table-1").match.snapshot().bid, null);

    const impostor = new WebSocket(`${wsBase}${created.connection.endpoint}?player=beta&token=${tokens.alpha}`);
    const rejected = await new Promise((resolve) => impostor.once("close", (_code, reason) => resolve(reason.toString())));
    assert.equal(rejected, "invalid match token");

    beta = await opened(`${wsBase}${created.connection.endpoint}?player=beta&token=${tokens.beta}`);
    await wait();
    assert.deepEqual(alpha.messages.map((message) => message.type), ["match_start", "round_start", "your_turn"]);
    assert.deepEqual(beta.messages.map((message) => message.type), ["match_start", "round_start"]);
    assert.equal(alpha.messages[0].rules.dice_per_player, 3);
    assert.equal(lobby.getMatch("table-1").status, "running");

    const listed = await (await fetch(`${baseUrl}/api/matches`)).json();
    assert.deepEqual(listed.matches[0].connected.sort(), ["alpha", "beta"]);
    assert.ok(created.connection.credentials.every(({ token }) => !JSON.stringify(listed).includes(token)));

    const duplicate = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "gamma"] });
    assert.equal(duplicate.status, 409);
  } finally {
    alpha?.close(); beta?.close();
    await lobby.stop();
  }
});

test("matches on one lobby listener keep coordinator state isolated and can be deleted", async () => {
  const lobby = createLobbyServer({ agents: ["a", "b"], adminToken: "admin-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const sockets = [];
  try {
    const first = await (await createMatch(baseUrl, { matchId: "first", players: ["a", "b"], seed: 2 })).json();
    const second = await (await createMatch(baseUrl, { matchId: "second", players: ["a", "b"], seed: 9 })).json();
    for (const created of [first, second]) {
      for (const { player, token } of created.connection.credentials) {
        sockets.push(await opened(`${wsBase}${created.connection.endpoint}?player=${player}&token=${token}`));
      }
    }
    await wait();
    sockets[0].send(JSON.stringify({ match_id: "first", your_turn_seq: 0,
      move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
    await wait();
    assert.deepEqual(lobby.getMatch("first").match.snapshot().bid, { quantity: 1, face: 2 });
    assert.equal(lobby.getMatch("second").match.snapshot().bid, null);

    const removed = await fetch(`${baseUrl}/api/matches/second`, { method: "DELETE", headers: { authorization: "Bearer admin-secret" } });
    assert.equal(removed.status, 204);
    assert.equal(lobby.getMatch("second"), undefined);
  } finally {
    for (const socket of sockets) socket.close();
    await lobby.stop();
  }
});
