import assert from "node:assert/strict";
import test from "node:test";
import { DiceGame, RulesError, countMatchingDice, legalBid, seededRng, totalDice } from "../src/rules.js";

const bid = (quantity, face) => ({ quantity, face });

test("setup requires exactly two players and exposes a defensive snapshot", () => {
  assert.throws(() => new DiceGame({ players: ["a"] }), /exactly two players/);
  assert.throws(() => new DiceGame({ players: ["a", "b", "c"] }), /exactly two players/);
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 3, seed: 7 });
  const state = game.snapshot();
  assert.equal(totalDice(state.players), 6);
  assert.deepEqual(state.players.map((player) => player.dice.length), [3, 3]);
  state.players[0].dice[0] = 99;
  assert.notEqual(game.snapshot().players[0].dice[0], 99);
});

test("opening bids allow every face and enforce quantity bounds", () => {
  assert.equal(legalBid(null, bid(1, 1), 10), true);
  assert.equal(legalBid(null, bid(1, 2), 10), true);
  assert.equal(legalBid(null, bid(10, 6), 10), true);
  assert.equal(legalBid(null, bid(11, 2), 10), false);
  assert.equal(legalBid(null, bid(0, 2), 10), false);
  assert.equal(legalBid(null, bid(1, 7), 10), false);
  assert.equal(legalBid(null, bid(1.5, 2), 10), false);
});

test("normal raises require quantity or same-quantity face increase", () => {
  const previous = bid(3, 4);
  assert.equal(legalBid(previous, bid(3, 5), 12), true);
  assert.equal(legalBid(previous, bid(4, 2), 12), true);
  assert.equal(legalBid(previous, bid(3, 4), 12), false);
  assert.equal(legalBid(previous, bid(2, 6), 12), false);
  assert.equal(legalBid(previous, bid(3, 3), 12), false);
});

test("transitions to and from ones use half and double-plus-one boundaries", () => {
  assert.equal(legalBid(bid(5, 6), bid(3, 1), 20), true);
  assert.equal(legalBid(bid(5, 6), bid(2, 1), 20), false);
  assert.equal(legalBid(bid(4, 1), bid(9, 2), 20), true);
  assert.equal(legalBid(bid(4, 1), bid(8, 6), 20), false);
  assert.equal(legalBid(bid(1, 1), bid(3, 2), 20), true);
  assert.equal(legalBid(bid(1, 1), bid(2, 2), 20), false);
  assert.equal(legalBid(bid(4, 1), bid(5, 1), 20), true);
  assert.equal(legalBid(bid(4, 1), bid(4, 1), 20), false);
});

test("face-one transitions use the exact odd and even half boundaries", () => {
  assert.equal(legalBid(bid(5, 6), bid(3, 1), 20), true);
  assert.equal(legalBid(bid(5, 6), bid(2, 1), 20), false);
  assert.equal(legalBid(bid(6, 6), bid(3, 1), 20), true);
  assert.equal(legalBid(bid(6, 6), bid(2, 1), 20), false);
  assert.equal(legalBid(bid(3, 1), bid(7, 2), 20), true);
  assert.equal(legalBid(bid(3, 1), bid(6, 2), 20), false);
});

test("all bids stay within the current dice pool", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, seed: 1 });
  assert.throws(() => game.placeBid("a", bid(5, 2)), RulesError);
});

test("bid bounds shrink after a challenge removes a die", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, rng: () => 5 / 6 });
  game.placeBid("a", bid(1, 2));
  game.challenge("b");
  assert.equal(totalDice(game.snapshot().players), 3);
  assert.throws(() => game.placeBid("a", bid(4, 2)), RulesError);
});

test("wild ones count for non-one bids but not one bids, including exact counts", () => {
  assert.equal(countMatchingDice([1, 1, 2, 3, 6], 2), 3);
  assert.equal(countMatchingDice([1, 1, 2, 3, 6], 1), 2);
  assert.equal(countMatchingDice([1, 1, 2], 4), 2);
});

test("challenge makes the bidder lose when under, challenger when met or exceeded", () => {
  const rolls = [2, 2, 3, 1];
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, rng: () => (rolls.shift() - 0.5) / 6 });
  game.placeBid("a", bid(3, 2));
  const result = game.challenge("b");
  assert.equal(result.lastResult.count, 3);
  assert.equal(result.lastResult.loser, "b");
  assert.equal(result.players[result.turn].id, "b");
  assert.equal(result.round, 2);
  assert.equal(result.bid, null);
});

