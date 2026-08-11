import { appendFileSync } from "node:fs";
import { DiceGame, RulesError } from "./rules.js";

export class MoveValidationError extends Error {
  constructor(message, code = "invalid_move") {
    super(message);
    this.name = "MoveValidationError";
    this.code = code;
  }
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function parseMove(input, maxBytes = 16 * 1024) {
  let value = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    if (bytes > maxBytes) throw new MoveValidationError("move is too large", "oversized");
    try { value = JSON.parse(typeof input === "string" ? input : new TextDecoder().decode(input)); }
    catch { throw new MoveValidationError("move must be valid JSON", "malformed"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoveValidationError("move must be an object", "malformed");
  }
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw new MoveValidationError("move must be valid JSON", "malformed"); }
  if (Buffer.byteLength(encoded) > maxBytes) throw new MoveValidationError("move is too large", "oversized");
  const keys = Object.keys(value);
  const allowed = new Set(["action", "bid", "turn", "table_talk", "reasoning"]);
  if (keys.some((key) => !allowed.has(key)) || !own(value, "turn") || !own(value, "action") ||
      (value.action === "bid" && !own(value, "bid")) ||
      ((value.action === "challenge" || value.action === "exact") && own(value, "bid"))) {
    throw new MoveValidationError("move has unexpected or missing keys", "shape");
  }
  if (!Number.isInteger(value.turn) || value.turn < 0) {
    throw new MoveValidationError("turn must be a non-negative integer", "malformed");
  }
  if (value.action !== "bid" && value.action !== "challenge" && value.action !== "exact") {
    throw new MoveValidationError("action must be bid, challenge, or exact", "malformed");
  }
  for (const field of ["table_talk", "reasoning"]) {
    if (own(value, field) && typeof value[field] !== "string") {
      throw new MoveValidationError(`${field} must be a string`, "malformed");
    }
  }
  const optional = (field) => own(value, field) ? { [field]: value[field] } : {};
  if (value.action === "challenge" || value.action === "exact") {
    return { action: value.action, turn: value.turn, ...optional("table_talk"), ...optional("reasoning") };
  }
  if (!value.bid || typeof value.bid !== "object" || Array.isArray(value.bid) ||
      Object.keys(value.bid).sort().join(",") !== "face,quantity" ||
      !Number.isInteger(value.bid.quantity) || !Number.isInteger(value.bid.face)) {
    throw new MoveValidationError("bid must contain integer quantity and face", "malformed");
  }
  return { action: "bid", turn: value.turn, bid: { quantity: value.bid.quantity, face: value.bid.face },
    ...optional("table_talk"), ...optional("reasoning") };
}

export { parseMove };

export class JsonlEventLog {
  constructor(path) { this.path = path; }
  append(event) { appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8"); }
}

function publicState(snapshot, tokenUsage = snapshot.tokenUsage) {
  const result = snapshot.lastResult && {
    bid: snapshot.lastResult.bid && { ...snapshot.lastResult.bid }, count: snapshot.lastResult.count,
    challenger: snapshot.lastResult.challenger, loser: snapshot.lastResult.loser,
    matching: snapshot.lastResult.matching && { ...snapshot.lastResult.matching }, truth: snapshot.lastResult.truth,
    exact: snapshot.lastResult.exact, losers: snapshot.lastResult.losers && [...snapshot.lastResult.losers],
    reward: snapshot.lastResult.reward,
  };
  return {
    players: snapshot.players.map(({ id, diceCount }) => ({ id, diceCount })),
    bid: snapshot.bid && { ...snapshot.bid }, turn: snapshot.turn, round: snapshot.round,
    phase: snapshot.phase, starter: snapshot.starter, palifico: snapshot.palifico,
    palificoFace: snapshot.palificoFace,
    lastResult: result,
    tokenUsage: tokenUsage && { ...tokenUsage },
  };
}

export class MatchCoordinator {
  constructor({ players, dicePerPlayer = 5, seed = 0, matchId = "match", rng, maxMoveBytes = 16 * 1024,
    illegalRetries = 2, maxPenalties = 3, penaltyStarter = "penalized", turnDeadlineMs = 0, disconnectGraceMs = 0,
    tokenBudget = Infinity, countTokens, eventLog, now = () => Date.now(), maxTableTalkLength = 280,
    exactCall = false, palifico = false, spotOnReward = false } = {}) {
    if (!Array.isArray(players) || players.length !== 2 || new Set(players.map(String)).size !== 2) {
      throw new MoveValidationError("exactly two distinct players are required", "configuration");
    }
    if (!Number.isInteger(illegalRetries) || illegalRetries < 0 || !Number.isInteger(maxPenalties) || maxPenalties < 1) {
      throw new MoveValidationError("invalid illegal move policy", "configuration");
    }
    this.players = players.map(String); this.matchId = String(matchId); this.seed = seed;
    this.dicePerPlayer = dicePerPlayer;
    this.rules = { exactCall: Boolean(exactCall), palifico: Boolean(palifico), spotOnReward: Boolean(spotOnReward) };
    this.maxMoveBytes = maxMoveBytes;
    this.illegalRetries = illegalRetries; this.maxPenalties = maxPenalties;
    if (penaltyStarter !== "penalized" && penaltyStarter !== "opponent") {
      throw new MoveValidationError("invalid penalty starter policy", "configuration");
    }
    this.penaltyStarter = penaltyStarter;
    this.turnDeadlineMs = turnDeadlineMs; this.disconnectGraceMs = disconnectGraceMs;
    this.tokenBudget = tokenBudget; this.tokenUsage = Object.fromEntries(this.players.map((p) => [p, 0]));
    this.countTokens = countTokens; this.maxTableTalkLength = maxTableTalkLength;
    this.eventLog = typeof eventLog === "function" ? { append: eventLog } : eventLog;
    this.now = now; this.seq = 0; this.turnSeq = 0; this.penalties = Object.fromEntries(this.players.map((p) => [p, 0]));
    this.retries = Object.fromEntries(this.players.map((p) => [p, 0]));
    this.illegalCounts = Object.fromEntries(this.players.map((p) => [p, 0])); this.disconnected = new Map();
    this.deadlineCheckedTurn = null; this.disconnectChecked = new Set();
    this.game = new DiceGame({ players: this.players, dicePerPlayer, seed, rng, exactCall, palifico, spotOnReward });
    this.turnStartedAt = this.now(); this.emit("match_started", null, { setup: {
      match_id: this.matchId, seed: this.seed,
      seats: this.players.map((id, seat) => ({ seat, id })),
      dice_per_player: this.dicePerPlayer, rules: { ...this.rules },
    } });
  }

