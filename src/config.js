export const DEFAULT_CONFIG = Object.freeze({
  host: "127.0.0.1",
  port: 0,
  dicePerPlayer: 5,
  turnDeadlineMs: 0,
  disconnectGraceMs: 0,
  illegalRetries: 2,
  maxPenalties: 3,
  penaltyStarter: "penalized",
  tokenBudget: Infinity,
  omniscientSpectators: false,
  showSpectatorReasoning: false,
  maxMoveBytes: 16 * 1024,
  exactCall: false,
  palifico: false,
  spotOnReward: false,
});

export function makeConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (config.tokenBudget === null) config.tokenBudget = Infinity;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new TypeError("port must be an integer from 0 to 65535");
  }
  if (!Array.isArray(config.players) || config.players.length !== 2) {
    throw new TypeError("players must contain exactly two agents");
  }
  if (typeof config.matchId !== "string" || !config.matchId) throw new TypeError("matchId is required");
  if (typeof config.matchToken !== "string" || !config.matchToken) throw new TypeError("matchToken is required");
  for (const key of ["exactCall", "palifico", "spotOnReward"]) {
    if (typeof config[key] !== "boolean") throw new TypeError(`${key} must be a boolean`);
  }
  return config;
}