test("an unsuccessful challenge removes a die and starts the next round with the bidder", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, rng: () => 5 / 6 });
  game.placeBid("a", bid(1, 2));
  const result = game.challenge("b");
  assert.equal(result.lastResult.count, 0);
  assert.equal(result.lastResult.loser, "a");
  assert.equal(result.players.find((player) => player.id === "a").diceCount, 1);
  assert.equal(result.players[result.turn].id, "a");
  assert.equal(result.phase, "bidding");
});

test("the surviving player starts after an eliminated bidder", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 1, rng: () => 5 / 6 });
  game.placeBid("a", bid(1, 2));
  const result = game.challenge("b");
  assert.deepEqual(result.players.map((player) => player.id), ["b"]);
  assert.equal(result.turn, 0);
  assert.equal(result.players[result.turn].id, "b");
  assert.equal(result.phase, "finished");
});

test("challenge results are isolated in snapshots", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, rng: () => 5 / 6 });
  game.placeBid("a", bid(1, 2));
  const result = game.challenge("b");
  result.lastResult.bid.quantity = 99;
  assert.equal(game.snapshot().lastResult.bid.quantity, 1);
});

test("turns, illegal actor actions, and round state are enforced", () => {
  const game = new DiceGame({ players: ["a", "b"], seed: 3 });
  assert.throws(() => game.placeBid("b", bid(1, 2)), /not this player's turn/);
  game.placeBid("a", bid(1, 2));
  assert.throws(() => game.placeBid("a", bid(2, 2)), /not this player's turn/);
  assert.throws(() => game.challenge("a"), /not this player's turn/);
});

test("optional variants are disabled by default and exact calls resolve deterministically", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, rng: () => (2 - 0.5) / 6 });
  game.placeBid("a", bid(4, 2));
  assert.throws(() => game.exactCall("b"), /disabled/);
  assert.equal(game.snapshot().players[0].diceCount, 2);

  const exact = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2,
    exactCall: true, spotOnReward: true, rng: () => (2 - 0.5) / 6 });
  exact.placeBid("a", bid(4, 2));
  const result = exact.exactCall("b");
  assert.equal(result.lastResult.truth, true);
  assert.deepEqual(result.lastResult.losers, ["a"]);
  assert.equal(result.lastResult.reward, true);
  assert.deepEqual(Object.fromEntries(result.players.map((p) => [p.id, p.diceCount])), { a: 1, b: 3 });
});

test("incorrect exact calls penalize the caller and spot-on reward is opt-in", () => {
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 2, exactCall: true,
    rng: () => (3 - 0.5) / 6 });
  game.placeBid("a", bid(1, 2));
  const result = game.exactCall("b");
  assert.equal(result.lastResult.truth, false);
  assert.equal(result.lastResult.loser, "b");
  assert.deepEqual(Object.fromEntries(result.players.map((p) => [p.id, p.diceCount])), { a: 2, b: 1 });
});

test("palifico fixes the bid face only when enabled and the round starts at one die", () => {
  const standard = new DiceGame({ players: ["a", "b"], dicePerPlayer: 1, rng: () => 5 / 6 });
  standard.placeBid("a", bid(1, 2));
  assert.doesNotThrow(() => standard.placeBid("b", bid(1, 3)));

  const palifico = new DiceGame({ players: ["a", "b"], dicePerPlayer: 1, palifico: true, rng: () => 5 / 6 });
  palifico.placeBid("a", bid(1, 2));
  assert.throws(() => palifico.placeBid("b", bid(1, 3)), /palifico/);
  assert.doesNotThrow(() => palifico.placeBid("b", bid(2, 2)));
});

test("seeded rolls are deterministic and bounded", () => {
  const rng = seededRng(99);
  const one = Array.from({ length: 20 }, () => 1 + Math.floor(rng() * 6));
  const rngA = seededRng(99);
  const rngB = seededRng(99);
  const a = Array.from({ length: 20 }, () => rngA());
  const b = Array.from({ length: 20 }, () => rngB());
  assert.deepEqual(a, b);
  assert.ok(one.every((value) => value >= 1 && value <= 6));
  assert.deepEqual(one.slice(0, 10), [2, 5, 4, 5, 1, 5, 1, 1, 3, 5]);
  const game = new DiceGame({ players: ["a", "b"], dicePerPlayer: 3, seed: 7 });
  assert.deepEqual(game.snapshot().players.map((player) => player.dice), [[1, 1, 6], [5, 4, 3]]);
});
