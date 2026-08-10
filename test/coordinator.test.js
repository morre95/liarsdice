import assert from "node:assert/strict";
import test from "node:test";
import { MatchCoordinator, MoveValidationError, JsonlEventLog, parseMove } from "../src/coordinator.js";
import { readFileSync, rmSync } from "node:fs";

const bid = (turn, quantity, face) => ({ turn, action: "bid", bid: { quantity, face } });
const challenge = (turn) => ({ turn, action: "challenge" });

test("parses valid bid and challenge moves and rejects extra or malformed fields", () => {
  assert.deepEqual(parseMove(JSON.stringify(bid(0, 1, 2))), bid(0, 1, 2));
  assert.deepEqual(parseMove(challenge(1)), challenge(1));
  for (const move of [
    { ...bid(0, 1, 2), extra: true }, {}, null, [],
    { turn: 0, action: "bid", bid: { quantity: 1, face: 2, note: "x" } },
    { turn: 0, action: "bid", bid: { quantity: "1", face: 2 } },
    { turn: 0, action: "challenge", bid: null },
    { turn: 0, action: "other" },
  ]) assert.throws(() => parseMove(move), MoveValidationError);
  assert.throws(() => parseMove("{"), /valid JSON/);
  assert.throws(() => parseMove("x".repeat(100), 10), /too large/);
});

test("accepts only optional table talk and reasoning fields", () => {
  const move = { ...bid(0, 1, 2), table_talk: "raise", reasoning: "the odds are favorable" };
  assert.deepEqual(parseMove(move), move);
  for (const field of ["table_talk", "reasoning"]) {
    assert.throws(() => parseMove({ ...bid(0, 1, 2), [field]: 42 }), MoveValidationError);
  }
  assert.throws(() => parseMove({ ...bid(0, 1, 2), metadata: true }), MoveValidationError);
  assert.throws(() => parseMove({ ...bid(0, 1, 2), table_talk: "x".repeat(100) }, 50), /too large/);
});

test("truncates table talk and keeps reasoning private in logged events", () => {
  const events = [];
  const match = new MatchCoordinator({ players: ["a", "b"], maxTableTalkLength: 4,
    eventLog: (event) => events.push(event), seed: 3 });
  const event = match.submit("a", { ...bid(0, 1, 2), table_talk: "abcdef", reasoning: "secret" });
  assert.equal(event.move.table_talk, "abcd");
  assert.equal(event.private.a.reasoning, "secret");
  assert.equal(event.private.b.reasoning, undefined);
  assert.equal(events[1].move.table_talk, "abcd");
  assert.equal(events[1].private.a.reasoning, "secret");
  assert.equal(events[1].state.tokenUsage.a, 0);
});

test("valid moves advance the sequence, reject stale moves, and preserve dice privacy", () => {
  const events = [];
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 2, seed: 4, eventLog: (event) => events.push(event) });
  const ownDice = match.privateSnapshot("a");
  const first = match.submit("a", bid(0, 1, 2));
  assert.equal(first.type, "bid");
  assert.equal(first.state.players[0].dice, undefined);
  assert.deepEqual(first.private.a.dice, ownDice);
  assert.equal(match.submit("b", bid(0, 2, 2)).reason, "stale_turn");
  assert.equal(match.submit("b", challenge(1)).type, "challenge");
  assert.equal(events[0].type, "match_started");
  assert.ok(events.every((event) => !JSON.stringify(event.state).includes('"dice"')));
});

test("coordinator threads exact-call variants and keeps the standard default", () => {
  const standard = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 2, rng: () => (2 - 0.5) / 6 });
  standard.submit("a", bid(0, 4, 2));
  assert.equal(standard.submit("b", { turn: 1, action: "exact" }).reason, "exact calls are disabled");

  const events = [];
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 2, exactCall: true,
    spotOnReward: true, rng: () => (2 - 0.5) / 6, eventLog: (event) => events.push(event) });
  match.submit("a", bid(0, 4, 2));
  const event = match.submit("b", { turn: 1, action: "exact" });
  assert.equal(event.type, "exact");
  assert.equal(events.find((entry) => entry.type === "round_end").round_end.reward, true);
  assert.deepEqual(Object.fromEntries(match.snapshot().players.map((p) => [p.id, p.diceCount])), { a: 1, b: 3 });
});

