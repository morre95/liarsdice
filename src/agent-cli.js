import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncAgentBridge } from "./agent-bridge.js";
import { LlmAgent } from "./llm-agent.js";
import { RegisteredAgentRunner } from "./registered-agent.js";

function value(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

function required(value, name) {
  if (value === undefined || value === null || String(value) === "") throw new TypeError(`${name} is required`);
  return String(value);
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("Registered: npm run agent -- --lobby URL --player ID --registration-token TOKEN --model FILE [--label NAME]\n" +
    "Direct:     npm run agent -- --url MATCH_URL --player ID --token TOKEN --model FILE\n");
  process.exit(0);
}

const directMode = args.includes("--direct") || args.includes("--url") || args.includes("--token");
const lobbyUrl = directMode ? undefined : value(args, "lobby", process.env.LOBBY_URL);
const player = required(value(args, "player", process.env.AGENT_ID || process.env.PLAYER), "player");
const modelPath = required(value(args, "model", process.env.MODEL_MODULE), "model module");
const promptPath = value(args, "prompt", process.env.SYSTEM_PROMPT);
const moduleUrl = pathToFileURL(resolve(modelPath)).href;
const loaded = await import(moduleUrl);
const model = loaded.default ?? loaded.model;
if (typeof model !== "function") throw new TypeError("model module must export a default function or named model function");

const agent = new LlmAgent({ id: player, model, ...(promptPath ? { promptPath } : {}) });
const processError = (error) => process.stderr.write(`Agent: ${error.message}\n`);
const client = lobbyUrl ? new RegisteredAgentRunner({
  url: lobbyUrl,
  id: player,
  label: value(args, "label", process.env.AGENT_LABEL || player),
  registrationToken: required(value(args, "registration-token", process.env.AGENT_REGISTRATION_TOKEN), "registration token"),
  agent,
  onError: processError,
}) : new AsyncAgentBridge({
  url: value(args, "url", process.env.REFEREE_URL || "ws://127.0.0.1:8080/agent"),
  player,
  token: required(value(args, "token", process.env.MATCH_TOKEN), "match token"),
  agent,
  onError: processError,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => client.close(1000, signal));
}

await client.start();
if (lobbyUrl) process.stdout.write(`Registered ${player} with ${lobbyUrl}\n`);
const closed = await client.waitForClose();
if (!lobbyUrl && closed.code !== 1000) {
  process.stderr.write(`Agent bridge closed (${closed.code}): ${closed.reason || "no reason supplied"}\n`);
  process.exitCode = 1;
}
