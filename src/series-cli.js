import { HeuristicAgent } from "./heuristic-agent.js";
import { runSeries } from "./series.js";

function value(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
const matches = Number(value(args, "matches", 2));
const dicePerPlayer = Number(value(args, "dice", 2));
const seeds = String(value(args, "seeds", "17,23")).split(",").map(Number);
const resultsPath = value(args, "results", undefined);
const logDir = value(args, "log-dir", undefined);
const result = runSeries({
  agents: [new HeuristicAgent({ id: "heuristic-a" }), new HeuristicAgent({ id: "heuristic-b" })],
  matches, seeds, dicePerPlayer, resultsPath, logDir,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
