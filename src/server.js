import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
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

export function createRefereeServer(options = {}) {
  const config = makeConfig(options);
  const replayPath = options.replayPath;
  if (config.eventLogPath) mkdirSync(dirname(config.eventLogPath), { recursive: true });
  const match = new MatchCoordinator({ ...config, eventLog: config.eventLogPath ? { append: (event) => {
    appendFileSync(config.eventLogPath, `${json(event)}\n`, "utf8");
  } } : config.eventLog });
  const agents = new Map();
  const spectators = new Set();
  const replayStreams = new Set();
  let matchEndEmitted = false;
  let spectatorBidHistory = [];
  const publicDir = options.publicDir || join(process.cwd(), "public");
  const contentTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const server = createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
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
  });
  const wss = new WebSocketServer({ noServer: true });
  let timer;
  let announcedRound = match.snapshot().round;

  const turnInfo = (player) => {
    const deadline = config.turnDeadlineMs > 0 ? match.turnStartedAt + config.turnDeadlineMs : null;
    const state = match.snapshot();
    return { current_bid: state.bid && { ...state.bid }, total_dice: state.players.reduce((sum, p) => sum + p.diceCount, 0),
      remaining_time_ms: deadline === null ? null : Math.max(0, deadline - match.now()),
      remaining_token_budget: Number.isFinite(config.tokenBudget) ? Math.max(0, config.tokenBudget - (match.tokenUsage[player] || 0)) : null,
      illegal_retry_count: match.retries[player] || 0, deadline, your_turn_seq: match.turnSeq };
  };

  const agentMessage = (player, event, type = event.type === "illegal_move" ? "move_rejected" : "state_update") => ({
    seq: event.seq,
    type,
    match_id: config.matchId,
    event: event.type,
    actor: event.actor,
    turn: event.turn,
    state: event.state,
    result: event.result,
    reason: event.reason && machineReason(event.reason),
    explanation: event.reason && reasonExplanation(machineReason(event.reason)),
    retry: event.retry,
    penalties: event.penalties,
    ...turnInfo(player),
    table_talk: event.move?.table_talk,
    round_end: event.type === "round_end" && event.round_end ? {
      ...event.round_end,
      cups: { [player]: [...(event.round_end.cups?.[player] || [])] },
    } : undefined,
  });

  const sendRoundStart = () => {
    const state = match.snapshot();
    for (const [player, socket] of agents) {
      if (!state.players.some((candidate) => candidate.id === player)) continue;
      send(socket, { seq: match.seq++, type: "round_start", match_id: config.matchId,
        round: state.round, turn: match.turnSeq, dice: match.privateSnapshot(player), ...turnInfo(player) });
    }
  };

  const sendCurrentTurn = () => {
    const state = match.snapshot();
    if (state.phase === "finished") return;
    const player = state.players[state.turn]?.id;
    const socket = agents.get(player);
    if (socket) send(socket, { seq: match.seq++, type: "your_turn", match_id: config.matchId,
      turn: match.turnSeq, state: visibleState(match), ...turnInfo(player) });
  };

  const spectatorMessage = (event) => {
    const message = { ...event, match_id: config.matchId, private: undefined };
    if ((event.type === "challenge" || event.type === "exact") && !config.omniscientSpectators && event.result) {
      message.result = { bid: event.result.bid && { ...event.result.bid }, challenger: event.result.challenger,
        loser: event.result.loser };
    }
    if (event.type === "round_end" && event.round_end) {
      message.round_end = config.omniscientSpectators ? {
        ...event.round_end,
        cups: Object.fromEntries(Object.entries(event.round_end.cups).map(([id, dice]) => [id, [...dice]])),
       } : { bid: { ...event.round_end.bid }, challenger: event.round_end.challenger, loser: event.round_end.loser,
         exact: event.round_end.exact, losers: event.round_end.losers, reward: event.round_end.reward };
    }
    if (!config.omniscientSpectators) message.state = spectatorState(message.state);
    if (config.omniscientSpectators) message.state = visibleState(match, true);
    if (config.showSpectatorReasoning) {
      const reasoning = Object.fromEntries(Object.entries(event.private || {})
        .filter(([, value]) => value.reasoning !== undefined)
        .map(([player, value]) => [player, value.reasoning]));
      if (Object.keys(reasoning).length) message.reasoning = reasoning;
    }
    return message;
  };

  const broadcast = (event) => {
    if (event.type === "bid" && event.move?.bid) spectatorBidHistory.push({ ...event.move.bid, actor: event.actor });
    for (const [player, socket] of agents) {
      send(socket, agentMessage(player, event));
    }
    const newRound = (event.type === "round_end" || event.type === "penalty") &&
      event.state?.phase !== "finished" && event.state?.round !== announcedRound;
    if (newRound) {
      announcedRound = event.state.round;
      sendRoundStart();
    }
    if (["bid", "round_end", "illegal_move", "penalty"].includes(event.type)) sendCurrentTurn();
    for (const socket of spectators) send(socket, spectatorMessage(event));
    if (event.type === "challenge" || event.type === "exact") spectatorBidHistory = [];
    if (event.state.phase === "finished" && !matchEndEmitted && event.type !== "challenge" && event.type !== "exact") {
      matchEndEmitted = true;
      const finalState = match.snapshot();
      const winner = finalState.players.length === 1 ? finalState.players[0].id :
        (event.type === "forfeit" ? config.players.find((id) => String(id) !== String(event.actor)) : null);
      const record = { seq: match.seq++, type: "match_end", match_id: config.matchId, winner,
        final_counts: Object.fromEntries(config.players.map((id) => [String(id), finalState.players.find((p) => p.id === String(id))?.diceCount || 0])),
        illegal_counts: { ...match.illegalCounts }, token_usage: { ...match.tokenUsage },
        state: visibleState(match), result: event.result || event.state.lastResult };
      if (match.eventLog) match.eventLog.append(record);
      for (const socket of agents.values()) send(socket, record);
      const spectatorRecord = config.omniscientSpectators ? { ...record, state: visibleState(match, true) } : record;
      for (const socket of spectators) send(socket, spectatorRecord);
    }
  };
  const originalEmit = match.emit.bind(match);
  match.emit = (...args) => { const event = originalEmit(...args); broadcast(event); return event; };

  const connectAgent = (socket, player) => {
    if (!config.players.map(String).includes(String(player))) { socket.close(1008, "unknown agent"); return; }
    const existing = agents.get(String(player));
    if (existing && existing.readyState === WebSocket.OPEN) { socket.close(1008, "agent already connected"); return; }
    agents.set(String(player), socket);
    const initial = match.snapshot();
    send(socket, { seq: match.seq++, type: "match_start", match_id: config.matchId, player: String(player),
      seat: config.players.map(String).indexOf(String(player)), players: config.players.map(String),
       rules: { dice_per_player: config.dicePerPlayer, wild_ones: true, exact_call: config.exactCall,
         palifico: config.palifico, spot_on_reward: config.spotOnReward },
      dice_counts: Object.fromEntries(initial.players.map((p) => [p.id, p.diceCount])),
      token_budget: Number.isFinite(config.tokenBudget) ? config.tokenBudget : null,
      state: visibleState(match), ...turnInfo(String(player)) });
    const dice = match.privateSnapshot(player);
    send(socket, { seq: match.seq++, type: "round_start", match_id: config.matchId, round: initial.round,
      turn: match.turnSeq, dice, ...turnInfo(String(player)) });
    if (initial.players[initial.turn]?.id === String(player)) {
      send(socket, { seq: match.seq++, type: "your_turn", match_id: config.matchId,
        turn: match.turnSeq, state: visibleState(match), ...turnInfo(String(player)) });
    }
    socket.on("close", () => { if (agents.get(String(player)) === socket) { agents.delete(String(player)); match.disconnect(player); } });
  };

  wss.on("connection", (socket, request, context) => {
    if (context.kind === "spectator") {
      spectators.add(socket);
      if (replayPath) {
        readReplay(replayPath, { strict: options.replayStrict === true, onMalformed: options.onReplayMalformed }).then((records) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const first = records[0];
          const history = [];
          for (const event of records) {
            if (event.type === "bid" && event.move?.bid) history.push({ ...event.move.bid, actor: event.actor });
            if (event.type === "challenge") history.length = 0;
          }
           send(socket, { seq: first?.seq ?? 0, type: "snapshot", match_id: config.matchId,
             state: spectatorState(first?.state || match.publicSnapshot()), history, replay: true });
          const stream = new ReplayStream(records, { speed: options.replaySpeed ?? 1 });
          replayStreams.add(stream);
          stream.run((event) => {
            if (socket.readyState !== WebSocket.OPEN) { stream.stop(); return; }
             const message = { ...event, match_id: config.matchId, private: undefined, replay: true };
              if ((event.type === "challenge" || event.type === "exact") && !config.omniscientSpectators && event.result) {
               message.result = { bid: event.result.bid && { ...event.result.bid }, challenger: event.result.challenger,
                 loser: event.result.loser };
             }
             if (event.type === "round_end" && event.round_end && !config.omniscientSpectators) {
               message.round_end = { bid: { ...event.round_end.bid }, challenger: event.round_end.challenger,
                 loser: event.round_end.loser };
             }
            if (config.omniscientSpectators && event.private) {
               message.state = { ...event.state, players: event.state.players.map((player) => ({ ...player, dice: event.private[player.id]?.dice })) };
             }
             if (!config.omniscientSpectators) message.state = spectatorState(message.state);
            if (config.showSpectatorReasoning && event.private) {
              const reasoning = Object.fromEntries(Object.entries(event.private)
                .filter(([, value]) => value.reasoning !== undefined).map(([player, value]) => [player, value.reasoning]));
              if (Object.keys(reasoning).length) message.reasoning = reasoning;
            }
            send(socket, message);
          }).finally(() => replayStreams.delete(stream));
          socket.once("close", () => stream.stop());
         }).catch((error) => socket.readyState === WebSocket.OPEN && send(socket, { type: "replay_error", match_id: config.matchId, error: error.message }));
        socket.on("close", () => spectators.delete(socket));
        return;
      }
       send(socket, { seq: match.seq++, type: "snapshot", match_id: config.matchId,
         state: config.omniscientSpectators ? visibleState(match, true) : spectatorState(visibleState(match, false)), history: spectatorBidHistory,
        deadline: match.turnStartedAt + config.turnDeadlineMs });
      socket.on("message", (data) => {
        const text = data.toString();
        match.emit("spectator_message_ignored", null, { message: text.slice(0, 256) });
      });
      socket.on("close", () => spectators.delete(socket));
      return;
    }
    const token = context.token;
    if (token !== config.matchToken) { socket.close(1008, "invalid match token"); return; }
    connectAgent(socket, context.player);
    socket.on("message", (data) => {
      const player = String(context.player);
      try {
         const payload = JSON.parse(data.toString());
         if (!payload || typeof payload !== "object" || payload.match_id !== config.matchId ||
             !Number.isInteger(payload.your_turn_seq)) {
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
          match.submit(player, { ...move, turn: payload.your_turn_seq }, { tokens });
      } catch (error) {
        if (error instanceof MoveValidationError) match.illegal(player, error.code);
        else match.illegal(player, "malformed");
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/spectate/" + encodeURIComponent(config.matchId)) {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, { kind: "spectator" }));
      return;
    }
    if (url.pathname === "/agent") {
      const player = url.searchParams.get("player");
      const token = url.searchParams.get("token");
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, { kind: "agent", player, token }));
      return;
    }
    socket.destroy();
  });

  return {
    server, match,
    async start() { await new Promise((resolve) => server.listen(config.port, config.host, resolve));
      timer = config.turnDeadlineMs || config.disconnectGraceMs ? setInterval(() => {
        match.checkDeadline() || match.checkDisconnects();
      }, 25) : null; return server.address(); },
    async stop() { if (timer) clearInterval(timer); for (const stream of replayStreams) stream.stop(); for (const socket of [...agents.values(), ...spectators]) socket.terminate();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const referee = createRefereeServer({
    host: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 8080),
    matchId: process.env.MATCH_ID || "default", matchToken: process.env.MATCH_TOKEN || "change-me",
    players: (process.env.PLAYERS || "a,b").split(","),
  });
  await referee.start();
}
