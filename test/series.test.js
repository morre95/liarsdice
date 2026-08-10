import assert from "node:assert/strict";
import test from "node:test";
import { HeuristicAgent } from "../src/heuristic-agent.js";
import { runMatch, runSeries } from "../src/series.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("heuristic agents complete a headless match with accounting", () => {
  const result = runMatch({ agents: [new HeuristicAgent({ id: "a" }), new HeuristicAgent({ id: "b" })], seed: 17, dicePerPlayer: 2 });
  assert.equal(result.phase, "finished");
  assert.deepEqual(Object.keys(result.tokenUsage).sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(result.illegalCounts).sort(), ["a", "b"]);
  assert.deepEqual(result.illegalCounts, { a: 0, b: 0 });
});

test("heuristic challenges a bid below its expected threshold", () => {
  const agent = new HeuristicAgent({ id: "a", expectedThreshold: 4 });
  const move = agent.chooseMove({
    state: { bid: { quantity: 1, face: 2 }, turn: 0, players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }] },
    dice: [2, 3],
  });
  assert.equal(move.action, "challenge");
});

test("same seed and moves produce byte-equivalent match records", () => {
  const make = () => runMatch({ agents: [new HeuristicAgent({ id: "a" }), new HeuristicAgent({ id: "b" })], seed: 23, dicePerPlayer: 2 });
  assert.equal(JSON.stringify(make()), JSON.stringify(make()));
});

test("series alternates seats, reuses seeds, and updates ratings", () => {
  const series = runSeries({ agents: [new HeuristicAgent({ id: "a" }), new HeuristicAgent({ id: "b" })], seeds: [4], matches: 2, dicePerPlayer: 1 });
  assert.deepEqual(series.results.map((result) => result.players), [["a", "b"], ["b", "a"]]);
  assert.deepEqual(series.results.map((result) => result.seed), [4, 4]);
  assert.notDeepEqual(series.leaderboard, { a: 1500, b: 1500 });
});

test("identical seeded series runs write byte-identical, independently scoped match logs", () => {
  const makeAgents = () => [new HeuristicAgent({ id: "a" }), new HeuristicAgent({ id: "b" })];
  const firstDir = mkdtempSync(join(tmpdir(), "liars-dice-logs-"));
  const secondDir = mkdtempSync(join(tmpdir(), "liars-dice-logs-"));
  try {
    runSeries({ agents: makeAgents(), seeds: [23], matches: 2, dicePerPlayer: 2, logDir: firstDir });
    runSeries({ agents: makeAgents(), seeds: [23], matches: 2, dicePerPlayer: 2, logDir: secondDir });
    for (const id of ["1", "2"]) {
      const first = readFileSync(join(firstDir, `${id}.jsonl`), "utf8");
      const second = readFileSync(join(secondDir, `${id}.jsonl`), "utf8");
      assert.equal(first, second);
      const events = first.trim().split("\n").map(JSON.parse);
      assert.equal(events[0].type, "match_started");
      assert.equal(events[0].match_id, id);
      assert.deepEqual(events.map((event) => event.match_id), Array(events.length).fill(id));
      assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
      assert.ok(events[0].setup.seed === 23 && events[0].private.a.dice.length === 2);
    }
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});