  snapshot() { return { ...this.game.snapshot(), tokenUsage: { ...this.tokenUsage } }; }
  publicSnapshot() { return publicState(this.snapshot()); }
  privateSnapshot(player) {
    const state = this.snapshot();
    return state.players.find((p) => p.id === String(player))?.dice ?? null;
  }

  emit(type, actor, extra = {}, privateExtra = {}) {
    const snapshot = this.snapshot();
    const event = { seq: this.seq++, match_id: this.matchId, type, actor: actor == null ? null : String(actor), turn: this.turnSeq,
      state: publicState(snapshot), ...extra };
    event.private = Object.fromEntries(snapshot.players.map((p) => [p.id, { dice: [...p.dice], ...privateExtra[p.id] }]));
    if (this.eventLog) this.eventLog.append(event);
    return event;
  }

  checkDeadline(at = this.now()) {
    if (this.turnDeadlineMs > 0 && this.game.snapshot().phase === "bidding" &&
        at - this.turnStartedAt >= this.turnDeadlineMs && this.deadlineCheckedTurn !== this.turnSeq) {
      this.deadlineCheckedTurn = this.turnSeq;
      return this.penalize(this.game.currentPlayer().id, "deadline", at);
    }
    return null;
  }

  submit(agent, input, { at = this.now(), tokens = 0 } = {}) {
    const player = String(agent);
    if (!this.players.includes(player)) throw new MoveValidationError("unknown agent", "auth");
    if (this.game.snapshot().phase === "finished") throw new MoveValidationError("match is finished", "finished");
    const deadline = this.checkDeadline(at);
    if (deadline) return deadline;
    const move = parseMove(input, this.maxMoveBytes);
    if (move.turn !== this.turnSeq) return this.illegal(player, "stale_turn");
    if (this.game.currentPlayer().id !== player) return this.illegal(player, "not_your_turn");
    const used = Number.isInteger(tokens) && tokens >= 0 ? tokens : NaN;
    if (!Number.isInteger(used)) return this.illegal(player, "invalid_token_count");
    if (this.tokenUsage[player] + used > this.tokenBudget) return this.illegal(player, "token_budget");
    this.tokenUsage[player] += used;
    if (this.countTokens) this.countTokens(used, this.tokenUsage[player], player);
    try {
       const before = move.action === "challenge" || move.action === "exact" ? this.game.snapshot() : null;
       const state = move.action === "bid" ? this.game.placeBid(player, move.bid) :
         move.action === "exact" ? this.game.exactCall(player) : this.game.challenge(player);
      this.retries[player] = 0; this.turnSeq += 1; this.turnStartedAt = at;
      this.deadlineCheckedTurn = null; this.disconnectChecked.delete(player);
      const normalized = { ...move };
      if (normalized.table_talk !== undefined) {
        normalized.table_talk = normalized.table_talk.slice(0, this.maxTableTalkLength);
      }
      const reasoning = normalized.reasoning;
      delete normalized.reasoning;
      const result = state.lastResult && publicState({ lastResult: state.lastResult, players: [], bid: null,
        turn: 0, round: 0, phase: "bidding", starter: 0, tokenUsage: {} }).lastResult;
      const event = this.emit(move.action, player, { move: normalized, result },
        reasoning === undefined ? {} : { [player]: { reasoning } });
       if (move.action === "challenge" || move.action === "exact") {
        const roundEnd = this.emit("round_end", player, {
          round_end: { bid: { ...state.lastResult.bid }, challenger: state.lastResult.challenger,
            loser: state.lastResult.loser, count: state.lastResult.count,
             matching: state.lastResult.matching && { ...state.lastResult.matching }, truth: state.lastResult.truth,
             exact: state.lastResult.exact, losers: state.lastResult.losers, reward: state.lastResult.reward,
            cups: Object.fromEntries(Object.entries(state.lastResult.cups).map(([id, dice]) => [id, [...dice]])) },
        }, Object.fromEntries(before.players.map((value) =>
          [value.id, { dice: [...state.lastResult.cups[value.id]] }])));
      }
      return event;
    } catch (error) {
      if (!(error instanceof RulesError)) throw error;
      return this.illegal(player, error.message);
    }
  }

