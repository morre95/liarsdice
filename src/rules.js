export const FACES = Object.freeze([1, 2, 3, 4, 5, 6]);
export const DEFAULT_DICE = 5;

export class RulesError extends Error {
  constructor(message) {
    super(message);
    this.name = "RulesError";
  }
}

function integer(value, name) {
  if (!Number.isInteger(value)) throw new RulesError(`${name} must be an integer`);
  return value;
}

function copyState(state) {
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, dice: [...player.dice] })),
    bid: state.bid && { ...state.bid },
    lastResult: state.lastResult && {
      ...state.lastResult,
      bid: state.lastResult.bid && { ...state.lastResult.bid },
      cups: state.lastResult.cups && Object.fromEntries(Object.entries(state.lastResult.cups)
        .map(([id, dice]) => [id, [...dice]])),
      matching: state.lastResult.matching && { ...state.lastResult.matching },
      losers: state.lastResult.losers && [...state.lastResult.losers],
    },
  };
}

// Mulberry32 gives reproducible rolls without relying on platform RNG behavior.
export function seededRng(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function totalDice(players) {
  return players.reduce((total, player) => total + player.diceCount, 0);
}

export function legalBid(previous, bid, diceTotal) {
  if (!bid || !Number.isInteger(bid.quantity) || !FACES.includes(bid.face)) return false;
  if (bid.quantity < 1 || bid.quantity > diceTotal) return false;
  if (!previous) return true;

  if (previous.face === 1) {
    if (bid.face === 1) return bid.quantity > previous.quantity;
    // Leaving ones requires more than twice the previous quantity.
    return bid.quantity >= previous.quantity * 2 + 1;
  }
  if (bid.face === 1) return bid.quantity >= Math.ceil(previous.quantity / 2);
  return bid.quantity > previous.quantity ||
    (bid.quantity === previous.quantity && bid.face > previous.face);
}

export function countMatchingDice(dice, face) {
  return dice.filter((die) => die === face || (face !== 1 && die === 1)).length;
}

export class DiceGame {
  constructor({ players, dicePerPlayer = DEFAULT_DICE, seed = 0, rng, exactCall = false,
    palifico = false, spotOnReward = false } = {}) {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new RulesError("exactly two players are required");
    }
    integer(dicePerPlayer, "dicePerPlayer");
    if (dicePerPlayer < 1) throw new RulesError("dicePerPlayer must be positive");
    for (const [name, value] of Object.entries({ exactCall, palifico, spotOnReward })) {
      if (typeof value !== "boolean") throw new RulesError(`${name} must be a boolean`);
    }
    this.exactCallsEnabled = exactCall; this.palifico = palifico; this.spotOnReward = spotOnReward;
    this.rng = rng ?? seededRng(seed);
    this.state = {
      players: players.map((id) => ({ id: String(id), diceCount: dicePerPlayer, dice: [] })),
      bid: null,
      turn: 0,
      round: 1,
      phase: "bidding",
      starter: 0,
      palifico: palifico && dicePerPlayer === 1,
      palificoFace: null,
      lastResult: null,
    };
    this.roll();
  }

  snapshot() { return copyState(this.state); }

  get activePlayers() { return this.state.players.filter((player) => player.diceCount > 0); }

  roll() {
    for (const player of this.state.players) {
      player.dice = Array.from({ length: player.diceCount }, () => 1 + Math.floor(this.rng() * 6));
    }
  }

  currentPlayer() {
    return this.state.players[this.state.turn];
  }

  placeBid(playerId, bid) {
    if (this.state.phase !== "bidding") throw new RulesError("the round is not accepting bids");
    if (this.currentPlayer().id !== String(playerId)) throw new RulesError("not this player's turn");
    const normalized = { quantity: integer(bid?.quantity, "quantity"), face: integer(bid?.face, "face") };
    if (this.state.palifico && this.state.palificoFace !== null && normalized.face !== this.state.palificoFace) {
      throw new RulesError("palifico bids must use the opening face");
    }
    if (!legalBid(this.state.bid, normalized, totalDice(this.state.players))) {
      throw new RulesError("illegal bid");
    }
    this.state.bid = normalized;
    if (this.state.palifico && this.state.palificoFace === null) this.state.palificoFace = normalized.face;
    this.advanceTurn();
    return this.snapshot();
  }

  challenge(playerId) {
    if (this.state.phase !== "bidding" || !this.state.bid) throw new RulesError("there is no bid to challenge");
    if (this.currentPlayer().id !== String(playerId)) throw new RulesError("not this player's turn");
    const bid = this.state.bid;
    const cups = Object.fromEntries(this.state.players.map((player) => [player.id, [...player.dice]]));
    const faceMatches = this.state.players.reduce((sum, player) =>
      sum + player.dice.filter((die) => die === bid.face).length, 0);
    const wilds = bid.face === 1 ? 0 : this.state.players.reduce((sum, player) =>
      sum + player.dice.filter((die) => die === 1).length, 0);
    const count = faceMatches + wilds;
    const bidderIndex = this.state.turn === 0 ? this.state.players.length - 1 : this.state.turn - 1;
    const loserIndex = count >= bid.quantity ? this.state.turn : bidderIndex;
    const loser = this.state.players[loserIndex];
    const loserSeat = loserIndex;
    loser.diceCount -= 1;
    this.state.lastResult = { bid: { ...bid }, count, challenger: String(playerId), loser: loser.id,
      matching: { face_matches: faceMatches, wilds, total: count }, truth: count >= bid.quantity, cups };
    this.state.players = this.state.players.filter((player) => player.diceCount > 0);
    if (this.state.players.length === 1) {
      this.state.phase = "finished";
      this.state.turn = 0;
      return this.snapshot();
    }
    const survivingLoserSeat = this.state.players.findIndex((player) => player.id === loser.id);
    this.state.starter = survivingLoserSeat === -1
      ? loserSeat % this.state.players.length
      : survivingLoserSeat;
    this.state.turn = this.state.starter;
    this.state.round += 1;
    this.state.bid = null;
    this.state.palifico = this.palifico && this.state.players[this.state.starter].diceCount === 1;
    this.state.palificoFace = null;
    this.roll();
    return this.snapshot();
  }

  exactCall(playerId) {
    if (!this.exactCallsEnabled) throw new RulesError("exact calls are disabled");
    if (this.state.phase !== "bidding" || !this.state.bid) throw new RulesError("there is no bid to call exactly");
    if (this.currentPlayer().id !== String(playerId)) throw new RulesError("not this player's turn");
    const bid = { ...this.state.bid };
    const cups = Object.fromEntries(this.state.players.map((player) => [player.id, [...player.dice]]));
    const count = this.state.players.reduce((sum, player) => sum + player.dice.filter((die) =>
      die === bid.face || (bid.face !== 1 && die === 1)).length, 0);
    const truth = count === bid.quantity;
    const caller = String(playerId);
    const losers = truth ? this.state.players.filter((player) => player.id !== caller && player.diceCount > 0) :
      [this.state.players.find((player) => player.id === caller)];
    for (const loser of losers) loser.diceCount -= 1;
    const reward = truth && this.spotOnReward;
    if (reward) this.state.players.find((player) => player.id === caller).diceCount += 1;
    this.state.lastResult = { bid, count, challenger: caller, loser: losers[0]?.id,
      losers: losers.map((player) => player.id), truth, exact: true, reward, cups };
    this.state.players = this.state.players.filter((player) => player.diceCount > 0);
    if (this.state.players.length === 1) {
      this.state.phase = "finished"; this.state.turn = 0; return this.snapshot();
    }
    this.state.starter = this.state.players.findIndex((player) => player.id === caller);
    this.state.turn = this.state.starter;
    this.state.round += 1; this.state.bid = null;
    this.state.palifico = this.palifico && this.state.players[this.state.starter].diceCount === 1;
    this.state.palificoFace = null;
    this.roll();
    return this.snapshot();
  }

  penalize(playerId, starterPolicy = "penalized") {
    if (this.state.phase !== "bidding") throw new RulesError("the round is not accepting bids");
    const loser = this.state.players.find((player) => player.id === String(playerId));
    if (!loser) throw new RulesError("unknown player");
    loser.diceCount -= 1;
    this.state.lastResult = { type: "penalty", loser: loser.id };
    this.state.players = this.state.players.filter((player) => player.diceCount > 0);
    if (this.state.players.length === 1) {
      this.state.phase = "finished";
      this.state.turn = 0;
      return this.snapshot();
    }
    const penalizedIndex = this.state.players.findIndex((player) => player.id === loser.id);
    const opponentIndex = penalizedIndex === 0 ? 1 : 0;
    this.state.starter = starterPolicy === "opponent" ? opponentIndex : penalizedIndex;
    this.state.turn = this.state.starter;
    this.state.round += 1;
    this.state.bid = null;
    this.state.palifico = this.palifico && this.state.players[this.state.starter].diceCount === 1;
    this.state.palificoFace = null;
    this.roll();
    return this.snapshot();
  }

  advanceTurn() {
    const count = this.state.players.length;
    do this.state.turn = (this.state.turn + 1) % count;
    while (this.state.players[this.state.turn].diceCount === 0);
  }
}
