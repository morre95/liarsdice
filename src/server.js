import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { WebSocketServer } from "ws";
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

function normalizeAgents(agents) {
  if (!Array.isArray(agents) || agents.length < 2) throw new TypeError("at least two agents are required");
  const normalized = agents.map((agent) => {
    if (typeof agent === "string") return { id: agent, label: agent };
    return { id: String(agent?.id ?? ""), label: String(agent?.label ?? agent?.id ?? "") };
  });
  if (normalized.some((agent) => !agent.id || !matchIdPattern.test(agent.id)) ||
      new Set(normalized.map((agent) => agent.id)).size !== normalized.length) {
    throw new TypeError("agents require unique URL-safe ids");
  }
  return normalized;
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
    throw Object.assign(new Error("players must contain two distinct configured agent ids"), { status: 400 });
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

function createApplicationServer({ host, port, publicDir, sessions, agentCatalog, adminToken,
  createMatch, legacyMatchId = null, maxPayload } = {}) {
  let timer = null;
  let stopped = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/agents") {
        sendJson(response, 200, { agents: agentCatalog }); return;
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
    const spectatorRoute = url.pathname.match(/^\/spectate\/([^/]+)$/);
    const agentRoute = url.pathname.match(/^\/agent\/([^/]+)$/);
    const routeId = spectatorRoute ? decodeRouteId(spectatorRoute[1]) : agentRoute ? decodeRouteId(agentRoute[1]) :
      (url.pathname === "/agent" ? url.searchParams.get("match_id") || legacyMatchId : null);
    const session = routeId && sessions.get(routeId);
    if (!session || (!spectatorRoute && !agentRoute && url.pathname !== "/agent")) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on("error", () => { /* Protocol errors close only the offending connection. */ });
      if (spectatorRoute) session.connectSpectator(webSocket);
      else session.connectAgent(webSocket, url.searchParams.get("player"), url.searchParams.get("token"));
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
    agentCatalog: session.config.players.map((id) => ({ id: String(id), label: String(id) })),
    legacyMatchId: session.id,
  });
  return { ...application, match: session.match };
}

export function createLobbyServer({ host = "127.0.0.1", port = 0, publicDir = join(process.cwd(), "public"),
  agents = ["a", "b"], adminToken, matchDefaults = {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer from 0 to 65535");
  if (matchDefaults.eventLogPath || matchDefaults.eventLog) {
    throw new TypeError("lobby matchDefaults cannot share an event log; configure per-match storage separately");
  }
  const agentCatalog = normalizeAgents(agents);
  const sessions = new Map();
  let application;
  const createMatch = (body) => {
    if (sessions.has(body?.matchId)) throw Object.assign(new Error("matchId already exists"), { status: 409 });
    const matchToken = randomBytes(24).toString("base64url");
    const config = matchRequest(body, agentCatalog, matchDefaults, matchToken);
    const playerTokens = Object.fromEntries(config.players.map((player) => [player, randomBytes(24).toString("base64url")]));
    const session = new MatchSession({ ...config, host, port, playerTokens }, { waitForPlayers: true });
    sessions.set(session.id, session);
    return {
      match: session.summary(),
      connection: { endpoint: `/agent/${encodeURIComponent(session.id)}`,
        credentials: config.players.map((player) => ({ player, token: playerTokens[player] })) },
    };
  };
  application = createApplicationServer({ host, port, publicDir, sessions, agentCatalog, adminToken, createMatch,
    maxPayload: 32 * 1024 });
  return {
    ...application,
    sessions,
    createMatch,
    getMatch(id) { return sessions.get(String(id)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agents = (process.env.AGENTS || process.env.PLAYERS || "a,b").split(",").map((id) => id.trim()).filter(Boolean);
  const lobby = createLobbyServer({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8080),
    agents,
    adminToken: process.env.ADMIN_TOKEN,
  });
  await lobby.start();
}
