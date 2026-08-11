# Liar's Dice

An isolated deterministic Liar's Dice engine, referee server, agent protocol, and spectator view.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
npm test
```

The complete test suite is run by `npm test`. The JSON Schema for serializable configuration is in `config.schema.json`. Server options are passed to `createRefereeServer`; `matchId`, `matchToken`, and exactly two `players` are required.

## Deploy To Railway From GitHub

Create an empty GitHub repository, then commit and push this project:

```sh
git status
git add .
git commit -m "Prepare application for deployment"
git remote add origin https://github.com/YOUR_USERNAME/LiarsDice.git
git push -u origin main
```

In [Railway](https://railway.com/), create a new project, choose **Deploy from GitHub repo**, authorize the Railway GitHub App, and select the repository. Railway detects this Node.js application and starts it with `npm start`, so no custom build or start command is required.

Add these service variables in Railway's **Variables** tab:

```dotenv
HOST=0.0.0.0
MATCH_ID=game-1
MATCH_TOKEN=replace-with-a-long-random-secret
PLAYERS=model-a,model-b
```

Do not set `PORT`; Railway provides it automatically. `HOST=0.0.0.0` is required so Railway's public proxy can reach the server.

After the deployment succeeds, open **Settings**, find **Networking -> Public Networking**, and select **Generate Domain**. The spectator view is then available at:

```text
https://YOUR-SERVICE.up.railway.app/?match_id=game-1
```

Agents connect to the public WebSocket endpoint. For example:

```sh
MATCH_TOKEN='your-secret' npm run agent -- \
  --url wss://YOUR-SERVICE.up.railway.app/agent \
  --player model-a \
  --model ./agents/my-model.js
```

The Railway service runs the referee and spectator site; it does not automatically launch model agents. Keep the service at one replica because match state is held in memory. Deployments and restarts reset the active match. Pushes to the connected `main` branch trigger automatic deployments.

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

Connect one agent process per player to `ws://HOST:PORT/agent?player=ID&token=MATCH_TOKEN`. The token is the match secret, not a player secret. The server sends these messages:

- `match_start`: player identity, public state, rules, and resource limits.
- `round_start`: the receiving player's newly rolled private dice. Every connected active player receives this before the first `your_turn` of each round.
- `your_turn`: the public state and authoritative `your_turn_seq` for the next move.
- `state_update`: an accepted move or other public match event.
- `move_rejected`: a structured rejection followed by another `your_turn` when a retry is available.
- `match_end`: winner and final public accounting.

Act only on `your_turn`. Send one canonical move envelope using the supplied `match_id` and `your_turn_seq`:

```json
{
  "match_id": "game-1",
  "your_turn_seq": 4,
  "tokens": 120,
  "move": {
    "action": "bid",
    "turn": 4,
    "bid": {"quantity": 2, "face": 5},
    "table_talk": "I see a pair"
  }
}
```

Use `{"action":"challenge","turn":N}` as the nested `move` to challenge. When `exactCall` is enabled, use `{"action":"exact","turn":N}` for an exact call; a correct call removes one die from every other player, and `spotOnReward` additionally returns a die to the caller. When `palifico` is enabled, a round opened by a one-die player keeps the opening bid face fixed; public state exposes `palifico` and `palificoFace` for the current round. These three variants are disabled by default.

`state.turn` is a player seat index. It is not the move sequence. Always copy `your_turn_seq` into the envelope and move `turn`. Optional `tokens` reports non-negative integer token usage. Optional `reasoning` inside the move is retained privately and is not shown to spectators unless enabled. Invalid moves receive retries, then penalties, and eventually forfeit according to `illegalRetries` and `maxPenalties`.

## Async Model Bridge

`AsyncAgentBridge` in `src/agent-bridge.js` implements the WebSocket protocol for asynchronous local or cloud models. It:

- Caches only the connected player's private dice.
- Waits for current-round dice before invoking the model.
- Supports async functions and objects exposing `move` or `chooseMove`.
- Deduplicates repeated turn notifications while allowing legal retry notifications.
- Uses the authoritative wire turn sequence and discards late model responses.
- Sends the required move envelope and closes after `match_end` by default.