  illegal(player, reason) {
    if (this.game.snapshot().phase === "finished") return null;
    this.illegalCounts[player] += 1;
    this.retries[player] += 1;
    if (this.retries[player] <= this.illegalRetries) return this.emit("illegal_move", player, { reason, retry: this.retries[player] });
    this.retries[player] = 0;
    return this.penalize(player, reason);
  }

  penalize(player, reason, at = this.now()) {
    this.penalties[player] += 1;
    const forfeited = this.penalties[player] >= this.maxPenalties;
    const after = this.game.penalize(player, this.penaltyStarter);
    this.turnSeq += 1;
    const winner = after.players.length === 1 ? after.players[0].id :
      (forfeited ? this.players.find((id) => id !== player) : null);
    if (forfeited) this.game.state.phase = "finished";
    this.turnStartedAt = at;
    this.deadlineCheckedTurn = null;
    const consequence = { die_lost: 1, dice_count: after.players.find((p) => p.id === player)?.diceCount || 0,
      round_ended: true, next_round: after.phase === "finished" ? null : after.round,
      next_starter: after.phase === "finished" ? null : after.players[after.starter].id, winner };
    const event = this.emit(forfeited ? "forfeit" : "penalty", player,
      { reason, penalties: this.penalties[player], consequence,
        final: forfeited ? this.finalRecord(winner) : undefined });
    return event;
  }

  finalRecord(winner = null) {
    const state = this.snapshot();
    return { winner, final_counts: Object.fromEntries(this.players.map((id) =>
      [id, state.players.find((player) => player.id === id)?.diceCount || 0])),
      illegal_counts: { ...this.illegalCounts }, penalties: { ...this.penalties },
      token_usage: { ...this.tokenUsage }, state: publicState(state) };
  }

  disconnect(player, at = this.now()) {
    const id = String(player); if (!this.players.includes(id)) throw new MoveValidationError("unknown agent", "auth");
    this.disconnected.set(id, at); return this.emit("disconnect", id, { graceMs: this.disconnectGraceMs });
  }

  reconnect(player) {
    const id = String(player); if (!this.players.includes(id)) throw new MoveValidationError("unknown agent", "auth");
    this.disconnected.delete(id); this.disconnectChecked.delete(id);
  }

  checkDisconnects(at = this.now()) {
    if (this.game.snapshot().phase === "finished") return null;
    const current = this.game.currentPlayer().id;
    const disconnectedAt = this.disconnected.get(current);
    if (disconnectedAt !== undefined && at - disconnectedAt >= this.disconnectGraceMs && !this.disconnectChecked.has(current)) {
      this.disconnectChecked.add(current);
      return this.penalize(current, "disconnect_grace_expired", at);
    }
    return null;
  }
}
