import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, makeConfig } from "../src/config.js";

test("configuration schema covers the runtime defaults", () => {
  const schema = JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url)));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(schema.properties[key], `schema is missing ${key}`);
    if (key === "tokenBudget") assert.equal(schema.properties[key].default, null);
    else assert.deepEqual(schema.properties[key].default, value);
  }
  const config = makeConfig({ matchId: "schema", matchToken: "secret", players: ["a", "b"] });
  assert.equal(config.dicePerPlayer, schema.properties.dicePerPlayer.default);
  assert.equal(config.omniscientSpectators, schema.properties.omniscientSpectators.default);
  assert.equal(makeConfig({ matchId: "schema", matchToken: "secret", players: ["a", "b"], tokenBudget: null }).tokenBudget, Infinity);
});

test("variant flags are explicit booleans and remain disabled by default", () => {
  const config = makeConfig({ matchId: "variants", matchToken: "secret", players: ["a", "b"] });
  assert.equal(config.exactCall, false);
  assert.equal(config.palifico, false);
  assert.equal(config.spotOnReward, false);
  assert.throws(() => makeConfig({ matchId: "variants", matchToken: "secret", players: ["a", "b"], palifico: 1 }), /palifico/);
});

test("makeConfig validates the required server identity and port boundary", () => {
  assert.throws(() => makeConfig({ players: ["a", "b"], matchToken: "secret" }), /matchId is required/);
  assert.throws(() => makeConfig({ players: ["a", "b"], matchId: "match" }), /matchToken is required/);
  assert.throws(() => makeConfig({ players: ["a", "b"], matchId: "match", matchToken: "secret", port: -1 }), /port must be/);
  assert.throws(() => makeConfig({ players: ["a", "b"], matchId: "match", matchToken: "secret", port: 65536 }), /port must be/);
});
