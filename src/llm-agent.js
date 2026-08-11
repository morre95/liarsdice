import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseMove } from "./coordinator.js";

const DEFAULT_PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../agents/system-prompt.txt");

export function loadSystemPrompt(promptPath = DEFAULT_PROMPT_PATH) {
  return readFileSync(promptPath, "utf8");
}

function copyBid(bid) {
  return bid && { quantity: bid.quantity, face: bid.face };
}

function copyResult(result) {
  if (!result) return null;
  return {
    bid: copyBid(result.bid),
    count: result.count,
    challenger: result.challenger,
    loser: result.loser,
  };
}

// Keep the model input deliberately narrower than the coordinator snapshot.
export function buildMatchContext(input = {}) {
  const state = input.state ?? {};
  const rules = input.rules ?? {};
  return {
    state: {
      players: Array.isArray(state.players)
        ? state.players.map(({ id, diceCount }) => ({ id, diceCount }))
        : [],
      bid: copyBid(state.bid),
      turn: state.turn,
      turn_seq: state.turn_seq,
      round: state.round,
      phase: state.phase,
      starter: state.starter,
      palifico: state.palifico,
      palificoFace: state.palificoFace,
      lastResult: copyResult(state.lastResult),
    },
    dice: Array.isArray(input.dice) ? [...input.dice] : [],
    rules: {
      dice_per_player: rules.dice_per_player,
      wild_ones: rules.wild_ones,
      exact_call: rules.exact_call,
      palifico: rules.palifico,
      spot_on_reward: rules.spot_on_reward,
    },
  };
}

function tokenCount(value) {
  const usage = value?.usage ?? value?.tokenUsage ?? value;
  const count = usage?.total_tokens ?? usage?.totalTokens ?? usage?.tokens;
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function modelText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.output === "string") return value.output;
  if (value && typeof value.text === "string") return value.text;
  return null;
}

function safeIllegalMove(context) {
  const turn = Number.isInteger(context.state.turn_seq) ? context.state.turn_seq : context.state.turn;
  return { action: "bid", turn: Number.isInteger(turn) ? turn : 0,
    bid: { quantity: 0, face: 1 } };
}

function modelResult(response, context) {
  const output = modelText(response);
  if (output === null) throw new Error("model did not return text");
  return { move: parseMove(output), tokens: tokenCount(response) };
}

export class LlmAgent {
  constructor({ id, model, promptPath = DEFAULT_PROMPT_PATH, systemPrompt } = {}) {
    if (id === undefined || id === null || String(id) === "") throw new TypeError("agent id is required");
    if (typeof model !== "function") throw new TypeError("model must be a function");
    this.id = String(id);
    this.model = model;
    this.systemPrompt = systemPrompt ?? loadSystemPrompt(promptPath);
  }

  move(input) {
    const context = buildMatchContext(input);
    let response;
    try {
      response = this.model({ systemPrompt: this.systemPrompt, context });
      if (response && typeof response.then === "function") {
        return Promise.resolve(response)
          .then((value) => {
            try { return modelResult(value, context); }
            catch { return { move: safeIllegalMove(context), tokens: tokenCount(value) }; }
          }, () => ({ move: safeIllegalMove(context), tokens: 0 }));
      }
      return modelResult(response, context);
    } catch {
      return { move: safeIllegalMove(context), tokens: tokenCount(response) };
    }
  }

  chooseMove(input) { return this.move(input); }
}

export function createLlmAgent(options) { return new LlmAgent(options); }
