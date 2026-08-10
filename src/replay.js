import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export class ReplayFormatError extends Error {
  constructor(message, line, code = "malformed") {
    super(line ? `replay line ${line}: ${message}` : message);
    this.name = "ReplayFormatError";
    this.line = line;
    this.code = code;
  }
}

export function parseReplayLine(line, lineNumber = 0) {
  if (!line.trim()) return null;
  let record;
  try { record = JSON.parse(line); } catch { throw new ReplayFormatError("invalid JSON", lineNumber); }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ReplayFormatError("record must be an object", lineNumber);
  }
  if (!Number.isInteger(record.seq) || record.seq < 0) {
    throw new ReplayFormatError("seq must be a non-negative integer", lineNumber);
  }
  if (typeof record.type !== "string" || !record.type) {
    throw new ReplayFormatError("type must be a non-empty string", lineNumber);
  }
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) {
    throw new ReplayFormatError("state must be an object", lineNumber);
  }
  return record;
}

export async function readReplay(path, { strict = false, onMalformed } = {}) {
  const records = [];
  let previousSeq = -1;
  let lineNumber = 0;
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of input) {
      lineNumber += 1;
      try {
        const record = parseReplayLine(line, lineNumber);
        if (!record) continue;
        if (record.seq <= previousSeq) throw new ReplayFormatError("seq values must be strictly increasing", lineNumber, "ordering");
        previousSeq = record.seq;
        records.push(record);
      } catch (error) {
        if (error instanceof ReplayFormatError && error.code === "malformed" && !strict) { onMalformed?.(error); continue; }
        throw error;
      }
    }
  } finally {
    input.close();
  }
  return records;
}

const eventTime = (record) => {
  const value = record.timestamp ?? record.at ?? record.time;
  return Number.isFinite(value) ? value : null;
};

export class ReplayStream {
  constructor(records, { speed = 1, clock = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (!Number.isFinite(speed) || speed < 0) throw new TypeError("speed must be a non-negative number");
    this.records = records;
    this.speed = speed;
    this.clock = clock;
    this.sleep = sleep;
    this.paused = false;
    this.stopped = false;
    this.waiters = [];
  }

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  stop() { this.stopped = true; this.resume(); }

  async waitWhilePaused() {
    while (this.paused && !this.stopped) await new Promise((resolve) => this.waiters.push(resolve));
  }

  async wait(ms) {
    let remaining = ms;
    while (remaining > 0 && !this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) return;
      const started = this.clock();
      await this.sleep(Math.min(remaining, 25));
      if (!this.paused) remaining -= Math.max(0, this.clock() - started);
    }
  }

  async run(emit) {
    let previousTime = null;
    for (const record of this.records) {
      if (this.stopped) break;
      const currentTime = eventTime(record);
      if (this.speed > 0 && currentTime !== null && previousTime !== null) {
        await this.wait(Math.max(0, currentTime - previousTime) / this.speed);
      }
      await this.waitWhilePaused();
      if (this.stopped) break;
      await emit(record);
      if (currentTime !== null) previousTime = currentTime;
    }
  }
}

export async function streamReplay(path, emit, options = {}) {
  const records = await readReplay(path, options);
  const stream = new ReplayStream(records, options);
  await stream.run(emit);
  return stream;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) { process.stderr.write("Usage: npm run replay -- <event-log.jsonl> [speed]\n"); process.exitCode = 2; }
  else {
    await streamReplay(path, (record) => process.stdout.write(`${JSON.stringify(record)}\n`), { speed: Number(process.argv[3] ?? 1) });
  }
}
