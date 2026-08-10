import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, rmSync } from "node:fs";
import { LlmAgent, buildMatchContext, loadSystemPrompt } from "../src/llm-agent.js";

const context = {
  state: {
    players: [{ id: "a", diceCount: 2, dice: [6, 6] }, { id: "b", diceCount: 2, dice: [1, 1] }],
    bid: { quantity: 1, face: 2 }, turn: 3, round: 2, phase: "bidding", starter: 0,
    tokenUsage: { a: 99 }, secret: "do not leak", lastResult: { bid: { quantity: 1, face: 2 }, count: 1 },
  },
  dice: [6, 6], otherSecret: "do not leak",
};

test("loads the standalone system prompt from disk", () => {
  const path = "/tmp/liars-dice-system-prompt.txt";
  writeFileSync(path, "test prompt", "utf8");
  assert.equal(loadSystemPrompt(path), "test prompt");
  rmSync(path, { force: true });
  assert.match(loadSystemPrompt(), /exactly one JSON object/);
});

test("constructs context with only public state and own dice", () => {
  const actual = buildMatchContext(context);
  assert.deepEqual(actual, {
    state: {
      players: [{ id: "a", diceCount: 2 }, { id: "b", diceCount: 2 }],
      bid: { quantity: 1, face: 2 }, turn: 3, round: 2, phase: "bidding", starter: 0,
      lastResult: { bid: { quantity: 1, face: 2 }, count: 1, challenger: undefined, loser: undefined },
    },
    dice: [6, 6],
  });
  assert.equal(JSON.stringify(actual).includes("secret"), false);
});

test("parses one valid model move and reports token usage", () => {
  let request;
  const agent = new LlmAgent({ id: "a", model: (value) => {
    request = value;
    return { text: '{"action":"bid","turn":3,"bid":{"quantity":2,"face":3}}', usage: { total_tokens: 12 } };
  }});
  assert.deepEqual(agent.move(context), { move: { action: "bid", turn: 3, bid: { quantity: 2, face: 3 } }, tokens: 12 });
  assert.equal(request.systemPrompt, loadSystemPrompt());
  assert.deepEqual(request.context, buildMatchContext(context));
});

test("converts malformed and failed model output to a safe illegal move", () => {
  for (const model of [() => '{"action":"bid","turn":3,"bid":{"quantity":2,"face":3}}\nextra', () => { throw new Error("offline"); }]) {
    const result = new LlmAgent({ id: "a", model }).move(context);
    assert.deepEqual(result.move, { action: "bid", turn: 3, bid: { quantity: 0, face: 1 } });
    assert.equal(result.tokens, 0);
  }
});

test("reports usage from a model response without requiring an SDK", () => {
  const result = new LlmAgent({ id: "a", model: () => ({ output: '{"action":"challenge","turn":3}', tokenUsage: { tokens: 7 } }) }).move(context);
  assert.deepEqual(result, { move: { action: "challenge", turn: 3 }, tokens: 7 });
});
