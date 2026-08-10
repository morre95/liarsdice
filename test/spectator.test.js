import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderModel } from "../public/spectator.js";

const state = { round: 1, turn: 1, bid: { quantity: 2, face: 4 }, players: [{ id: "a", diceCount: 3 }, { id: "b", diceCount: 2 }] };

test("spectator assets exist and model collects bids, talk, reveal, and reasoning", () => {
  assert.match(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), /spectator\.js/);
  assert.match(readFileSync(new URL("../public/spectator.css", import.meta.url), "utf8"), /@media/);
  let model = renderModel(state, { type: "bid", actor: "a", move: { bid: { quantity: 2, face: 4 }, table_talk: "Easy." }, reasoning: { a: "Count the ones." } });
  model = renderModel({ ...state, round: 2, bid: null }, { type: "round_end", actor: "b", round_end: {
    bid: { quantity: 2, face: 4 }, count: 1, challenger: "b", loser: "a", truth: false,
    matching: { face_matches: 0, wilds: 1, total: 1 }, cups: { a: [1, 3, 5], b: [2, 6] },
  } }, model);
  assert.deepEqual(model.history, []);
  assert.equal(model.reveal.count, 1);
  assert.deepEqual(model.reveal.cups, { a: [1, 3, 5], b: [2, 6] });
  assert.deepEqual(model.reveal.matching, { face_matches: 0, wilds: 1, total: 1 });
  assert.equal(model.talk.length, 0);
  assert.equal(model.reasoning.a, "Count the ones.");
});
