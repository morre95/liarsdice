import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createRefereeServer } from "../src/server.js";

function opened(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket._messages = [];
    socket.on("message", (data) => socket._messages.push(JSON.parse(data.toString())));
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function messages(socket) {
  return socket._messages;
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("agents authenticate and never receive the other agent's dice", async () => {
  const referee = createRefereeServer({ matchId: "privacy", matchToken: "secret", players: ["a", "b"], seed: 4 });
  const address = await referee.start();
  const a = await opened(`ws://127.0.0.1:${address.port}/agent?player=a&token=secret`);
  const b = await opened(`ws://127.0.0.1:${address.port}/agent?player=b&token=secret`);
  const am = messages(a); const bm = messages(b);
  await wait();
  assert.equal(am[0].type, "match_start");
  assert.equal(am[1].type, "round_start");
  assert.ok(Array.isArray(am[1].dice));
  assert.equal(am[1].state, undefined);
  assert.equal(am[0].match_id, "privacy");
  assert.deepEqual(am[0].rules, { dice_per_player: 5, wild_ones: true,
    exact_call: false, palifico: false, spot_on_reward: false });
  assert.equal(am[0].seat, 0);
  assert.equal(am[2].type, "your_turn");
  assert.equal(am[2].your_turn_seq, 0);
  assert.equal(bm.length, 2);
  a.close(); b.close(); await referee.stop();
});

test("spectators receive a late public snapshot and ignored inbound messages are logged", async () => {
  const referee = createRefereeServer({ matchId: "late", matchToken: "secret", players: ["a", "b"], seed: 8 });
  const address = await referee.start();
  const a = await opened(`ws://127.0.0.1:${address.port}/agent?player=a&token=secret`);
  const am = messages(a); await wait();
  a.send(JSON.stringify({ match_id: "late", your_turn_seq: 0, tokens: 3,
    move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
  await wait();
  assert.ok(am.some((message) => message.type === "state_update" && message.match_id === "late"));
  assert.ok(am.some((message) => message.type === "your_turn" && message.total_dice === 10));
  const spectator = await opened(`ws://127.0.0.1:${address.port}/spectate/late`);
  const sm = messages(spectator); await wait();
  assert.equal(sm[0].type, "snapshot");
  assert.equal(sm[0].state.bid.quantity, 1);
  assert.deepEqual(sm[0].history, [{ quantity: 1, face: 2, actor: "a" }]);
  assert.equal(sm[0].state.players[0].dice, undefined);
  spectator.send("hello"); await wait();
  assert.ok(sm.some((message) => message.type === "spectator_message_ignored"));
  a.close(); spectator.close(); await referee.stop();
});

test("round_end reveals cups only to omniscient spectators and never to the other agent", async () => {
  const referee = createRefereeServer({ matchId: "round-end", matchToken: "secret", players: ["a", "b"], seed: 4,
    omniscientSpectators: true });
  const address = await referee.start();
  const a = await opened(`ws://127.0.0.1:${address.port}/agent?player=a&token=secret`);
  const b = await opened(`ws://127.0.0.1:${address.port}/agent?player=b&token=secret`);
  const spectator = await opened(`ws://127.0.0.1:${address.port}/spectate/round-end`);
  await wait();
  a.send(JSON.stringify({ match_id: "round-end", your_turn_seq: 0,
    move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
  await wait();
  b.send(JSON.stringify({ match_id: "round-end", your_turn_seq: 1, move: { action: "challenge", turn: 1 } }));
  await wait();
  const end = messages(spectator).find((message) => message.type === "round_end");
  assert.deepEqual(Object.keys(end.round_end.cups).sort(), ["a", "b"]);
  assert.equal(end.round_end.matching.total, end.round_end.matching.face_matches + end.round_end.matching.wilds);
  const ownEnd = messages(a).find((message) => message.type === "state_update" && message.event === "round_end");
  assert.deepEqual(Object.keys(ownEnd.round_end.cups), ["a"]);
  const otherEnd = messages(b).find((message) => message.type === "state_update" && message.event === "round_end");
  assert.deepEqual(Object.keys(otherEnd.round_end.cups), ["b"]);
  assert.ok(messages(b).some((message) => message.type === "round_start" && message.round === 2));
  a.close(); b.close(); spectator.close(); await referee.stop();
});

test("a terminal challenge emits one match_end to each channel and the event log", async () => {
  const directory = mkdtempSync(join(tmpdir(), "liars-dice-terminal-"));
  const eventLogPath = join(directory, "events.jsonl");
  const referee = createRefereeServer({ matchId: "terminal", matchToken: "secret", players: ["a", "b"],
    dicePerPlayer: 1, seed: 4, eventLogPath });
  const address = await referee.start();
  const a = await opened(`ws://127.0.0.1:${address.port}/agent?player=a&token=secret`);
  const b = await opened(`ws://127.0.0.1:${address.port}/agent?player=b&token=secret`);
  const spectator = await opened(`ws://127.0.0.1:${address.port}/spectate/terminal`);
  try {
    await wait();
    a.send(JSON.stringify({ match_id: "terminal", your_turn_seq: 0,
      move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 } } }));
    await wait();
    b.send(JSON.stringify({ match_id: "terminal", your_turn_seq: 1,
      move: { action: "challenge", turn: 1 } }));
    await wait();

    for (const socket of [a, b, spectator]) {
      const terminal = messages(socket).filter((message) => message.type === "match_end");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].winner, "a");
      assert.deepEqual(terminal[0].final_counts, { a: 1, b: 0 });
      assert.deepEqual(terminal[0].illegal_counts, { a: 0, b: 0 });
      assert.deepEqual(terminal[0].token_usage, { a: 0, b: 0 });
    }
    const records = readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
    const terminalRecords = records.filter((record) => record.type === "match_end");
    assert.equal(terminalRecords.length, 1);
    assert.equal(terminalRecords[0].winner, "a");
    assert.deepEqual(terminalRecords[0].final_counts, { a: 1, b: 0 });
    assert.deepEqual(terminalRecords[0].illegal_counts, { a: 0, b: 0 });
    assert.deepEqual(terminalRecords[0].token_usage, { a: 0, b: 0 });
  } finally {
    await Promise.all([a, b, spectator].map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once("close", resolve);
      socket.close();
    })));
    await referee.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid agent tokens are rejected", async () => {
  const referee = createRefereeServer({ matchId: "auth", matchToken: "secret", players: ["a", "b"] });
  const address = await referee.start();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent?player=a&token=nope`);
  const close = await new Promise((resolve) => socket.once("close", (_code, reason) => resolve(reason.toString())));
  assert.equal(close, "invalid match token");
  await referee.stop();
});

test("agent moves require the match and your-turn sequence, with structured rejection", async () => {
  const referee = createRefereeServer({ matchId: "envelope", matchToken: "secret", players: ["a", "b"] });
  const address = await referee.start();
  const a = await opened(`ws://127.0.0.1:${address.port}/agent?player=a&token=secret`);
  await wait();
  a.send(JSON.stringify({ turn: 0, action: "bid", bid: { quantity: 1, face: 2 } }));
  await wait();
  const rejection = messages(a).at(-1);
  assert.equal(rejection.type, "move_rejected");
  assert.equal(rejection.reason, "shape");
  assert.equal(typeof rejection.explanation, "string");
  assert.equal(rejection.match_id, "envelope");
  a.close(); await referee.stop();
});
