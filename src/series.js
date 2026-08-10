import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MatchCoordinator } from "./coordinator.js";

function agentId(agent) {
  const id = agent?.id ?? agent?.name;
  if (id === undefined || id === null || String(id) === "") throw new TypeError("agents require ids");
  return String(id);
}

function getMove(agent, context) {
  if (typeof agent === "function") return agent(context);
  if (typeof agent.move === "function") return agent.move(context);
  if (typeof agent.chooseMove === "function") return agent.chooseMove(context);
  throw new TypeError("agent must be a function or expose move/chooseMove");
}

function publicContext(coordinator, player) {
  const state = coordinator.snapshot();
  return {
    state: {
      ...state,
      players: state.players.map(({ id, diceCount }) => ({ id, diceCount })),
      bid: state.bid && { ...state.bid },
      turn_seq: coordinator.turnSeq,
      lastResult: state.lastResult && { ...state.lastResult, bid: state.lastResult.bid && { ...state.lastResult.bid } },
      tokenUsage: undefined,
    },
    dice: coordinator.privateSnapshot(player),
  };
}

export function runMatch({ agents, seed, players, dicePerPlayer = 5, matchId = "match", eventLog, ...options } = {}) {
  if (!Array.isArray(agents) || agents.length !== 2) throw new TypeError("exactly two agents are required");
  const ids = (players ?? agents.map(agentId)).map(String);
  if (new Set(ids).size !== 2 || ids.length !== 2) throw new TypeError("players must be two distinct ids");
  const byId = new Map(agents.map((agent) => [agentId(agent), agent]));
  if (!ids.every((id) => byId.has(id))) throw new TypeError("players must match agent ids");
  const events = [];
  const coordinator = new MatchCoordinator({ ...options, players: ids, dicePerPlayer, seed,
    matchId, eventLog: (event) => { events.push(event); if (eventLog) eventLog.append(event); } });
  const illegalCounts = Object.fromEntries(ids.map((id) => [id, 0]));

  while (coordinator.snapshot().phase !== "finished") {
    const player = coordinator.game.currentPlayer().id;
    const response = getMove(byId.get(player), publicContext(coordinator, player));
    const move = response?.move ?? response;
    const tokens = response?.move ? response.tokens ?? 0 : 0;
    const before = events.length;
    coordinator.submit(player, move, { tokens });
    for (const event of events.slice(before)) {
      if (event.type === "illegal_move") illegalCounts[player] += 1;
    }
    if (events.length === before) throw new Error("coordinator did not emit an event");
  }
  const final = coordinator.snapshot();
  const winner = final.players.length === 1 ? final.players[0].id : null;
  coordinator.emit("match_end", null, {
    winner,
    final_counts: Object.fromEntries(ids.map((id) => [id, final.players.find((player) => player.id === id)?.diceCount || 0])),
    illegal_counts: { ...illegalCounts },
    token_usage: { ...final.tokenUsage },
  });
  return { matchId, seed, players: ids, winner, phase: final.phase, round: final.round,
    finalState: final, tokenUsage: { ...final.tokenUsage }, illegalCounts, events };
}

export function updateElo(ratings, result, { kFactor = 32 } = {}) {
  const next = { ...ratings };
  const [a, b] = result.players;
  const scoreA = result.winner === a ? 1 : result.winner === b ? 0 : 0.5;
  const expectedA = 1 / (1 + 10 ** ((next[b] - next[a]) / 400));
  next[a] += kFactor * (scoreA - expectedA);
  next[b] += kFactor * ((1 - scoreA) - (1 - expectedA));
  return next;
}

export function runSeries({ agents, seeds, matches = seeds?.length, resultsPath, logDir, ratings = {}, kFactor = 32, ...options } = {}) {
  if (!Array.isArray(agents) || agents.length !== 2) throw new TypeError("exactly two agents are required");
  if (!Array.isArray(seeds) || seeds.length < 1) throw new TypeError("seeds must be a non-empty array");
  if (!Number.isInteger(matches) || matches < 1) throw new TypeError("matches must be positive");
  const ids = agents.map(agentId);
  if (new Set(ids).size !== 2) throw new TypeError("agent ids must be distinct");
  let leaderboard = Object.fromEntries(ids.map((id) => [id, ratings[id] ?? 1500]));
  const results = [];
  for (let index = 0; index < matches; index += 1) {
    const seatAgents = index % 2 === 0 ? agents : [agents[1], agents[0]];
    const seatIds = seatAgents.map(agentId);
    const matchId = String(index + 1);
    const matchLog = logDir ? (() => {
      mkdirSync(logDir, { recursive: true });
      return { append: (event) => appendFileSync(join(logDir, `${matchId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8") };
    })() : undefined;
    const result = runMatch({ ...options, agents: seatAgents, players: seatIds, seed: seeds[index % seeds.length], matchId,
      eventLog: matchLog });
    leaderboard = updateElo(leaderboard, result, { kFactor });
    const record = { ...result, ratings: { ...leaderboard } };
    results.push(record);
    if (resultsPath) {
      mkdirSync(dirname(resultsPath), { recursive: true });
      appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, "utf8");
    }
  }
  return { results, leaderboard };
}
