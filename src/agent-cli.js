import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncAgentBridge } from "./agent-bridge.js";
import { LlmAgent } from "./llm-agent.js";

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
  process.stdout.write("Usage: npm run agent -- --player ID --token TOKEN --model FILE [--url ws://127.0.0.1:8080/agent] [--prompt FILE]\n");
  process.exit(0);
}

const player = required(value(args, "player", process.env.PLAYER), "player");
const token = required(value(args, "token", process.env.MATCH_TOKEN), "match token");
const modelPath = required(value(args, "model", process.env.MODEL_MODULE), "model module");
const url = value(args, "url", process.env.REFEREE_URL || "ws://127.0.0.1:8080/agent");
const promptPath = value(args, "prompt", process.env.SYSTEM_PROMPT);
const moduleUrl = pathToFileURL(resolve(modelPath)).href;
const loaded = await import(moduleUrl);
const model = loaded.default ?? loaded.model;
if (typeof model !== "function") throw new TypeError("model module must export a default function or named model function");

const agent = new LlmAgent({ id: player, model, ...(promptPath ? { promptPath } : {}) });
const bridge = new AsyncAgentBridge({
  url,
  player,
  token,
  agent,
  onError: (error) => process.stderr.write(`Agent bridge: ${error.message}\n`),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => bridge.close(1000, signal));
}

await bridge.start();
const closed = await bridge.waitForClose();
if (closed.code !== 1000) {
  process.stderr.write(`Agent bridge closed (${closed.code}): ${closed.reason || "no reason supplied"}\n`);
  process.exitCode = 1;
}
