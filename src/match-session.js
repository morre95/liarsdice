import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import { MatchCoordinator, MoveValidationError } from "./coordinator.js";
import { makeConfig } from "./config.js";
import { readReplay, ReplayStream } from "./replay.js";

const json = (value) => JSON.stringify(value);

function visibleState(coordinator, omniscient = false) {
  const state = coordinator.snapshot();
  if (!omniscient) return coordinator.publicSnapshot();
  return { ...state, players: state.players.map((player) => ({ ...player, dice: [...player.dice] })) };
}

function spectatorState(state) {
  return { ...state, lastResult: state.lastResult && {
    bid: state.lastResult.bid && { ...state.lastResult.bid },
    challenger: state.lastResult.challenger, loser: state.lastResult.loser,
  } };
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(json(message));
}

function machineReason(reason) {
  return ({ "there is no bid to challenge": "no_bid", "illegal bid": "illegal_bid" }[reason]) || reason;
}

function reasonExplanation(reason) {
  return ({ malformed: "The move envelope or move body is malformed.", shape: "The move contains unexpected or missing fields.",
    oversized: "The move exceeds the maximum message size.", stale_turn: "The move refers to an earlier turn.",
    not_your_turn: "It is not this agent's turn.", token_budget: "The agent's token budget would be exceeded.",
    no_bid: "There is no bid to challenge.", illegal_bid: "The bid is not legal at this point." }[reason]) || reason;
}

export class MatchSession {
  constructor(options = {}, { waitForPlayers = false } = {}) {
    this.config = makeConfig(options);
    if (this.config.eventLogPath) mkdirSync(dirname(this.config.eventLogPath), { recursive: true });
    this.replayPath = options.replayPath;
    this.replayStrict = options.replayStrict === true;
    this.replaySpeed = options.replaySpeed ?? 1;
    this.onReplayMalformed = options.onReplayMalformed;
    this.onFinish = options.onFinish;
    this.onDispose = options.onDispose;
    this.playerTokens = options.playerTokens
      ? new Map(Object.entries(options.playerTokens).map(([id, token]) => [String(id), token])) : null;
    this.match = new MatchCoordinator({ ...this.config, eventLog: this.config.eventLogPath ? { append: (event) => {
      appendFileSync(this.config.eventLogPath, `${json(event)}\n`, "utf8");
    } } : this.config.eventLog });
    this.agents = new Map();
    this.spectators = new Set();
    this.replayStreams = new Set();
    this.matchEndEmitted = false;
    this.spectatorBidHistory = [];
    this.announcedRound = this.match.snapshot().round;
    this.status = waitForPlayers ? "waiting" : "running";
    this.createdAt = new Date().toISOString();
    this.startedAt = waitForPlayers ? null : this.createdAt;
    this.endedAt = null;
    this.finalRecord = null;
    this.disposing = false;

    const originalEmit = this.match.emit.bind(this.match);
    this.match.emit = (...args) => {
      const event = originalEmit(...args);
      this.broadcast(event);
      return event;
    };
  }

  get id() { return this.config.matchId; }

  summary() {
    const state = this.match.publicSnapshot();
    return {
      id: this.id,
      players: [...this.config.players],
      connected: this.config.players.filter((player) => this.agents.get(String(player))?.readyState === WebSocket.OPEN),
      status: this.status,
      round: state.round,
      phase: state.phase,
      winner: this.finalRecord?.winner ?? null,
      dice_counts: Object.fromEntries(state.players.map((player) => [player.id, player.diceCount])),
      rules: { exact_call: this.config.exactCall, palifico: this.config.palifico, spot_on_reward: this.config.spotOnReward },
      created_at: this.createdAt,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      spectator_url: `/?match_id=${encodeURIComponent(this.id)}`,
    };
  }

