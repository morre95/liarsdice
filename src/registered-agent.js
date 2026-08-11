import { WebSocket } from "ws";
import { AsyncAgentBridge } from "./agent-bridge.js";

function registrationUrl(value) {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("lobby URL must use ws, wss, http, or https");
  }
  url.pathname = "/register";
  url.search = "";
  url.hash = "";
  return url;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RegisteredAgentRunner {
  constructor({ url, id, label, registrationToken, agent, WebSocketImpl = WebSocket,
    BridgeImpl = AsyncAgentBridge, reconnectDelayMs = 1000, onError } = {}) {
    if (typeof url !== "string" || !url) throw new TypeError("lobby URL is required");
    if (id === undefined || id === null || !String(id)) throw new TypeError("agent id is required");
    if (typeof registrationToken !== "string" || !registrationToken) throw new TypeError("registration token is required");
    if (typeof agent !== "function" && typeof agent?.move !== "function" && typeof agent?.chooseMove !== "function") {
      throw new TypeError("agent must be a function or expose move/chooseMove");
    }
    if (!Number.isInteger(reconnectDelayMs) || reconnectDelayMs < 0) throw new TypeError("reconnect delay must be non-negative");
    this.url = registrationUrl(url);
    this.id = String(id);
    this.label = label === undefined ? this.id : String(label);
    this.registrationToken = registrationToken;
    this.agent = agent;
    this.WebSocketImpl = WebSocketImpl;
    this.BridgeImpl = BridgeImpl;
    this.reconnectDelayMs = reconnectDelayMs;
    this.onError = onError;
    this.socket = null;
    this.activeBridge = null;
    this.activeBridgeStarted = false;
    this.activeMatchId = null;
    this.reconnectTimer = null;
    this.started = false;
    this.stopping = false;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  report(error) {
    try { this.onError?.(error); } catch { /* Error reporters must not stop registration. */ }
  }

  send(message) {
    const open = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (this.socket?.readyState === open) this.socket.send(JSON.stringify(message));
  }

  async connect() {
    const socket = new this.WebSocketImpl(this.url.href);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let registered = false;
      const failInitial = (error) => { if (!registered) reject(error); else this.report(error); };
      socket.once("open", () => this.send({ type: "register", agent_id: this.id, label: this.label,
        token: this.registrationToken, active_match_id: this.activeMatchId }));
      socket.on("message", (data) => {
        let message;
        try { message = JSON.parse(data.toString()); } catch (error) { this.report(error); return; }
        if (message?.type === "registered") {
          registered = true;
          if (this.activeMatchId && this.activeBridgeStarted) {
            this.send({ type: "assignment_started", match_id: this.activeMatchId });
          }
          resolve(this);
          return;
        }
        this.handleMessage(message).catch((error) => this.report(error));
      });
      socket.on("error", failInitial);
      socket.once("close", (code, reason) => {
        if (this.socket === socket) this.socket = null;
        if (!registered) {
          const error = new Error(`registration closed (${code}): ${reason.toString() || "no reason supplied"}`);
          error.closeCode = code;
          reject(error);
        }
        if (!this.stopping && registered) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((error) => { this.report(error); if (!this.stopping) this.scheduleReconnect(); });
          }, this.reconnectDelayMs);
        }
      });
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => { this.report(error); if (!this.stopping) this.scheduleReconnect(); });
    }, this.reconnectDelayMs);
  }

  async start() {
    if (this.started) throw new Error("registered agent runner has already started");
    this.started = true;
    while (!this.stopping) {
      try { await this.connect(); break; }
      catch (error) {
        if (error.closeCode === 1008) throw error;
        this.report(error);
        await delay(this.reconnectDelayMs);
      }
    }
    return this;
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "assignment_released" && message.match_id === this.activeMatchId) {
      this.activeBridge?.close(1000, "assignment released");
      return;
    }
    if (message.type === "assignment_released") {
      this.send({ type: "assignment_complete", match_id: message.match_id });
      return;
    }
    if (message.type !== "match_assignment") return;
    if (this.activeBridge) {
      this.send({ type: "assignment_failed", match_id: message.match_id, error: "agent is already busy" });
      return;
    }
    if (message.player !== this.id || typeof message.endpoint !== "string" || typeof message.token !== "string") {
      this.send({ type: "assignment_failed", match_id: message.match_id, error: "invalid assignment" });
      return;
    }
    const endpoint = new URL(message.endpoint, this.url);
    const bridge = new this.BridgeImpl({ url: endpoint.href, player: this.id, token: message.token,
      agent: this.agent, WebSocketImpl: this.WebSocketImpl, tokenInUrl: false,
      onError: (error) => this.report(error) });
    this.activeBridge = bridge;
    this.activeBridgeStarted = false;
    this.activeMatchId = message.match_id;
    try {
      await bridge.start();
      this.activeBridgeStarted = true;
      this.send({ type: "assignment_started", match_id: message.match_id });
      const closed = await bridge.waitForClose();
      if (closed.code !== 1000) {
        this.send({ type: "assignment_failed", match_id: message.match_id,
          error: closed.reason || `match connection closed with code ${closed.code}` });
      } else this.send({ type: "assignment_complete", match_id: message.match_id });
    } catch (error) {
      this.send({ type: "assignment_failed", match_id: message.match_id, error: error.message });
      this.report(error);
    } finally {
      if (this.activeBridge === bridge) {
        this.activeBridge = null;
        this.activeBridgeStarted = false;
        this.activeMatchId = null;
      }
    }
  }

  waitForClose() { return this.closed; }

  close(code = 1000, reason = "registered agent stopped") {
    if (this.stopping) return this.closed;
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.activeBridge?.close(code, reason);
    if (this.socket?.readyState < 2) this.socket.close(code, reason);
    this.resolveClosed({ code, reason });
    return this.closed;
  }
}
