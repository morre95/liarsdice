import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { MatchSession } from "./match-session.js";

const contentTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const matchIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request, adminToken) {
  const header = request.headers.authorization || "";
  return equalSecret(header.startsWith("Bearer ") ? header.slice(7) : "", adminToken);
}

async function readJson(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("request body must be valid JSON"), { status: 400 }); }
}

function matchRequest(body, catalog, defaults, token) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("match must be an object"), { status: 400 });
  const allowed = new Set(["matchId", "players", "dicePerPlayer", "seed", "exactCall", "palifico", "spotOnReward"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw Object.assign(new Error("match contains unsupported fields"), { status: 400 });
  if (typeof body.matchId !== "string" || !matchIdPattern.test(body.matchId)) {
    throw Object.assign(new Error("matchId must be 1-48 letters, numbers, underscores, or hyphens"), { status: 400 });
  }
  if (!Array.isArray(body.players) || body.players.length !== 2 || new Set(body.players).size !== 2 ||
      body.players.some((player) => typeof player !== "string" || !catalog.some((agent) => agent.id === player))) {
    throw Object.assign(new Error("players must contain two distinct registered agent ids"), { status: 400 });
  }
  const dicePerPlayer = body.dicePerPlayer ?? defaults.dicePerPlayer ?? 5;
  if (!Number.isInteger(dicePerPlayer) || dicePerPlayer < 1 || dicePerPlayer > 20) {
    throw Object.assign(new Error("dicePerPlayer must be an integer from 1 to 20"), { status: 400 });
  }
  const seed = body.seed ?? Math.floor(Math.random() * 0x7fffffff);
  if (!Number.isInteger(seed)) throw Object.assign(new Error("seed must be an integer"), { status: 400 });
  for (const key of ["exactCall", "palifico", "spotOnReward"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      throw Object.assign(new Error(`${key} must be a boolean`), { status: 400 });
    }
  }
  return { ...defaults, matchId: body.matchId, matchToken: token, players: [...body.players], dicePerPlayer, seed,
    exactCall: body.exactCall ?? defaults.exactCall ?? false,
    palifico: body.palifico ?? defaults.palifico ?? false,
    spotOnReward: body.spotOnReward ?? defaults.spotOnReward ?? false };
}

function decodeRouteId(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function createApplicationServer({ host, port, publicDir, sessions, getAgentCatalog, adminToken,
  createMatch, connectRegistration, closeRegistrations, legacyMatchId = null, maxPayload } = {}) {
  let timer = null;
  let stopped = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/agents") {
        sendJson(response, 200, { agents: getAgentCatalog() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/matches") {
        sendJson(response, 200, { matches: [...sessions.values()].map((session) => session.summary()) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/matches") {
        if (!adminToken) { sendJson(response, 503, { error: "match administration is not configured" }); return; }
        if (!authorized(request, adminToken)) { sendJson(response, 401, { error: "invalid admin token" }); return; }
        const body = await readJson(request);
        const result = createMatch(body);
        sendJson(response, 201, result); return;
      }
      const deleteMatch = request.method === "DELETE" && url.pathname.match(/^\/api\/matches\/([^/]+)$/);
      if (deleteMatch) {
        if (!adminToken) { sendJson(response, 503, { error: "match administration is not configured" }); return; }
        if (!authorized(request, adminToken)) { sendJson(response, 401, { error: "invalid admin token" }); return; }
        const id = decodeRouteId(deleteMatch[1]);
        const session = id && sessions.get(id);
        if (!session) { sendJson(response, 404, { error: "match not found" }); return; }
        session.dispose(); sessions.delete(id); sendJson(response, 204); return;
      }
      if (url.pathname.startsWith("/api/")) { sendJson(response, 404, { error: "not found" }); return; }
      if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..")) {
        response.writeHead(404); response.end(); return;
      }
      try {
        const body = readFileSync(join(publicDir, relative));
        response.writeHead(200, { "content-type": contentTypes[extname(relative)] || "application/octet-stream", "cache-control": "no-cache" });
        response.end(body);
      } catch {
        response.writeHead(404); response.end();
      }
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "internal server error" });
    }
  });
  const wss = new WebSocketServer({ noServer: true, ...(maxPayload ? { maxPayload } : {}) });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/register" && connectRegistration) {
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("error", () => { /* Protocol errors close only the offending connection. */ });
        connectRegistration(webSocket);
      });
      return;
    }
    const spectatorRoute = url.pathname.match(/^\/spectate\/([^/]+)$/);
    const agentRoute = url.pathname.match(/^\/agent\/([^/]+)$/);
    const routeId = spectatorRoute ? decodeRouteId(spectatorRoute[1]) : agentRoute ? decodeRouteId(agentRoute[1]) :
      (url.pathname === "/agent" ? url.searchParams.get("match_id") || legacyMatchId : null);
    const session = routeId && sessions.get(routeId);
    if (!session || (!spectatorRoute && !agentRoute && url.pathname !== "/agent")) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on("error", () => { /* Protocol errors close only the offending connection. */ });
      if (spectatorRoute) session.connectSpectator(webSocket);
      else {
        const authorization = request.headers.authorization || "";
        const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
        session.connectAgent(webSocket, url.searchParams.get("player"), bearerToken || url.searchParams.get("token"));
      }
    });
  });

  return {
    server,
    async start() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      timer = setInterval(() => { for (const session of sessions.values()) session.checkPolicies(); }, 25);
      return server.address();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      for (const session of sessions.values()) session.dispose();
      closeRegistrations?.();
      wss.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function createRefereeServer(options = {}) {
  const session = new MatchSession(options);
  const sessions = new Map([[session.id, session]]);
  const application = createApplicationServer({
    host: session.config.host,
    port: session.config.port,
    publicDir: options.publicDir || join(process.cwd(), "public"),
    sessions,
    getAgentCatalog: () => session.config.players.map((id) => ({ id: String(id), label: String(id), status: "available" })),
    legacyMatchId: session.id,
  });
  return { ...application, match: session.match };
}

export function createLobbyServer({ host = "127.0.0.1", port = 0, publicDir = join(process.cwd(), "public"),
  adminToken, agentRegistrationToken, assignmentTimeoutMs = 10000, matchDefaults = {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer from 0 to 65535");
  if (!Number.isInteger(assignmentTimeoutMs) || assignmentTimeoutMs < 1) throw new TypeError("assignment timeout must be positive");
  if (matchDefaults.eventLogPath || matchDefaults.eventLog) {
    throw new TypeError("lobby matchDefaults cannot share an event log; configure per-match storage separately");
  }
  const sessions = new Map();
  const registrations = new Map();
  const assignmentTimers = new Map();
  let application;
  const getAgentCatalog = () => [...registrations.values()].map(({ id, label, status, matchId, connectedAt }) => ({
    id, label, status, match_id: matchId, connected_at: connectedAt,
  })).sort((left, right) => left.label.localeCompare(right.label));
  const sendRegistration = (registration, message) => {
    if (registration.socket.readyState === WebSocket.OPEN) registration.socket.send(JSON.stringify(message));
  };
  const clearAssignmentTimer = (registrationOrId) => {
    const id = typeof registrationOrId === "string" ? registrationOrId : registrationOrId.id;
    clearTimeout(assignmentTimers.get(id));
    assignmentTimers.delete(id);
  };
  const releaseMatch = (session) => {
    for (const player of session.config.players.map(String)) {
      clearAssignmentTimer(player);
      const registration = registrations.get(player);
      if (!registration || registration.matchId !== session.id) continue;
      clearAssignmentTimer(registration);
      registration.status = "releasing";
      sendRegistration(registration, { type: "assignment_released", match_id: session.id });
    }
  };
  const cancelFailedAssignment = (registration) => {
    const session = registration.matchId && sessions.get(registration.matchId);
    clearAssignmentTimer(registration);
    registration.status = "error";
    if (session && session.status !== "finished") {
      session.dispose();
      sessions.delete(session.id);
    }
  };
  const assign = (registration, session) => {
    clearAssignmentTimer(registration);
    registration.status = session.agents.get(registration.id)?.readyState === WebSocket.OPEN ? "busy" : "assigned";
    registration.matchId = session.id;
    if (registration.status === "busy") return;
    sendRegistration(registration, { type: "match_assignment", match_id: session.id, player: registration.id,
      endpoint: `/agent/${encodeURIComponent(session.id)}`, token: session.playerTokens.get(registration.id) });
    assignmentTimers.set(registration.id, setTimeout(() => {
      const current = registrations.get(registration.id);
      const activeSession = sessions.get(session.id);
      if (activeSession && (!current || (current.status === "assigned" && current.matchId === session.id))) {
        if (current) cancelFailedAssignment(current);
        else { activeSession.dispose(); sessions.delete(activeSession.id); }
      }
    }, assignmentTimeoutMs));
  };
  const connectRegistration = (socket) => {
    let registration = null;
    const timeout = setTimeout(() => socket.close(1008, "registration timed out"), 5000);
    socket.once("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1008, "invalid registration"); return; }
      if (!message || message.type !== "register" || typeof message.agent_id !== "string" ||
          !matchIdPattern.test(message.agent_id) ||
          (message.active_match_id != null && (typeof message.active_match_id !== "string" || !matchIdPattern.test(message.active_match_id))) ||
          !equalSecret(message.token, agentRegistrationToken)) {
        socket.close(1008, "invalid registration"); return;
      }
      const existing = registrations.get(message.agent_id);
      if (existing?.socket.readyState === WebSocket.OPEN) { socket.close(1008, "agent already registered"); return; }
      clearTimeout(timeout);
      const label = typeof message.label === "string" && message.label.trim()
        ? message.label.trim().slice(0, 64) : message.agent_id;
      registration = { id: message.agent_id, label, status: "available", matchId: null,
        connectedAt: new Date().toISOString(), socket, lastPongAt: Date.now() };
      registrations.set(registration.id, registration);
      sendRegistration(registration, { type: "registered", agent_id: registration.id });
      const reportedSession = message.active_match_id && sessions.get(message.active_match_id);
      if (message.active_match_id) {
        registration.matchId = message.active_match_id;
        if (reportedSession && reportedSession.status !== "finished") registration.status = "assigned";
        else {
          registration.status = "releasing";
          sendRegistration(registration, { type: "assignment_released", match_id: message.active_match_id });
        }
      } else {
        const pending = [...sessions.values()].find((session) => session.status !== "finished" &&
          session.config.players.map(String).includes(registration.id));
        if (pending) assign(registration, pending);
      }
      socket.on("message", (payload) => {
        let event;
        try { event = JSON.parse(payload.toString()); } catch { return; }
        if (!event || event.match_id !== registration.matchId) return;
        if (event.type === "assignment_started") { clearAssignmentTimer(registration); registration.status = "busy"; }
        if (event.type === "assignment_failed") cancelFailedAssignment(registration);
        if (event.type === "assignment_complete") {
          const session = sessions.get(event.match_id);
          if (!session || session.status === "finished" || session.disposing) {
            clearAssignmentTimer(registration); registration.status = "available"; registration.matchId = null;
          }
        }
      });
      socket.on("pong", () => { registration.lastPongAt = Date.now(); });
      registration.heartbeat = setInterval(() => {
        if (Date.now() - registration.lastPongAt > 45000) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 30000);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (registration) clearInterval(registration.heartbeat);
      if (registration && registrations.get(registration.id)?.socket === socket) registrations.delete(registration.id);
    });
  };
  const createMatch = (body) => {
    if (sessions.has(body?.matchId)) throw Object.assign(new Error("matchId already exists"), { status: 409 });
    const matchToken = randomBytes(24).toString("base64url");
    const catalog = getAgentCatalog();
    const config = matchRequest(body, catalog, matchDefaults, matchToken);
    if (config.players.some((player) => registrations.get(player)?.status !== "available")) {
      throw Object.assign(new Error("selected agents must be online and available"), { status: 409 });
    }
    const playerTokens = Object.fromEntries(config.players.map((player) => [player, randomBytes(24).toString("base64url")]));
    const session = new MatchSession({ ...config, host, port, playerTokens,
      onFinish: releaseMatch, onDispose: releaseMatch }, { waitForPlayers: true });
    sessions.set(session.id, session);
    for (const player of config.players) assign(registrations.get(player), session);
    return { match: session.summary() };
  };
  application = createApplicationServer({ host, port, publicDir, sessions, getAgentCatalog, adminToken, createMatch,
    connectRegistration, closeRegistrations: () => {
      for (const registration of registrations.values()) registration.socket.terminate();
      registrations.clear();
      for (const timer of assignmentTimers.values()) clearTimeout(timer);
      assignmentTimers.clear();
    }, maxPayload: 32 * 1024 });
  return {
    ...application,
    sessions,
    registrations,
    createMatch,
    getMatch(id) { return sessions.get(String(id)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lobby = createLobbyServer({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8080),
    adminToken: process.env.ADMIN_TOKEN,
    agentRegistrationToken: process.env.AGENT_REGISTRATION_TOKEN,
  });
  await lobby.start();
}