  turnInfo(player) {
    const deadline = this.status === "running" && this.config.turnDeadlineMs > 0
      ? this.match.turnStartedAt + this.config.turnDeadlineMs : null;
    const state = this.match.snapshot();
    return { current_bid: state.bid && { ...state.bid }, total_dice: state.players.reduce((sum, candidate) => sum + candidate.diceCount, 0),
      remaining_time_ms: deadline === null ? null : Math.max(0, deadline - this.match.now()),
      remaining_token_budget: Number.isFinite(this.config.tokenBudget) ? Math.max(0, this.config.tokenBudget - (this.match.tokenUsage[player] || 0)) : null,
      illegal_retry_count: this.match.retries[player] || 0, deadline, your_turn_seq: this.match.turnSeq };
  }

  agentMessage(player, event, type = event.type === "illegal_move" ? "move_rejected" : "state_update") {
    return {
      seq: event.seq, type, match_id: this.id, event: event.type, actor: event.actor, turn: event.turn,
      state: event.state, result: event.result, reason: event.reason && machineReason(event.reason),
      explanation: event.reason && reasonExplanation(machineReason(event.reason)), retry: event.retry,
      penalties: event.penalties, ...this.turnInfo(player), table_talk: event.move?.table_talk,
      round_end: event.type === "round_end" && event.round_end ? {
        ...event.round_end, cups: { [player]: [...(event.round_end.cups?.[player] || [])] },
      } : undefined,
    };
  }

  sendRoundStart() {
    const state = this.match.snapshot();
    for (const [player, socket] of this.agents) {
      if (!state.players.some((candidate) => candidate.id === player)) continue;
      send(socket, { seq: this.match.seq++, type: "round_start", match_id: this.id,
        round: state.round, turn: this.match.turnSeq, dice: this.match.privateSnapshot(player), ...this.turnInfo(player) });
    }
  }

  sendCurrentTurn() {
    const state = this.match.snapshot();
    if (state.phase === "finished" || this.status !== "running") return;
    const player = state.players[state.turn]?.id;
    const socket = this.agents.get(player);
    if (socket) send(socket, { seq: this.match.seq++, type: "your_turn", match_id: this.id,
      turn: this.match.turnSeq, state: visibleState(this.match), ...this.turnInfo(player) });
  }

  sendInitial(player, socket) {
    const initial = this.match.snapshot();
    send(socket, { seq: this.match.seq++, type: "match_start", match_id: this.id, player: String(player),
      seat: this.config.players.map(String).indexOf(String(player)), players: this.config.players.map(String),
      rules: { dice_per_player: this.config.dicePerPlayer, wild_ones: true, exact_call: this.config.exactCall,
        palifico: this.config.palifico, spot_on_reward: this.config.spotOnReward },
      dice_counts: Object.fromEntries(initial.players.map((candidate) => [candidate.id, candidate.diceCount])),
      token_budget: Number.isFinite(this.config.tokenBudget) ? this.config.tokenBudget : null,
      state: visibleState(this.match), ...this.turnInfo(String(player)) });
    send(socket, { seq: this.match.seq++, type: "round_start", match_id: this.id, round: initial.round,
      turn: this.match.turnSeq, dice: this.match.privateSnapshot(player), ...this.turnInfo(String(player)) });
    if (initial.players[initial.turn]?.id === String(player)) {
      send(socket, { seq: this.match.seq++, type: "your_turn", match_id: this.id,
        turn: this.match.turnSeq, state: visibleState(this.match), ...this.turnInfo(String(player)) });
    }
  }

  activate() {
    if (this.status !== "waiting") return;
    if (!this.config.players.every((player) => this.agents.get(String(player))?.readyState === WebSocket.OPEN)) return;
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.match.turnStartedAt = this.match.now();
    for (const player of this.config.players.map(String)) this.sendInitial(player, this.agents.get(player));
  }

