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

function registered(url, id, { label = id, token = "registration-secret", activeMatchId = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}/register`);
    socket.messages = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()); socket.messages.push(message);
      if (message.type === "registered") resolve(socket);
    });
    socket.once("open", () => socket.send(JSON.stringify({ type: "register", agent_id: id, label, token,
      active_match_id: activeMatchId })));
    socket.once("error", reject);
    socket.once("close", (_code, reason) => reject(new Error(reason.toString() || "registration closed")));
  });
}

async function createMatch(baseUrl, body, token = "admin-secret") {
  return fetch(`${baseUrl}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("agents define their identities through authenticated registration", async () => {
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const sockets = [];
  try {
    assert.deepEqual(await (await fetch(`${baseUrl}/api/agents`)).json(), { agents: [] });
    const invalid = new WebSocket(`${wsBase}/register`);
    invalid.once("open", () => invalid.send(JSON.stringify({ type: "register", agent_id: "intruder", token: "wrong" })));
    const reason = await new Promise((resolve) => invalid.once("close", (_code, value) => resolve(value.toString())));
    assert.equal(reason, "invalid registration");

    sockets.push(await registered(wsBase, "alpha", { label: "Alpha Model" }));
    sockets.push(await registered(wsBase, "beta"));
    const agents = await (await fetch(`${baseUrl}/api/agents`)).json();
    assert.deepEqual(agents.agents.map(({ id, label, status }) => ({ id, label, status })), [
      { id: "alpha", label: "Alpha Model", status: "available" },
      { id: "beta", label: "beta", status: "available" },
    ]);

    const duplicate = new WebSocket(`${wsBase}/register`);
    duplicate.once("open", () => duplicate.send(JSON.stringify({ type: "register", agent_id: "alpha", token: "registration-secret" })));
    const duplicateReason = await new Promise((resolve) => duplicate.once("close", (_code, value) => resolve(value.toString())));
    assert.equal(duplicateReason, "agent already registered");

    const unauthorized = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "beta"] }, "wrong");
    assert.equal(unauthorized.status, 401);
    const unknown = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "missing"] });
    assert.equal(unknown.status, 400);
  } finally {
    for (const socket of sockets) socket.close();
    await lobby.stop();
  }
});

test("match creation privately assigns available registered agents", async () => {
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const registrations = [await registered(wsBase, "alpha"), await registered(wsBase, "beta"), await registered(wsBase, "gamma")];
  let alpha; let beta;
  try {
    const response = await createMatch(baseUrl, { matchId: "table-1", players: ["alpha", "beta"], dicePerPlayer: 3 });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.match.status, "waiting");
    assert.equal(JSON.stringify(created).includes("token"), false);
    await wait();
    const assignments = Object.fromEntries(registrations.slice(0, 2).map((socket) => {
      const assignment = socket.messages.find((message) => message.type === "match_assignment");
      return [assignment.player, assignment];
    }));
    assert.ok(assignments.alpha.token.length >= 32);
    assert.notEqual(assignments.alpha.token, assignments.beta.token);

    alpha = await opened(`${wsBase}${assignments.alpha.endpoint}?player=alpha&token=${assignments.alpha.token}`);
    alpha.send(JSON.stringify({ match_id: "table-1", your_turn_seq: 0,
      move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
    await wait();
    assert.equal(alpha.messages.length, 0);
    assert.equal(lobby.getMatch("table-1").match.snapshot().bid, null);

    const impostor = new WebSocket(`${wsBase}${assignments.beta.endpoint}?player=beta&token=${assignments.alpha.token}`);
    const rejected = await new Promise((resolve) => impostor.once("close", (_code, reason) => resolve(reason.toString())));
    assert.equal(rejected, "invalid match token");
    beta = await opened(`${wsBase}${assignments.beta.endpoint}?player=beta&token=${assignments.beta.token}`);
    await wait();
    assert.deepEqual(alpha.messages.map((message) => message.type), ["match_start", "round_start", "your_turn"]);
    assert.deepEqual(beta.messages.map((message) => message.type), ["match_start", "round_start"]);

    const busy = await createMatch(baseUrl, { matchId: "table-2", players: ["alpha", "gamma"] });
    assert.equal(busy.status, 409);
    const removed = await fetch(`${baseUrl}/api/matches/table-1`, { method: "DELETE", headers: { authorization: "Bearer admin-secret" } });
    assert.equal(removed.status, 204);
    await wait();
    assert.ok(registrations.slice(0, 2).every((socket) => socket.messages.some((message) => message.type === "assignment_released")));
    for (const socket of registrations.slice(0, 2)) {
      socket.send(JSON.stringify({ type: "assignment_complete", match_id: "table-1" }));
    }
    await wait();
    const listed = await (await fetch(`${baseUrl}/api/agents`)).json();
    assert.ok(listed.agents.every((agent) => agent.status === "available"));
  } finally {
    alpha?.close(); beta?.close();
    for (const socket of registrations) socket.close();
    await lobby.stop();
  }
});

test("matches on one listener keep assigned coordinator state isolated", async () => {
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const registrations = await Promise.all(["a", "b", "c", "d"].map((id) => registered(wsBase, id)));
  const matchSockets = [];
  try {
    await createMatch(baseUrl, { matchId: "first", players: ["a", "b"], seed: 2 });
    await createMatch(baseUrl, { matchId: "second", players: ["c", "d"], seed: 9 });
    await wait();
    for (const registration of registrations) {
      const assignment = registration.messages.find((message) => message.type === "match_assignment");
      matchSockets.push(await opened(`${wsBase}${assignment.endpoint}?player=${assignment.player}&token=${assignment.token}`));
    }
    await wait();
    matchSockets[0].send(JSON.stringify({ match_id: "first", your_turn_seq: 0,
      move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
    await wait();
    assert.deepEqual(lobby.getMatch("first").match.snapshot().bid, { quantity: 1, face: 2 });
    assert.equal(lobby.getMatch("second").match.snapshot().bid, null);
  } finally {
    for (const socket of [...matchSockets, ...registrations]) socket.close();
    await lobby.stop();
  }
});

test("registration loss keeps assignment expiry and release recovery intact", async () => {
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret",
    assignmentTimeoutMs: 40 });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const alpha = await registered(wsBase, "alpha");
  const beta = await registered(wsBase, "beta");
  try {
    await createMatch(baseUrl, { matchId: "expires", players: ["alpha", "beta"] });
    await wait();
    alpha.close();
    await wait(70);
    assert.equal(lobby.getMatch("expires"), undefined);
    const release = beta.messages.find((message) => message.type === "assignment_released");
    assert.equal(release.match_id, "expires");
    beta.send(JSON.stringify({ type: "assignment_complete", match_id: "expires" }));
    await wait();
    assert.equal(lobby.registrations.get("beta").status, "available");

    const reconnected = await registered(wsBase, "alpha", { activeMatchId: "expires" });
    await wait();
    assert.ok(reconnected.messages.some((message) => message.type === "assignment_released" && message.match_id === "expires"));
    reconnected.send(JSON.stringify({ type: "assignment_complete", match_id: "expires" }));
    await wait();
    assert.equal(lobby.registrations.get("alpha").status, "available");
    reconnected.close();
  } finally {
    alpha.close(); beta.close();
    await lobby.stop();
  }
});