test("coordinator enforces enabled palifico bid restriction", () => {
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 1, palifico: true, rng: () => 5 / 6 });
  match.submit("a", bid(0, 1, 2));
  assert.equal(match.submit("b", bid(1, 1, 3)).reason, "palifico bids must use the opening face");
});

test("challenge emits a pre-roll round_end with exact matching arithmetic", () => {
  const events = [];
  const rolls = [1, 2, 4, 1];
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 2,
    rng: () => (rolls.shift() - 0.5) / 6, eventLog: (event) => events.push(event) });
  const cups = { a: [1, 2], b: [4, 1] };
  match.submit("a", bid(0, 2, 2));
  match.submit("b", challenge(1));
  const end = events.find((event) => event.type === "round_end");
  assert.deepEqual(end.round_end.cups, cups);
  assert.deepEqual(end.round_end.matching, { face_matches: 1, wilds: 2, total: 3 });
  assert.equal(end.round_end.truth, true);
  assert.equal(end.round_end.loser, "b");
  assert.deepEqual(end.private.a.dice, cups.a);
  assert.deepEqual(end.private.b.dice, cups.b);
  assert.equal(end.state.players[0].dice, undefined);
  assert.equal(events[events.indexOf(end) - 1].type, "challenge");
  assert.notDeepEqual(match.privateSnapshot("a"), cups.a);
});

test("illegal moves retry then penalise and forfeit on the third penalty", () => {
  const match = new MatchCoordinator({ players: ["a", "b"], illegalRetries: 1, maxPenalties: 3, seed: 1 });
  for (let penalty = 1; penalty <= 3; penalty += 1) {
    assert.equal(match.submit("a", { turn: 0, action: "bid", bid: { quantity: 99, face: 2 } }).type, "illegal_move");
    const event = match.submit("a", { turn: 0, action: "bid", bid: { quantity: 99, face: 2 } });
    assert.equal(event.type, penalty === 3 ? "forfeit" : "penalty");
  }
  assert.equal(match.snapshot().phase, "finished");
  assert.equal(match.penalties.a, 3);
});

test("opening challenge, wrong actor, deadlines, token budget, and disconnect grace are policy events", () => {
  let clock = 0;
  const match = new MatchCoordinator({ players: ["a", "b"], seed: 2, now: () => clock,
    turnDeadlineMs: 10, disconnectGraceMs: 5, tokenBudget: 1 });
  assert.equal(match.submit("b", challenge(0)).reason, "not_your_turn");
  assert.equal(match.submit("a", challenge(0)).reason, "there is no bid to challenge");
  assert.equal(match.submit("a", bid(0, 1, 2), { tokens: 2 }).reason, "token_budget");
  clock = 11; assert.equal(match.checkDeadline().type, "penalty");
  match.disconnect("a"); clock = 15; assert.equal(match.checkDisconnects(), null);
  clock = 22; assert.equal(match.checkDisconnects().type, "penalty");
});

test("token budgets are cumulative independently for each agent", () => {
  const match = new MatchCoordinator({ players: ["a", "b"], tokenBudget: 3, seed: 7 });
  assert.equal(match.submit("a", bid(0, 1, 2), { tokens: 2 }).type, "bid");
  assert.equal(match.submit("b", bid(1, 1, 3), { tokens: 2 }).type, "bid");
  assert.deepEqual(match.snapshot().tokenUsage, { a: 2, b: 2 });
  assert.equal(match.submit("a", bid(2, 2, 3), { tokens: 2 }).reason, "token_budget");
});

test("repeated deadline and disconnect checks do not double-penalize", () => {
  let clock = 0;
  const match = new MatchCoordinator({ players: ["a", "b"], turnDeadlineMs: 10, disconnectGraceMs: 5,
    now: () => clock, seed: 8 });
  clock = 10;
  assert.equal(match.checkDeadline().type, "penalty");
  assert.equal(match.checkDeadline(), null);
  assert.equal(match.penalties.a, 1);
  match.disconnect("a", clock);
  clock = 15;
  assert.equal(match.checkDisconnects().type, "penalty");
  assert.equal(match.checkDisconnects(), null);
  assert.equal(match.penalties.a, 2);
});

