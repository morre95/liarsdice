# Liar's Dice

An isolated deterministic Liar's Dice engine, referee server, agent protocol, and spectator view.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
npm test
```

The complete test suite is run by `npm test`. The JSON Schema for serializable configuration is in `config.schema.json`. Server options are passed to `createRefereeServer`; `matchId`, `matchToken`, and exactly two `players` are required.

## Commands

Start the referee and spectator site with `npm run server` (or `npm start`). The standalone server reads `HOST`, `PORT`, `MATCH_ID`, `MATCH_TOKEN`, and `PLAYERS` from the environment.

Run a deterministic headless heuristic series:

```sh
npm run series -- --matches 4 --seeds 17,23 --dice 2 --results data/series.jsonl
npm run series -- --matches 4 --seeds 17,23 --dice 2 --log-dir data/matches --results data/series.jsonl
```

The command prints one JSON result containing match records and the Elo leaderboard. Seats alternate each match and seeds repeat when there are fewer seeds than matches. `--log-dir` is optional and writes one reconstructable private event log per match; `--results` is optional and writes append-only per-match result JSONL.

Replay an event log to stdout at normal speed, or disable timing with speed `0`:

```sh
npm run replay -- data/match.jsonl 1
npm run replay -- data/match.jsonl 0
```

## Agent Protocol

Connect an agent to `ws://HOST:PORT/agent?player=ID&token=MATCH_TOKEN`. The token is the match secret, not a player secret. The server sends `match_start` and `round_start`, including only that player's dice. On the player's turn, send exactly one JSON object:

```json
{"action":"bid","turn":0,"bid":{"quantity":1,"face":2},"table_talk":"I see a pair"}
```

Use `{"action":"challenge","turn":N}` to challenge. When `exactCall` is enabled, use `{"action":"exact","turn":N}` for an exact call; a correct call removes one die from every other player, and `spotOnReward` additionally returns a die to the caller. When `palifico` is enabled, a round opened by a one-die player keeps the opening bid face fixed. These three variants are disabled by default. `turn` must match the supplied turn sequence. Optional `reasoning` is retained privately and is not shown to spectators unless enabled. Invalid moves receive retries, then penalties, and eventually forfeit according to `illegalRetries` and `maxPenalties`.

## Live Spectator

Open `http://HOST:PORT/` while the server is running. The view connects read-only to `ws://HOST:PORT/spectate/MATCH_ID` and renders public state, bids, challenge reveals, dice counts, table talk, and optional reasoning. Spectators do not authenticate and cannot submit moves. Set `omniscientSpectators` only for a trusted audience; keep `showSpectatorReasoning` off by default.

## Security And Privacy

Use a non-default, high-entropy `matchToken` and bind `host` narrowly when running outside a private network. Agent URLs contain the token, so do not share them or log them. Normal spectator events hide dice and reasoning; event logs contain private dice and optional reasoning and must be access-controlled. JSONL logs are append-only and can be replayed, so treat them as sensitive match records. This server does not provide TLS, identity management, or persistent token storage; put it behind a suitably configured TLS/authentication proxy for untrusted networks.

## API Notes

`runMatch` and `runSeries` are exported from `src/series.js`; `HeuristicAgent` is exported from `src/heuristic-agent.js`; `readReplay`, `ReplayStream`, and `streamReplay` are exported from `src/replay.js`. Function options such as `eventLog`, `rng`, `now`, `countTokens`, and `onReplayMalformed` are programmatic hooks and are intentionally not JSON configuration fields. Variant configuration is represented by `exactCall`, `palifico`, and `spotOnReward` in `config.schema.json`.
