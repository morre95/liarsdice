export function renderModel(state, event, model = {}) {
  const next = { ...model, state: state || model.state, history: model.history ? [...model.history] : [], talk: model.talk ? [...model.talk] : [], reasoning: { ...(model.reasoning || {}) } };
  if (!state) return next;
  if (Array.isArray(event?.history)) next.history = event.history.map((bid) => ({ ...bid }));
  if (event?.type === "bid" && event.move?.bid) next.history.push({ ...event.move.bid, actor: event.actor, round: state.round });
  if (event?.type === "round_end" && event.round_end) next.reveal = { ...event.round_end };
  if (event?.type === "bid") next.reveal = undefined;
  if (event?.move?.table_talk) next.talk.push({ actor: event.actor, text: event.move.table_talk });
  for (const [actor, value] of Object.entries(event?.reasoning || {})) next.reasoning[actor] = value;
  if (model.state && state.round !== model.state.round) { next.history = []; next.talk = []; }
  if (event?.type === "match_end" || event?.status === "finished" || state.phase === "finished") next.finished = true;
  return next;
}

export function resolveMatchId(locationLike) {
  return new URLSearchParams(locationLike.search).get("match_id") || null;
}

export function spectatorSocketUrl(locationLike, matchId) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}/spectate/${encodeURIComponent(matchId)}`;
}

const $ = (id) => document.getElementById(id);
const text = (node, value) => { node.textContent = value == null ? "" : String(value); };
let socket = null;
let model = {};
let lobbyTimer = null;

function renderCups(state, revealedCups = null) {
  const cups = $("cups"); cups.replaceChildren();
  for (const player of state.players || []) {
    const cup = document.createElement("article");
    cup.className = `cup${state.players[state.turn]?.id === player.id ? " active" : ""}`;
    const header = document.createElement("div"); header.className = "cup-header";
    const title = document.createElement("h2"); text(title, player.id);
    const count = document.createElement("span"); count.className = "count"; text(count, `${player.diceCount} ${player.diceCount === 1 ? "die" : "dice"}`);
    header.append(title, count); cup.append(header);
    const dice = document.createElement("div"); dice.className = "dice";
    const values = revealedCups?.[player.id] || (Array.isArray(player.dice) ? player.dice : Array.from({ length: player.diceCount || 0 }, () => null));
    for (const value of values) {
      const die = document.createElement("span"); die.className = `die${value == null ? " hidden" : ""}`;
      text(die, value == null ? "?" : value); die.setAttribute("aria-label", value == null ? "Hidden die" : `Die showing ${value}`); dice.append(die);
    }
    cup.append(dice); cups.append(cup);
  }
}

function render(modelValue) {
  const state = modelValue.state; if (!state) return;
  text($("round"), state.round); text($("total-dice"), (state.players || []).reduce((sum, player) => sum + player.diceCount, 0));
  text($("turn"), state.phase === "finished" ? "finished" : state.players?.[state.turn]?.id || "--"); renderCups(state, modelValue.reveal?.cups);
  const ladder = $("ladder"); ladder.replaceChildren();
  for (const [index, bid] of modelValue.history.entries()) {
    const row = document.createElement("div"); row.className = `ladder-row${index === modelValue.history.length - 1 ? " latest" : ""}`; row.style.marginLeft = `${Math.min(index * 4, 32)}px`;
    const value = document.createElement("span"); value.className = "bid"; text(value, `${bid.quantity} × ${bid.face}s`);
    const actor = document.createElement("span"); actor.className = "actor"; text(actor, bid.actor); row.append(value, actor); ladder.append(row);
  }
  if (!modelValue.history.length) { ladder.className = "ladder empty"; text(ladder, "No bids this round."); } else ladder.className = "ladder";
  text($("current-bid"), state.bid ? `${state.bid.quantity} × ${state.bid.face}s` : "No bid");
  const reveal = modelValue.reveal; const revealNode = $("reveal"); revealNode.replaceChildren(); revealNode.className = `reveal${reveal ? "" : " empty"}`;
  if (reveal) {
    const line = document.createElement("strong"); text(line, reveal.matching ? `${reveal.matching.total} matching dice` : `${reveal.loser} loses the challenge`); revealNode.append(line);
    const detail = document.createElement("div"); text(detail, `Bid: ${reveal.bid.quantity} × ${reveal.bid.face}s`); revealNode.append(detail);
    if (reveal.matching) {
      const arithmetic = document.createElement("div"); text(arithmetic, `${reveal.matching.face_matches} face matches + ${reveal.matching.wilds} wilds = ${reveal.matching.total}`); revealNode.append(arithmetic);
    }
    const result = document.createElement("p"); result.className = "loss"; text(result, `${reveal.loser} loses a die.`); revealNode.append(result); text($("reveal-state"), "Resolved");
  } else { text(revealNode, "The table is still bidding."); text($("reveal-state"), "Awaiting reveal"); }
  const talk = $("talk"); talk.replaceChildren(); talk.className = `talk${modelValue.talk.length ? "" : " empty"}`;
  for (const item of modelValue.talk.slice(-8)) { const bubble = document.createElement("div"); bubble.className = "bubble"; const who = document.createElement("b"); text(who, item.actor); bubble.append(who, document.createTextNode(item.text)); talk.append(bubble); }
  if (!modelValue.talk.length) text(talk, "Quiet table.");
  const reasoningPanel = $("reasoning-panel"); const reasoning = $("reasoning"); reasoningPanel.classList.toggle("visible", Object.keys(modelValue.reasoning).length > 0);
  reasoning.replaceChildren(); for (const [actor, thought] of Object.entries(modelValue.reasoning)) { const paragraph = document.createElement("p"); text(paragraph, `${actor}: ${thought}`); reasoning.append(paragraph); }
  if (modelValue.finished) { text($("connection"), "Match finished"); $("connection").className = "connection"; }
}

function resetTable() {
  model = {};
  for (const id of ["round", "total-dice", "turn"]) text($(id), "--");
  $("cups").replaceChildren();
  text($("current-bid"), "No bid"); text($("ladder"), "No bids this round."); $("ladder").className = "ladder empty";
  text($("reveal"), "The table is still bidding."); $("reveal").className = "reveal empty";
  text($("talk"), "Quiet table."); $("talk").className = "talk empty";
  $("reasoning-panel").classList.remove("visible");
}

function connect(matchId) {
  if (socket) socket.close(1000, "changing view");
  resetTable();
  text($("match-label"), matchId); text($("connection"), "Connecting"); $("connection").className = "connection";
  const active = new WebSocket(spectatorSocketUrl(location, matchId)); socket = active;
  active.onopen = () => { if (socket === active) { $("connection").className = "connection live"; text($("connection"), "Live"); } };
  active.onclose = () => { if (socket === active && !model.finished) { $("connection").className = "connection error"; text($("connection"), "Disconnected"); } };
  active.onerror = () => { if (socket === active) { $("connection").className = "connection error"; text($("connection"), "Connection error"); } };
  active.onmessage = ({ data }) => {
    if (socket !== active) return;
    try { const event = JSON.parse(data); model = renderModel(event.state, event, model); render(model); } catch { text($("connection"), "Invalid server message"); }
  };
}

function matchCard(match, index) {
  const article = document.createElement("article"); article.className = "match-card"; article.style.animationDelay = `${Math.min(index * 45, 250)}ms`;
  const info = document.createElement("div");
  const meta = document.createElement("div"); meta.className = "match-meta";
  const id = document.createElement("span"); id.className = "match-id"; text(id, match.id);
  const status = document.createElement("span"); status.className = `status-pill ${match.status}`; text(status, match.status);
  const round = document.createElement("span"); text(round, `Round ${match.round}`); meta.append(id, status, round);
  const versus = document.createElement("div"); versus.className = "versus";
  const first = document.createElement("b"); text(first, match.players[0]); const marker = document.createElement("i"); text(marker, "VERSUS"); const second = document.createElement("b"); text(second, match.players[1]); versus.append(first, marker, second); info.append(meta, versus);
  const watch = document.createElement("a"); watch.className = "watch-link"; watch.href = match.spectator_url; watch.dataset.matchId = match.id; text(watch, "Watch table →");
  article.append(info, watch); return article;
}

async function loadLobby() {
  try {
    const [matchesResponse, agentsResponse] = await Promise.all([fetch("/api/matches"), fetch("/api/agents")]);
    if (!matchesResponse.ok || !agentsResponse.ok) throw new Error("Lobby is unavailable");
    const { matches } = await matchesResponse.json(); const { agents } = await agentsResponse.json();
    const list = $("match-list"); list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div"); empty.className = "empty-table"; empty.innerHTML = "<span aria-hidden=\"true\">□</span><p>No tables yet. Create the opening match.</p>"; list.append(empty);
    } else matches.forEach((match, index) => list.append(matchCard(match, index)));
    const available = agents.filter((agent) => agent.status === "available");
    for (const select of [$("player-one"), $("player-two")]) {
      const current = select.value; select.replaceChildren();
      if (!agents.length) { const option = document.createElement("option"); option.value = ""; text(option, "No agents registered"); select.append(option); }
      for (const agent of agents) {
        const option = document.createElement("option"); option.value = agent.id; option.disabled = agent.status !== "available";
        text(option, `${agent.label} · ${agent.status}`); select.append(option);
      }
      if (available.some((agent) => agent.id === current)) select.value = current;
      else select.value = available[0]?.id || "";
    }
    if (available.length > 1 && $("player-one").value === $("player-two").value) $("player-two").value = available[1].id;
    $("match-form").querySelector("button[type=submit]").disabled = available.length < 2;
  } catch (error) {
    const list = $("match-list"); list.replaceChildren(); const empty = document.createElement("div"); empty.className = "empty-table"; const message = document.createElement("p"); text(message, error.message); empty.append(message); list.append(empty);
  }
}

function showLobby(push = false) {
  if (push) history.pushState({}, "", location.pathname);
  if (socket) { const closing = socket; socket = null; closing.close(1000, "returning to lobby"); }
  $("lobby-view").hidden = false; $("spectator-view").hidden = true;
  if (lobbyTimer) clearInterval(lobbyTimer); loadLobby(); lobbyTimer = setInterval(loadLobby, 5000);
}

function showMatch(matchId, push = false) {
  if (push) history.pushState({}, "", `?match_id=${encodeURIComponent(matchId)}`);
  if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
  $("lobby-view").hidden = true; $("spectator-view").hidden = false; connect(matchId);
  $("spectator-view").querySelector("h1").focus?.();
}

async function createMatch(event) {
  event.preventDefault();
  const form = event.currentTarget; const button = form.querySelector("button[type=submit]");
  const status = $("form-status"); status.className = "form-status"; text(status, "Creating table..."); button.disabled = true;
  const players = [$("player-one").value, $("player-two").value];
  if (players[0] === players[1]) { status.className = "form-status error"; text(status, "Choose two different agents."); button.disabled = false; return; }
  try {
    const response = await fetch("/api/matches", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${$("admin-token").value}` }, body: JSON.stringify({
      matchId: $("match-id").value, players, dicePerPlayer: Number($("dice-count").value),
      exactCall: form.elements.exactCall.checked, palifico: form.elements.palifico.checked, spotOnReward: form.elements.spotOnReward.checked,
    }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not create match");
    status.className = "form-status success"; text(status, "Match created. Assignments sent to both agents.");
    text($("assignment-message"), `${players[0]} and ${players[1]} received private assignments for ${result.match.id}.`);
    $("credentials").hidden = false; $("match-id").value = ""; await loadLobby();
  } catch (error) { status.className = "form-status error"; text(status, error.message); }
  finally { button.disabled = !$("player-one").value || !$("player-two").value || $("player-one").value === $("player-two").value; }
}

function initialize() {
  document.addEventListener("click", (event) => {
    const lobbyLink = event.target.closest("[data-lobby-link]"); const watchLink = event.target.closest("[data-match-id]");
    if (lobbyLink) { event.preventDefault(); showLobby(true); }
    if (watchLink) { event.preventDefault(); showMatch(watchLink.dataset.matchId, true); }
  });
  $("refresh-matches").addEventListener("click", loadLobby); $("match-form").addEventListener("submit", createMatch);
  window.addEventListener("popstate", () => { const id = resolveMatchId(location); if (id) showMatch(id); else showLobby(); });
  const matchId = resolveMatchId(location); if (matchId) showMatch(matchId); else showLobby();
}

if (typeof document !== "undefined") initialize();
