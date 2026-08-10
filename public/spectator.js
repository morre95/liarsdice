/* The viewer is intentionally a plain module so it can be hosted by any static server. */
export function renderModel(state, event, model = {}) {
  const next = { ...model, state: state || model.state, history: model.history ? [...model.history] : [], talk: model.talk ? [...model.talk] : [], reasoning: { ...(model.reasoning || {}) } };
  if (!state) return next;
  if (Array.isArray(event?.history)) next.history = event.history.map((bid) => ({ ...bid }));
  if (event?.type === "bid" && event.move?.bid) next.history.push({ ...event.move.bid, actor: event.actor, round: state.round });
  if (event?.type === "round_end" && event.round_end?.matching) next.reveal = { ...event.round_end };
  if (event?.type === "bid") next.reveal = undefined;
  if (event?.move?.table_talk) next.talk.push({ actor: event.actor, text: event.move.table_talk });
  for (const [actor, text] of Object.entries(event?.reasoning || {})) next.reasoning[actor] = text;
  if (model.state && state.round !== model.state.round) { next.history = []; next.talk = []; }
  return next;
}

const $ = (id) => document.getElementById(id);
const text = (node, value) => { node.textContent = value == null ? "" : String(value); };

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
    for (const value of values) { const die = document.createElement("span"); die.className = `die${value == null ? " hidden" : ""}`; text(die, value == null ? "?" : value); dice.append(die); }
    cup.append(dice); cups.append(cup);
  }
}

function render(model) {
  const state = model.state; if (!state) return;
  text($("round"), state.round); text($("total-dice"), (state.players || []).reduce((sum, player) => sum + player.diceCount, 0));
  text($("turn"), state.players?.[state.turn]?.id || "finished"); renderCups(state, model.reveal?.cups);
  const ladder = $("ladder"); ladder.replaceChildren();
  for (const [index, bid] of model.history.entries()) {
    const row = document.createElement("div"); row.className = `ladder-row${index === model.history.length - 1 ? " latest" : ""}`;
    row.style.marginLeft = `${Math.min(index * 4, 32)}px`;
    const value = document.createElement("span"); value.className = "bid"; text(value, `${bid.quantity} × ${bid.face}s`);
    const actor = document.createElement("span"); actor.className = "actor"; text(actor, bid.actor); row.append(value, actor); ladder.append(row);
  }
  if (!model.history.length) { ladder.className = "ladder empty"; text(ladder, "No bids this round."); } else ladder.className = "ladder";
  text($("current-bid"), state.bid ? `${state.bid.quantity} × ${state.bid.face}s` : "No bid");
  const reveal = model.reveal; const revealNode = $("reveal"); revealNode.replaceChildren(); revealNode.className = `reveal${reveal ? "" : " empty"}`;
  if (reveal) {
    const line = document.createElement("strong"); text(line, `${reveal.matching.total} matching dice`); revealNode.append(line);
    const detail = document.createElement("div"); text(detail, `Bid: ${reveal.bid.quantity} × ${reveal.bid.face}s`); revealNode.append(detail);
    const arithmetic = document.createElement("div"); text(arithmetic, `${reveal.matching.face_matches} face matches + ${reveal.matching.wilds} wilds = ${reveal.matching.total}`); revealNode.append(arithmetic);
    const result = document.createElement("p"); const winner = reveal.loser === reveal.challenger ? "bidder" : "challenger"; result.className = winner === "challenger" ? "win" : "loss"; text(result, `${winner} wins. ${reveal.loser} loses a die.`); revealNode.append(result); text($("reveal-state"), "Resolved");
  } else { text(revealNode, "The table is still bidding."); text($("reveal-state"), "Awaiting reveal"); }
  const talk = $("talk"); talk.replaceChildren(); talk.className = `talk${model.talk.length ? "" : " empty"}`;
  for (const item of model.talk.slice(-8)) { const bubble = document.createElement("div"); bubble.className = "bubble"; const who = document.createElement("b"); text(who, item.actor); bubble.append(who, document.createTextNode(item.text)); talk.append(bubble); }
  if (!model.talk.length) text(talk, "Quiet table.");
  const reasoningPanel = $("reasoning-panel"); const reasoning = $("reasoning"); reasoningPanel.classList.toggle("visible", Object.keys(model.reasoning).length > 0);
  reasoning.replaceChildren(); for (const [actor, thought] of Object.entries(model.reasoning)) { const paragraph = document.createElement("p"); text(paragraph, `${actor}: ${thought}`); reasoning.append(paragraph); }
}

function connect() {
  const id = new URLSearchParams(location.search).get("match_id") || location.pathname.split("/").filter(Boolean).pop() || "default";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/spectate/${encodeURIComponent(id)}`); let model = {};
  socket.onopen = () => { $("connection").className = "connection live"; text($("connection"), "Live"); };
  socket.onclose = () => { $("connection").className = "connection error"; text($("connection"), "Disconnected"); };
  socket.onerror = () => { $("connection").className = "connection error"; text($("connection"), "Connection error"); };
  socket.onmessage = ({ data }) => { const event = JSON.parse(data); model = renderModel(event.state, event, model); render(model); };
}

if (typeof document !== "undefined") connect();