The included CLI loads a provider adapter module. The module must default-export an async or synchronous model function accepting `{ systemPrompt, context }`. It must return JSON text, or `{ text, usage }` / `{ output, tokenUsage }`. The JSON move must include the supplied `context.state.turn_seq`:

```js
// agents/my-model.js
export default async function model({ systemPrompt, context }) {
  const response = await fetch(process.env.MODEL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.MODEL_API_KEY}`,
    },
    body: JSON.stringify({ systemPrompt, context }),
  });
  if (!response.ok) throw new Error(`model request failed: ${response.status}`);
  return response.json(); // For example: { text: "{...}", usage: { total_tokens: 120 } }
}
```

Keep provider-specific SDK calls and API keys in this adapter. The referee and bridge do not need the provider credential.

Start a match:

```sh
MATCH_ID=game-1 MATCH_TOKEN=replace-with-a-secret PLAYERS=model-a,model-b npm run server
```

In two other terminals, connect both model agents:

```sh
PLAYER=model-a MATCH_TOKEN=replace-with-a-secret MODEL_MODULE=./agents/my-model.js npm run agent
PLAYER=model-b MATCH_TOKEN=replace-with-a-secret MODEL_MODULE=./agents/my-model.js npm run agent
```

The CLI defaults to `ws://127.0.0.1:8080/agent`. Use `REFEREE_URL`, or command-line flags when connecting elsewhere:

```sh
MATCH_TOKEN=replace-with-a-secret npm run agent -- --url wss://game.example/agent \
  --player model-a --model ./agents/my-model.js
```

Prefer `MATCH_TOKEN` because passing `--token` can expose the shared secret through shell history and process listings.

Use the bridge directly when the agent is already constructed:

```js
import { connectAgentBridge } from "./src/agent-bridge.js";
import { LlmAgent } from "./src/llm-agent.js";
import model from "./agents/my-model.js";

const bridge = await connectAgentBridge({
  url: "ws://127.0.0.1:8080/agent",
  player: "model-a",
  token: process.env.MATCH_TOKEN,
  agent: new LlmAgent({ id: "model-a", model }),
  onError: (error) => console.error(error.message),
});

await bridge.waitForClose();
```

Run `npm run agent -- --help` for all CLI options. A model failure or malformed response is submitted as an intentionally illegal move so the referee's normal retry and penalty policy remains authoritative.

## Live Spectator

Open `http://HOST:PORT/` while the server is running. The view connects read-only to `ws://HOST:PORT/spectate/MATCH_ID` and renders public state, bids, challenge reveals, dice counts, table talk, and optional reasoning. Spectators do not authenticate and cannot submit moves. Set `omniscientSpectators` only for a trusted audience; keep `showSpectatorReasoning` off by default.

## Security And Privacy

Use a non-default, high-entropy `matchToken` and bind `host` narrowly when running outside a private network. Agent URLs contain the token, so do not share them or log them. Normal spectator events hide dice and reasoning; event logs contain private dice and optional reasoning and must be access-controlled. JSONL logs are append-only and can be replayed, so treat them as sensitive match records. This server does not provide TLS, identity management, or persistent token storage; put it behind a suitably configured TLS/authentication proxy for untrusted networks.

## API Notes

`runMatch` and `runSeries` are exported from `src/series.js`; `AsyncAgentBridge` and `connectAgentBridge` are exported from `src/agent-bridge.js`; `LlmAgent` is exported from `src/llm-agent.js`; `HeuristicAgent` is exported from `src/heuristic-agent.js`; `readReplay`, `ReplayStream`, and `streamReplay` are exported from `src/replay.js`. Function options such as `eventLog`, `rng`, `now`, `countTokens`, and `onReplayMalformed` are programmatic hooks and are intentionally not JSON configuration fields. Variant configuration is represented by `exactCall`, `palifico`, and `spotOnReward` in `config.schema.json`.
