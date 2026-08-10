import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReplay, ReplayFormatError, ReplayStream } from "../src/replay.js";
import { WebSocket } from "ws";
import { createRefereeServer } from "../src/server.js";

const state = { phase: "bidding", players: [] };
const record = (seq, type = "bid", extra = {}) => ({ seq, type, state, ...extra });

test("replay parser skips malformed lines and reports their line numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "liars-replay-"));
  const path = join(dir, "match.jsonl");
  await writeFile(path, `${JSON.stringify(record(0, "match_started"))}\nnot json\n${JSON.stringify(record(1))}\n`);
  const malformed = [];
  assert.deepEqual((await readReplay(path, { onMalformed: (error) => malformed.push(error) })).map(({ seq }) => seq), [0, 1]);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].message, /line 2/);
  await assert.rejects(readReplay(path, { strict: true }), ReplayFormatError);
  await rm(dir, { recursive: true });
});

test("replay records must have strictly increasing sequence numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "liars-replay-order-"));
  const path = join(dir, "match.jsonl");
  await writeFile(path, `${JSON.stringify(record(1))}\n${JSON.stringify(record(1))}\n`);
  await assert.rejects(readReplay(path, { strict: true }), /strictly increasing/);
  await rm(dir, { recursive: true });
  const stream = new ReplayStream([record(0), record(1)] , { speed: 0 });
  const seen = [];
  await stream.run((event) => seen.push(event.seq));
  assert.deepEqual(seen, [0, 1]);
});

test("pause-safe replay timing does not consume delay while paused", async () => {
  const stream = new ReplayStream([record(0, "a", { timestamp: 0 }), record(1, "b", { timestamp: 40 })], { speed: 1 });
  const seen = [];
  const running = stream.run((event) => { seen.push(event.type); });
  await new Promise((resolve) => setTimeout(resolve, 8));
  stream.pause();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(seen, ["a"]);
  stream.resume();
  await running;
  assert.deepEqual(seen, ["a", "b"]);
});

test("replay spectator receives a snapshot and spectator-compatible public events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "liars-replay-ws-"));
  const path = join(dir, "match.jsonl");
  await writeFile(path, `${JSON.stringify(record(0, "match_started", { private: { a: { dice: [1] } } }))}\n${JSON.stringify(record(1, "bid", { actor: "a", move: { bid: { quantity: 1, face: 2 } }, private: { a: { dice: [1] } } }))}\n`);
  const referee = createRefereeServer({ matchId: "replay", matchToken: "secret", players: ["a", "b"], replayPath: path, replaySpeed: 0 });
  const address = await referee.start();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/spectate/replay`);
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messages[0].type, "snapshot");
  assert.equal(messages[0].replay, true);
  assert.equal(messages[1].type, "match_started");
  assert.equal(messages[1].private, undefined);
  assert.equal(messages[2].type, "bid");
  assert.deepEqual(messages[2].move.bid, { quantity: 1, face: 2 });
  socket.close(); await referee.stop(); await rm(dir, { recursive: true });
});