test("penalties remove one die, reroll the next round, and start with the penalized player", () => {
  let clock = 0;
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 2, illegalRetries: 0,
    penaltyStarter: "penalized", now: () => clock, seed: 8 });
  const before = match.privateSnapshot("a");
  const event = match.submit("a", bid(0, 99, 2));
  assert.equal(event.type, "penalty");
  assert.equal(event.consequence.die_lost, 1);
  assert.equal(event.consequence.next_starter, "a");
  assert.equal(match.snapshot().round, 2);
  assert.equal(match.snapshot().players.find((p) => p.id === "a").diceCount, 1);
  assert.equal(match.privateSnapshot("a").length, 1);
  assert.notDeepEqual(match.privateSnapshot("a"), before);
});

test("third penalty forfeits with opponent winner and final accounting", () => {
  const events = [];
  const match = new MatchCoordinator({ players: ["a", "b"], illegalRetries: 0, maxPenalties: 3,
    eventLog: (event) => events.push(event), seed: 12 });
  for (let i = 0; i < 3; i += 1) match.submit("a", { turn: match.turnSeq, action: "bid", bid: { quantity: 99, face: 2 } });
  const event = events.at(-1);
  assert.equal(event.type, "forfeit");
  assert.equal(event.consequence.winner, "b");
  assert.equal(event.final.winner, "b");
  assert.deepEqual(event.final.penalties, { a: 3, b: 0 });
  assert.equal(match.snapshot().phase, "finished");
});

test("a penalty that removes the last die eliminates the offender and names the survivor", () => {
  const match = new MatchCoordinator({ players: ["a", "b"], dicePerPlayer: 1, illegalRetries: 0, seed: 13 });
  const event = match.submit("a", { turn: 0, action: "bid", bid: { quantity: 99, face: 2 } });
  assert.equal(event.type, "penalty");
  assert.equal(event.consequence.winner, "b");
  assert.equal(match.snapshot().phase, "finished");
  assert.deepEqual(match.snapshot().players.map((player) => player.id), ["b"]);
});

test("disconnect expiry follows penalty path and does not leave the match blocked", () => {
  let clock = 0;
  const match = new MatchCoordinator({ players: ["a", "b"], disconnectGraceMs: 5, now: () => clock, seed: 14 });
  match.disconnect("a", 0);
  clock = 5;
  const event = match.checkDisconnects();
  assert.equal(event.type, "penalty");
  assert.equal(match.snapshot().phase, "bidding");
  assert.equal(match.snapshot().players[match.snapshot().turn].id, "a");
  assert.equal(match.checkDisconnects(), null);
});

test("event logs are append-only, JSONL, and deterministic with a deterministic clock", () => {
  const path = "/tmp/liars-dice-coordinator-test.jsonl";
  rmSync(path, { force: true });
  const make = (eventLog) => new MatchCoordinator({ players: ["a", "b"], seed: 99, now: () => 0, eventLog });
  const firstEvents = []; const first = make((event) => firstEvents.push(event));
  first.submit("a", bid(0, 1, 2)); first.submit("b", challenge(1));
  const secondEvents = []; const second = make((event) => secondEvents.push(event));
  second.submit("a", bid(0, 1, 2)); second.submit("b", challenge(1));
  assert.deepEqual(firstEvents, secondEvents);
  const fileMatch = make(new JsonlEventLog(path)); fileMatch.submit("a", bid(0, 1, 2));
  const lines = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2); assert.deepEqual(lines.map((line) => line.type), ["match_started", "bid"]);
  assert.equal(lines[0].state.players[0].diceCount, 5);
  rmSync(path, { force: true });
});

test("the first event scopes the match and includes reconstructable setup and private dice", () => {
  const events = [];
  const match = new MatchCoordinator({ matchId: "rebuild-1", players: ["a", "b"], dicePerPlayer: 2,
    seed: 42, exactCall: true, palifico: true, spotOnReward: true, eventLog: (event) => events.push(event) });
  assert.equal(events[0].match_id, "rebuild-1");
  assert.deepEqual(events[0].setup, { match_id: "rebuild-1", seed: 42,
    seats: [{ seat: 0, id: "a" }, { seat: 1, id: "b" }], dice_per_player: 2,
    rules: { exactCall: true, palifico: true, spotOnReward: true } });
  assert.deepEqual(Object.keys(events[0].private).sort(), ["a", "b"]);
  assert.equal(events[0].private.a.dice.length, 2);
  assert.deepEqual(events.map((event) => event.seq), [0]);
});
