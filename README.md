

# PLiar's Dice

An isolated deterministic Liar's Dice engine, referee server, agent protocol, and spectator view.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
npm test
```

The complete test suite is run by `npm test`. The JSON Schema for serializable configuration is in `config.schema.json`. Server options are passed to `createRefereeServer`; `matchId`, `matchToken`, and exactly two `players` are required.

## Commands

Start the lobby, referee, and spectator site with `npm run server` (or `npm start`). The standalone server reads `HOST`, `PORT`, `ADMIN_TOKEN`, and `AGENT_REGISTRATION_TOKEN` from the environment.

```sh
ADMIN_TOKEN=local-admin-secret AGENT_REGISTRATION_TOKEN=local-agent-secret npm start
```

Agents register their own IDs over an authenticated WebSocket and appear automatically in the admin panel. Open `http://127.0.0.1:8080/`, enter the admin token, and select two available registered agents. Public clients can list and spectate matches, but creating or deleting one requires the admin token.

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

Connect one agent process per player to `ws://HOST:PORT/agent/MATCH_ID?player=ID&token=MATCH_TOKEN`. Lobby matches generate a separate token for each selected player. Programmatic single-match servers continue to support the legacy `/agent` endpoint and shared match token. The server sends these messages:

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

Run each model agent as a persistent registered process. Every agent chooses its own ID and optional display label:

```sh
AGENT_ID=model-a AGENT_LABEL="Model A" AGENT_REGISTRATION_TOKEN=local-agent-secret \
  LOBBY_URL=http://127.0.0.1:8080 MODEL_MODULE=./agents/my-model.js npm run agent

AGENT_ID=model-b AGENT_LABEL="Model B" AGENT_REGISTRATION_TOKEN=local-agent-secret \
  LOBBY_URL=http://127.0.0.1:8080 MODEL_MODULE=./agents/my-model.js npm run agent
```

The process remains registered across matches. When an admin selects it, the lobby sends a private seat token and endpoint over the registration channel; the runner starts an `AsyncAgentBridge` automatically and becomes available again after the match. Run `npm run agent -- --help` for registered and direct connection options.

Direct match connections remain available for programmatic single-match servers:

```sh
MATCH_TOKEN=replace-with-a-secret npm run agent -- --url wss://game.example/agent/game-1 \
  --player model-a --model ./agents/my-model.js
```

Prefer environment variables because command-line tokens can be exposed through shell history and process listings.

Use the bridge directly when the agent is already constructed:

```js
import { connectAgentBridge } from "./src/agent-bridge.js";
import { LlmAgent } from "./src/llm-agent.js";
import model from "./agents/my-model.js";

const bridge = await connectAgentBridge({
  url: "ws://127.0.0.1:8080/agent/game-1",
  player: "model-a",
  token: process.env.MATCH_TOKEN,
  agent: new LlmAgent({ id: "model-a", model }),
  onError: (error) => console.error(error.message),
});

await bridge.waitForClose();
```

A model failure or malformed response is submitted as an intentionally illegal move so the referee's normal retry and penalty policy remains authoritative.

## Deploy To Railway From GitHub

In [Railway](https://railway.com/), create a new project, choose **Deploy from GitHub repo**, authorize the Railway GitHub App, and select the repository. Railway detects this Node.js application and starts it with `npm start`, so no custom build or start command is required.

Add these service variables in Railway's **Variables** tab:

```dotenv
HOST=0.0.0.0
ADMIN_TOKEN=replace-with-a-long-random-secret
AGENT_REGISTRATION_TOKEN=replace-with-a-different-long-random-secret
```

Do not set `PORT`; Railway provides it automatically. `HOST=0.0.0.0` is required so Railway's public proxy can reach the server. `ADMIN_TOKEN` protects match administration. `AGENT_REGISTRATION_TOKEN` authenticates trusted agent deployments and must be different from the admin token.

After the deployment succeeds, open **Settings**, find **Networking -> Public Networking**, and select **Generate Domain**. The lobby is then available at:

```text
https://liarsdice-production.up.railway.app/
```

Deploy each agent as another Railway service from this repository with the start command `npm run agent`. Configure each service with its own identity and model settings:

```dotenv
AGENT_ID=model-a
AGENT_LABEL=Model A
AGENT_REGISTRATION_TOKEN=the-same-registration-secret-as-the-lobby
LOBBY_URL=https://YOUR-SERVICE.up.railway.app
MODEL_MODULE=./agents/my-model.js
```

Add provider credentials such as `MODEL_API_KEY` to the agent service, not the lobby. Repeat with a different `AGENT_ID` for every agent. Once at least two agents show as `available` in the lobby, create a match; both receive their assignments and connect automatically. Keep the lobby service at one replica because match and registration state is held in memory. Deployments and restarts reset all matches, while persistent agent runners reconnect after the lobby returns.

## Live Spectator

Open `http://HOST:PORT/` while the server is running to browse the lobby. Selecting a table opens `http://HOST:PORT/?match_id=MATCH_ID`; the view connects read-only to `ws://HOST:PORT/spectate/MATCH_ID` and renders public state, bids, challenge reveals, dice counts, table talk, and optional reasoning. Spectators do not authenticate and cannot submit moves. Set `omniscientSpectators` only for a trusted audience; keep `showSpectatorReasoning` off by default.

## Security And Privacy

Use separate high-entropy `ADMIN_TOKEN` and `AGENT_REGISTRATION_TOKEN` values. Anyone with the registration token is trusted to choose an agent ID, so distribute it only to agent services you control. Match seat tokens are generated per assignment, never returned to the admin browser, and sent by registered runners in an authorization header. Legacy direct clients can still put match tokens in the WebSocket query string, which may appear in proxy logs. Normal spectator events hide dice and reasoning; event logs contain private dice and optional reasoning and must be access-controlled. This server does not provide persistent token or match storage; use Railway HTTPS or another suitably configured TLS/authentication proxy for untrusted networks.

## API Notes

`createLobbyServer` and `createRefereeServer` are exported from `src/server.js`; `RegisteredAgentRunner` is exported from `src/registered-agent.js`; `runMatch` and `runSeries` are exported from `src/series.js`; `AsyncAgentBridge` and `connectAgentBridge` are exported from `src/agent-bridge.js`; `LlmAgent` is exported from `src/llm-agent.js`; `HeuristicAgent` is exported from `src/heuristic-agent.js`; `readReplay`, `ReplayStream`, and `streamReplay` are exported from `src/replay.js`. Function options such as `eventLog`, `rng`, `now`, `countTokens`, and `onReplayMalformed` are programmatic hooks and are intentionally not JSON configuration fields. Variant configuration is represented by `exactCall`, `palifico`, and `spotOnReward` in `config.schema.json`.
