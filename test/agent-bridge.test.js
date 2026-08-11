import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AsyncAgentBridge } from "../src/agent-bridge.js";

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;

  constructor(url, protocols, options) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.emit("open"); });
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close(code, reason) {
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  receive(message) { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

function setupMessages(socket, round = 1) {
  socket.receive({ type: "match_start", match_id: "bridge", rules: { wild_ones: true },
    state: { round, turn: 0, phase: "bidding", players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }] } });
  socket.receive({ type: "round_start", match_id: "bridge", round, dice: [2, 6] });
}

test("async bridge uses the wire sequence and canonical move envelope", async () => {
  let context;
  const bridge = new AsyncAgentBridge({
    url: "http://localhost:8080",
    player: "a",
    token: "secret",
    WebSocketImpl: FakeWebSocket,
    agent: async (value) => {
      context = value;
      return { move: { action: "bid", turn: 99, bid: { quantity: 1, face: 2 } }, tokens: 7 };
    },
  });
  await bridge.start();
  setupMessages(bridge.socket);
  bridge.socket.receive({ type: "your_turn", match_id: "bridge", your_turn_seq: 4,
    state: { round: 1, turn: 0, phase: "bidding", players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }] } });
  await wait();

  assert.equal(new URL(bridge.socket.url).pathname, "/agent");
  assert.equal(context.state.turn, 0);
  assert.equal(context.state.turn_seq, 4);
  assert.deepEqual(context.dice, [2, 6]);
  assert.deepEqual(bridge.socket.sent, [{ match_id: "bridge", your_turn_seq: 4, tokens: 7,
    move: { action: "bid", turn: 4, bid: { quantity: 1, face: 2 } } }]);
  await bridge.close();
});

test("async bridge can keep credentials out of the match URL", async () => {
  const bridge = new AsyncAgentBridge({
    url: "wss://dice.example/agent/private", player: "a", token: "seat-secret", tokenInUrl: false,
    WebSocketImpl: FakeWebSocket, agent: () => ({ action: "challenge", turn: 0 }),
  });
  await bridge.start();
  assert.equal(new URL(bridge.socket.url).searchParams.get("token"), null);
  assert.equal(new URL(bridge.socket.url).searchParams.get("player"), "a");
  assert.equal(bridge.socket.options.headers.authorization, "Bearer seat-secret");
  await bridge.close();
});

test("async bridge deduplicates in-flight turns and permits protocol retries", async () => {
  let resolveFirst;
  let calls = 0;
  const bridge = new AsyncAgentBridge({
    url: "ws://localhost:8080/agent", player: "a", token: "secret", WebSocketImpl: FakeWebSocket,
    agent: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { action: "challenge", turn: 0 };
    },
  });
  await bridge.start();
  setupMessages(bridge.socket);
  const turn = { type: "your_turn", match_id: "bridge", your_turn_seq: 2, illegal_retry_count: 0,
    state: { round: 1, turn: 0, phase: "bidding", bid: { quantity: 1, face: 2 },
      players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }] } };
  bridge.socket.receive(turn);
  bridge.socket.receive(turn);
  await wait();
  assert.equal(calls, 1);

  resolveFirst({ action: "challenge", turn: 2 });
  await wait();
  assert.equal(bridge.socket.sent.length, 1);
  bridge.socket.receive({ ...turn, illegal_retry_count: 1 });
  await wait();
  assert.equal(calls, 2);
  assert.equal(bridge.socket.sent.length, 2);
  await bridge.close();
});

test("async bridge waits for private dice from the current round", async () => {
  const contexts = [];
  const bridge = new AsyncAgentBridge({
    url: "ws://localhost:8080/agent", player: "a", token: "secret", WebSocketImpl: FakeWebSocket,
    agent: (context) => { contexts.push(context); return { action: "bid", turn: 3, bid: { quantity: 1, face: 3 } }; },
  });
  await bridge.start();
  setupMessages(bridge.socket, 1);
  bridge.socket.receive({ type: "your_turn", match_id: "bridge", your_turn_seq: 3,
    state: { round: 2, turn: 0, phase: "bidding", players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }] } });
  await wait();
  assert.equal(contexts.length, 0);

  bridge.socket.receive({ type: "round_start", match_id: "bridge", round: 2, dice: [3, 3] });
  await wait();
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].dice, [3, 3]);
  await bridge.close();
});