  spectatorMessage(event) {
    const message = { ...event, match_id: this.id, private: undefined };
    if ((event.type === "challenge" || event.type === "exact") && !this.config.omniscientSpectators && event.result) {
      message.result = { bid: event.result.bid && { ...event.result.bid }, challenger: event.result.challenger,
        loser: event.result.loser };
    }
    if (event.type === "round_end" && event.round_end) {
      message.round_end = this.config.omniscientSpectators ? {
        ...event.round_end,
        cups: Object.fromEntries(Object.entries(event.round_end.cups).map(([id, dice]) => [id, [...dice]])),
      } : { bid: { ...event.round_end.bid }, challenger: event.round_end.challenger, loser: event.round_end.loser,
        exact: event.round_end.exact, losers: event.round_end.losers, reward: event.round_end.reward };
    }
    if (!this.config.omniscientSpectators) message.state = spectatorState(message.state);
    if (this.config.omniscientSpectators) message.state = visibleState(this.match, true);
    if (this.config.showSpectatorReasoning) {
      const reasoning = Object.fromEntries(Object.entries(event.private || {})
        .filter(([, value]) => value.reasoning !== undefined)
        .map(([player, value]) => [player, value.reasoning]));
      if (Object.keys(reasoning).length) message.reasoning = reasoning;
    }
    return message;
  }

  broadcast(event) {
    if (event.type === "bid" && event.move?.bid) this.spectatorBidHistory.push({ ...event.move.bid, actor: event.actor });
    for (const [player, socket] of this.agents) send(socket, this.agentMessage(player, event));
    const newRound = (event.type === "round_end" || event.type === "penalty") &&
      event.state?.phase !== "finished" && event.state?.round !== this.announcedRound;
    if (newRound) {
      this.announcedRound = event.state.round;
      this.sendRoundStart();
    }
    if (["bid", "round_end", "illegal_move", "penalty"].includes(event.type)) this.sendCurrentTurn();
    for (const socket of this.spectators) send(socket, this.spectatorMessage(event));
    if (event.type === "challenge" || event.type === "exact") this.spectatorBidHistory = [];
    if (event.state.phase === "finished" && !this.matchEndEmitted && event.type !== "challenge" && event.type !== "exact") {
      this.matchEndEmitted = true;
      const finalState = this.match.snapshot();
      const winner = finalState.players.length === 1 ? finalState.players[0].id :
        (event.type === "forfeit" ? this.config.players.find((id) => String(id) !== String(event.actor)) : null);
      const record = { seq: this.match.seq++, type: "match_end", match_id: this.id, winner,
        final_counts: Object.fromEntries(this.config.players.map((id) => [String(id), finalState.players.find((player) => player.id === String(id))?.diceCount || 0])),
        illegal_counts: { ...this.match.illegalCounts }, token_usage: { ...this.match.tokenUsage },
        state: visibleState(this.match), result: event.result || event.state.lastResult };
      if (this.match.eventLog) this.match.eventLog.append(record);
      for (const socket of this.agents.values()) send(socket, record);
      const spectatorRecord = this.config.omniscientSpectators ? { ...record, state: visibleState(this.match, true) } : record;
      for (const socket of this.spectators) send(socket, spectatorRecord);
      this.status = "finished";
      this.endedAt = new Date().toISOString();
      this.finalRecord = record;
      this.onFinish?.(this);
    }
  }

  connectAgent(socket, player, token) {
    if (!this.config.players.map(String).includes(String(player))) { socket.close(1008, "unknown agent"); return; }
    const id = String(player);
    const expectedToken = this.playerTokens?.get(id) ?? this.config.matchToken;
    if (token !== expectedToken) { socket.close(1008, "invalid match token"); return; }
    if (this.status === "finished") { socket.close(1008, "match finished"); return; }
    const existing = this.agents.get(id);
    if (existing && existing.readyState === WebSocket.OPEN) { socket.close(1008, "agent already connected"); return; }
    this.agents.set(id, socket);
    this.match.reconnect(id);
    if (this.status === "waiting") this.activate();
    else this.sendInitial(id, socket);
    socket.on("message", (data) => {
      if (this.status !== "running") return;
      try {
        const payload = JSON.parse(data.toString());
        if (!payload || typeof payload !== "object" || payload.match_id !== this.id || !Number.isInteger(payload.your_turn_seq)) {
          throw new MoveValidationError("move envelope must identify match and turn", "shape");
        }
        const envelopeKeys = new Set(["match_id", "your_turn_seq", "tokens", "move", "action", "bid", "turn", "table_talk", "reasoning"]);
        if (Object.keys(payload).some((key) => !envelopeKeys.has(key))) {
          throw new MoveValidationError("move envelope has unexpected fields", "shape");
        }
        const tokens = payload.tokens ?? 0;
        const move = payload.move ?? (() => {
          const copy = { ...payload };
          delete copy.match_id; delete copy.your_turn_seq; delete copy.tokens;
          return copy;
        })();
        this.match.submit(id, { ...move, turn: payload.your_turn_seq }, { tokens });
      } catch (error) {
        if (error instanceof MoveValidationError) this.match.illegal(id, error.code);
        else this.match.illegal(id, "malformed");
      }
    });
    socket.on("close", () => {
      if (this.agents.get(id) !== socket) return;
      this.agents.delete(id);
      if (!this.disposing && this.status === "running") this.match.disconnect(id);
    });
  }

