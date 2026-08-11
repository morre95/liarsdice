import { WebSocket } from "ws";
import { parseMove } from "./coordinator.js";

function agentMove(agent, context) {
  if (typeof agent === "function") return agent(context);
  if (typeof agent?.move === "function") return agent.move(context);
  if (typeof agent?.chooseMove === "function") return agent.chooseMove(context);
  throw new TypeError("agent must be a function or expose move/chooseMove");
}

function endpointUrl(url, player, token, tokenInUrl = true) {
  const endpoint = new URL(url);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new TypeError("agent URL must use ws, wss, http, or https");
  }
  if (endpoint.pathname === "/") endpoint.pathname = "/agent";
  endpoint.searchParams.set("player", player);
  if (tokenInUrl) endpoint.searchParams.set("token", token);
  return endpoint.href;
}

function responseTokens(response) {
  const tokens = response?.move ? response.tokens : 0;
  return Number.isInteger(tokens) && tokens >= 0 ? tokens : 0;
}

function responseMove(response, turn) {
  let value = response?.move ?? response;
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("agent response must contain a move");
  }
  return parseMove({ ...value, turn });
}

function safeIllegalMove(turn) {
  return { action: "bid", turn, bid: { quantity: 0, face: 1 } };
}

export class AsyncAgentBridge {
  constructor({ url, player, token, agent, WebSocketImpl = WebSocket, onMessage, onError,
    closeOnMatchEnd = true, tokenInUrl = true } = {}) {
    if (typeof url !== "string" || !url) throw new TypeError("agent URL is required");
    if (player === undefined || player === null || String(player) === "") throw new TypeError("player is required");
    if (typeof token !== "string" || !token) throw new TypeError("match token is required");
    if (typeof agent !== "function" && typeof agent?.move !== "function" && typeof agent?.chooseMove !== "function") {
      throw new TypeError("agent must be a function or expose move/chooseMove");
    }
    if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocket implementation is required");
    if (onMessage !== undefined && typeof onMessage !== "function") throw new TypeError("onMessage must be a function");
    if (onError !== undefined && typeof onError !== "function") throw new TypeError("onError must be a function");

    this.url = endpointUrl(url, String(player), token, tokenInUrl);
    this.socketOptions = tokenInUrl ? null : { headers: { authorization: `Bearer ${token}` } };
    this.player = String(player);
    this.agent = agent;
    this.WebSocketImpl = WebSocketImpl;
    this.onMessage = onMessage;
    this.onError = onError;
    this.closeOnMatchEnd = closeOnMatchEnd;
    this.socket = null;
    this.matchId = null;
    this.rules = {};
    this.state = null;
    this.diceByRound = new Map();
    this.activeTurn = null;
    this.completedTurns = new Set();
    this.ended = false;
    this.started = false;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  report(error, message) {
    if (!this.onError) return;
    try { this.onError(error, message); } catch { /* Error reporters must not break the protocol loop. */ }
  }

  async start() {
    if (this.started) throw new Error("bridge has already started");
    this.started = true;
    const socket = this.socketOptions
      ? new this.WebSocketImpl(this.url, [], this.socketOptions) : new this.WebSocketImpl(this.url);
    this.socket = socket;

    socket.on("message", (data) => {
      this.handleMessage(data).catch((error) => this.report(error));
    });
    socket.once("close", (code, reason) => {
      this.ended = true;
      this.activeTurn = null;
      this.resolveClosed({ code, reason: reason?.toString?.() ?? String(reason ?? "") });
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => { socket.off("error", onInitialError); resolve(); };
      const onInitialError = (error) => { socket.off("open", onOpen); reject(error); };
      socket.once("open", onOpen);
      socket.once("error", onInitialError);
    });
    socket.on("error", (error) => this.report(error));
    return this;
  }

  waitForClose() { return this.closed; }

  close(code = 1000, reason = "agent bridge closed") {
    if (!this.socket) {
      this.ended = true;
      this.resolveClosed({ code, reason });
      return this.closed;
    }
    if (this.socket.readyState < 2) this.socket.close(code, reason);
    return this.closed;
  }

  async handleMessage(data) {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch (error) { this.report(error); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    this.onMessage?.(message);

    if (message.match_id) this.matchId = message.match_id;
    if (message.rules) this.rules = { ...message.rules };
    if (message.state) this.state = message.state;

    if (message.type === "round_start" && Number.isInteger(message.round) && Array.isArray(message.dice)) {
      this.diceByRound.set(message.round, [...message.dice]);
      for (const round of this.diceByRound.keys()) {
        if (round < message.round) this.diceByRound.delete(round);
      }
      this.runActiveTurn();
      return;
    }

    if (message.type === "your_turn") {
      this.queueTurn(message);
      return;
    }

    if (message.type === "match_end") {
      this.ended = true;
      this.activeTurn = null;
      if (this.closeOnMatchEnd) this.close(1000, "match ended");
    }
  }

  queueTurn(message) {
    if (!Number.isInteger(message.your_turn_seq) || message.your_turn_seq < 0) {
      this.report(new TypeError("your_turn message is missing your_turn_seq"), message);
      return;
    }
    const round = message.state?.round ?? this.state?.round;
    if (!Number.isInteger(round) || round < 1) {
      this.report(new TypeError("your_turn message is missing the round"), message);
      return;
    }
    const retry = Number.isInteger(message.illegal_retry_count) ? message.illegal_retry_count : 0;
    const key = `${message.match_id ?? this.matchId}:${round}:${message.your_turn_seq}:${retry}`;
    if (this.activeTurn?.key === key || this.completedTurns.has(key)) return;
    this.activeTurn = { key, message, round, running: false };
    this.runActiveTurn();
  }

  async runActiveTurn() {
    const active = this.activeTurn;
    if (!active || active.running || this.ended) return;
    const dice = this.diceByRound.get(active.round);
    if (!dice) return;
    active.running = true;
    const message = active.message;
    const turn = message.your_turn_seq;
    const state = { ...(message.state ?? this.state), turn_seq: turn };
    const context = {
      state,
      dice: [...dice],
      rules: { ...this.rules },
      match_id: message.match_id ?? this.matchId,
      player: this.player,
      current_bid: message.current_bid,
      total_dice: message.total_dice,
      remaining_time_ms: message.remaining_time_ms,
      remaining_token_budget: message.remaining_token_budget,
      illegal_retry_count: message.illegal_retry_count ?? 0,
    };

    let response;
    let move;
    try {
      response = await agentMove(this.agent, context);
      move = responseMove(response, turn);
    } catch (error) {
      this.report(error, message);
      move = safeIllegalMove(turn);
    }

    if (this.ended || this.activeTurn?.key !== active.key) return;
    const open = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (this.socket?.readyState !== open) return;
    this.socket.send(JSON.stringify({
      match_id: message.match_id ?? this.matchId,
      your_turn_seq: turn,
      tokens: responseTokens(response),
      move,
    }));
    this.completedTurns.add(active.key);
  }
}

export async function connectAgentBridge(options) {
  const bridge = new AsyncAgentBridge(options);
  await bridge.start();
  return bridge;
}
