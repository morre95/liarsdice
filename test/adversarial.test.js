import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createRefereeServer } from "../src/server.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.messages = [];
    socket.on("message", (data) => {
      try { socket.messages.push(JSON.parse(data.toString())); } catch { /* test clients ignore non-JSON */ }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
}

async function live(options = {}) {
  const referee = createRefereeServer({
    matchId: "adversarial",
    matchToken: "secret",
    players: ["a", "b"],
    ...options,
  });
  const address = await referee.start();
  const sockets = [];
  const agent = async (player) => {
    const socket = await connect(`ws://127.0.0.1:${address.port}/agent?player=${player}&token=secret`);
    sockets.push(socket);
    return socket;
  };
  return { referee, agent, sockets, async close() {
    await Promise.all(sockets.map(closeSocket));
    await referee.stop();
  } };
}

function move(turn, action = "bid", bid = { quantity: 1, face: 2 }, matchId = "adversarial") {
  return JSON.stringify({ match_id: matchId, your_turn_seq: turn, move: { action, turn, ...(action === "bid" ? { bid } : {}) } });
}

async function eventually(socket, predicate, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = socket.messages.find(predicate);
    if (found) return found;
    await wait(10);
  }
  assert.fail(`timed out waiting for message; received ${socket.messages.map((m) => m.type).join(",")}`);
}

test("Appendix D malformed and illegal live messages are rejected without crashing", async () => {
  const app = await live({ illegalRetries: 1, maxPenalties: 3, maxMoveBytes: 1024 });
  try {
    const a = await app.agent("a");
    await wait(10);
    for (const payload of [
      move(0, "challenge"),
      "not json",
      JSON.stringify({ match_id: "adversarial", your_turn_seq: 0, move: { action: "wat", turn: 0 } }),
      JSON.stringify({ match_id: "adversarial", your_turn_seq: 0, move: { action: "bid", turn: 0 } }),
      JSON.stringify({ match_id: "adversarial", your_turn_seq: 0, move: { action: "bid", turn: 0, bid: { quantity: 1, face: 2 }, extra: true } }),
      JSON.stringify({ match_id: "adversarial", your_turn_seq: 0, action: "bid", bid: { quantity: 1, face: 2 }, extra: true }),
      move(0, "bid", { quantity: 11, face: 2 }),
      move(0, "challenge"),
      "{" + "x".repeat(10 * 1024 * 1024) + "}",
    ]) a.send(payload);
    const rejection = await eventually(a, (message) => message.type === "move_rejected");
    assert.equal(rejection.match_id, "adversarial");
    assert.ok(["malformed", "shape", "oversized", "illegal_bid", "no_bid"].includes(rejection.reason));
    assert.ok(a.messages.some((message) => message.type === "move_rejected" && message.reason === "no_bid"));
    assert.ok(a.messages.some((message) => message.event === "penalty"));
    assert.ok(a.messages.some((message) => message.event === "forfeit"));
    assert.ok(a.messages.some((message) => message.type === "match_end"));
    assert.equal(app.referee.server.listening, true);
    assert.ok(app.referee.match.illegalCounts.a > 0);
    assert.equal(app.referee.match.penalties.a, 3);
  } finally {
    await app.close();
  }
});

test("Appendix D stale turns and deadline forfeits terminate cleanly", async () => {
  const app = await live({ illegalRetries: 1, maxPenalties: 3, turnDeadlineMs: 40 });
  try {
    const a = await app.agent("a");
    const b = await app.agent("b");
    await wait(10);
    a.send(move(99));
    await eventually(a, (message) => message.type === "move_rejected" && message.reason === "stale_turn");
    assert.equal(app.referee.match.illegalCounts.a, 1);
    await closeSocket(a);
    await closeSocket(b);
  } finally {
    await app.close();
  }

  const deadline = await live({ illegalRetries: 0, maxPenalties: 1, turnDeadlineMs: 35 });
  try {
    const a = await deadline.agent("a");
    await eventually(a, (message) => message.type === "match_end", 1000);
    assert.equal(deadline.referee.match.snapshot().phase, "finished");
  } finally {
    await deadline.close();
  }

  const disconnected = await live({ illegalRetries: 0, maxPenalties: 1, disconnectGraceMs: 35 });
  try {
    const a = await disconnected.agent("a");
    await closeSocket(a);
    await wait(100);
    assert.equal(disconnected.referee.match.snapshot().phase, "finished");
    assert.equal(disconnected.referee.match.illegalCounts.a, 0);
    assert.equal(disconnected.referee.match.penalties.a, 1);
  } finally {
    await disconnected.close();
  }
});

test("Appendix D concurrent matches do not share state", async () => {
  const first = await live({ matchId: "first" });
  const second = createRefereeServer({ matchId: "second", matchToken: "secret", players: ["a", "b"], seed: 99 });
  const secondAddress = await second.start();
  const sockets = [];
  try {
    const a = await first.agent("a");
    const b = await connect(`ws://127.0.0.1:${secondAddress.port}/agent?player=a&token=secret`);
    sockets.push(b);
    a.send(move(0, "bid", { quantity: 1, face: 2 }, "first"));
    await eventually(a, (message) => message.type === "state_update" && message.event === "bid");
    await wait(20);
    assert.equal(first.referee.match.snapshot().bid.quantity, 1);
    assert.equal(second.match.snapshot().bid, null);
    assert.equal(first.referee.server.listening, true);
    assert.equal(second.server.listening, true);
  } finally {
    await first.close();
    await Promise.all(sockets.map(closeSocket));
    await second.stop();
  }
});