  connectSpectator(socket) {
    this.spectators.add(socket);
    if (this.replayPath) {
      readReplay(this.replayPath, { strict: this.replayStrict, onMalformed: this.onReplayMalformed }).then((records) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const first = records[0];
        const history = [];
        for (const event of records) {
          if (event.type === "bid" && event.move?.bid) history.push({ ...event.move.bid, actor: event.actor });
          if (event.type === "challenge") history.length = 0;
        }
        send(socket, { seq: first?.seq ?? 0, type: "snapshot", match_id: this.id,
          state: spectatorState(first?.state || this.match.publicSnapshot()), history, replay: true });
        const stream = new ReplayStream(records, { speed: this.replaySpeed });
        this.replayStreams.add(stream);
        stream.run((event) => {
          if (socket.readyState !== WebSocket.OPEN) { stream.stop(); return; }
          const message = { ...event, match_id: this.id, private: undefined, replay: true };
          if ((event.type === "challenge" || event.type === "exact") && !this.config.omniscientSpectators && event.result) {
            message.result = { bid: event.result.bid && { ...event.result.bid }, challenger: event.result.challenger,
              loser: event.result.loser };
          }
          if (event.type === "round_end" && event.round_end && !this.config.omniscientSpectators) {
            message.round_end = { bid: { ...event.round_end.bid }, challenger: event.round_end.challenger,
              loser: event.round_end.loser };
          }
          if (this.config.omniscientSpectators && event.private) {
            message.state = { ...event.state, players: event.state.players.map((player) => ({ ...player, dice: event.private[player.id]?.dice })) };
          }
          if (!this.config.omniscientSpectators) message.state = spectatorState(message.state);
          if (this.config.showSpectatorReasoning && event.private) {
            const reasoning = Object.fromEntries(Object.entries(event.private)
              .filter(([, value]) => value.reasoning !== undefined).map(([player, value]) => [player, value.reasoning]));
            if (Object.keys(reasoning).length) message.reasoning = reasoning;
          }
          send(socket, message);
        }).finally(() => this.replayStreams.delete(stream));
        socket.once("close", () => stream.stop());
      }).catch((error) => socket.readyState === WebSocket.OPEN && send(socket, { type: "replay_error", match_id: this.id, error: error.message }));
    } else {
      send(socket, { seq: this.match.seq++, type: "snapshot", match_id: this.id, status: this.status,
        winner: this.finalRecord?.winner ?? null,
        state: this.config.omniscientSpectators ? visibleState(this.match, true) : spectatorState(visibleState(this.match, false)),
        history: this.spectatorBidHistory,
        deadline: this.status === "running" && this.config.turnDeadlineMs > 0 ? this.match.turnStartedAt + this.config.turnDeadlineMs : null });
      socket.on("message", () => send(socket, { type: "spectator_message_ignored", match_id: this.id }));
    }
    socket.on("close", () => this.spectators.delete(socket));
  }

  checkPolicies() {
    if (this.status !== "running") return;
    this.match.checkDeadline() || this.match.checkDisconnects();
  }

  dispose() {
    if (this.disposing) return;
    this.disposing = true;
    for (const stream of this.replayStreams) stream.stop();
    for (const socket of [...this.agents.values(), ...this.spectators]) socket.terminate();
    this.agents.clear();
    this.spectators.clear();
    this.replayStreams.clear();
    this.onDispose?.(this);
  }
}
