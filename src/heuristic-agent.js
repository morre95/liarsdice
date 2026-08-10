import { legalBid, totalDice } from "./rules.js";

// A deliberately small, deterministic reference policy.  The agent only
// needs its own dice and the public bid to make a move.
export class HeuristicAgent {
  constructor({ id, expectedThreshold = 0 } = {}) {
    if (id === undefined || id === null || String(id) === "") throw new TypeError("agent id is required");
    if (typeof expectedThreshold !== "number" || !Number.isFinite(expectedThreshold) || expectedThreshold < 0) {
      throw new TypeError("expectedThreshold must be a non-negative number");
    }
    this.id = String(id);
    this.expectedThreshold = expectedThreshold;
  }

  expectedCount({ dice, bid, players }) {
    const face = bid?.face ?? this.preferredFace(dice);
    const own = dice.filter((die) => die === face || (face !== 1 && die === 1)).length;
    const otherDice = players.filter((player) => player.id !== this.id)
      .reduce((sum, player) => sum + player.diceCount, 0);
    return own + otherDice * (face === 1 ? 1 / 6 : 1 / 3);
  }

  preferredFace(dice) {
    const counts = [1, 2, 3, 4, 5, 6].map((face) =>
      dice.filter((die) => die === face || (face !== 1 && die === 1)).length);
    return counts.reduce((best, count, index) => count > counts[best - 1] ? index + 1 : best, 1);
  }

  chooseMove({ state, dice }) {
    const turn = Number.isInteger(state.turn_seq) ? state.turn_seq : state.turn;
    const current = state.bid;
    if (current && current.quantity < this.expectedCount({ dice, bid: current, players: state.players }) + this.expectedThreshold) {
      return { action: "challenge", turn };
    }

    const diceTotal = totalDice(state.players);
    const target = current
      ? Math.max(current.quantity + (current.face === 6 ? 1 : 0), Math.ceil(this.expectedCount({ dice, bid: current, players: state.players })))
      : Math.max(1, Math.ceil(this.expectedCount({ dice, bid: null, players: state.players })));
    const bids = [];
    for (let quantity = target; quantity <= diceTotal; quantity += 1) {
      for (let face = 1; face <= 6; face += 1) {
        const candidate = { quantity, face };
        if (legalBid(current, candidate, diceTotal)) bids.push(candidate);
      }
      if (bids.length) return { action: "bid", bid: bids[0], turn };
    }
    return current ? { action: "challenge", turn } : { action: "bid", bid: { quantity: 1, face: 1 }, turn };
  }

  move(context) { return this.chooseMove(context); }
}

export function createHeuristicAgent(options) { return new HeuristicAgent(options); }
