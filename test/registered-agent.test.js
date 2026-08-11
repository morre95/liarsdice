import assert from "node:assert/strict";
import test from "node:test";
import { HeuristicAgent } from "../src/heuristic-agent.js";
import { RegisteredAgentRunner } from "../src/registered-agent.js";
import { createLobbyServer } from "../src/server.js";

async function eventually(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

test("persistent registered runners receive assignments and complete a match automatically", async () => {
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runners = ["alpha", "beta"].map((id) => new RegisteredAgentRunner({
    url: baseUrl,
    id,
    label: id.toUpperCase(),
    registrationToken: "registration-secret",
    agent: new HeuristicAgent({ id }),
    reconnectDelayMs: 10,
  }));
  try {
    await Promise.all(runners.map((runner) => runner.start()));
    const agents = await (await fetch(`${baseUrl}/api/agents`)).json();
    assert.deepEqual(agents.agents.map(({ id, status }) => ({ id, status })), [
      { id: "alpha", status: "available" }, { id: "beta", status: "available" },
    ]);
    const response = await fetch(`${baseUrl}/api/matches`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer admin-secret",
    }, body: JSON.stringify({ matchId: "automatic", players: ["alpha", "beta"], dicePerPlayer: 1, seed: 4 }) });
    assert.equal(response.status, 201);
    const session = await eventually(() => lobby.getMatch("automatic"));
    await eventually(() => session.status === "finished");
    assert.ok(session.finalRecord.winner);
    await eventually(() => [...lobby.registrations.values()].every((registration) => registration.status === "available") &&
      runners.every((runner) => runner.activeBridge === null));
  } finally {
    await Promise.all(runners.map((runner) => runner.close()));
    await lobby.stop();
  }
});

test("registered runners tolerate the lobby starting after the agent", async () => {
  const reservation = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const reservedAddress = await reservation.start();
  await reservation.stop();
  const lobby = createLobbyServer({ port: reservedAddress.port, adminToken: "admin-secret",
    agentRegistrationToken: "registration-secret" });
  const runner = new RegisteredAgentRunner({
    url: `http://127.0.0.1:${reservedAddress.port}`,
    id: "late-lobby-agent",
    registrationToken: "registration-secret",
    agent: new HeuristicAgent({ id: "late-lobby-agent" }),
    reconnectDelayMs: 10,
  });
  try {
    const starting = runner.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await lobby.start();
    await starting;
    assert.equal(lobby.registrations.has("late-lobby-agent"), true);
  } finally {
    await runner.close();
    await lobby.stop();
  }
});

test("a failed automatic assignment is cancelled and releases both agents", async () => {
  class FailingBridge {
    async start() { throw new Error("match endpoint unavailable"); }
    close() {}
  }
  const lobby = createLobbyServer({ adminToken: "admin-secret", agentRegistrationToken: "registration-secret" });
  const address = await lobby.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runners = ["broken-a", "broken-b"].map((id) => new RegisteredAgentRunner({
    url: baseUrl, id, registrationToken: "registration-secret", agent: new HeuristicAgent({ id }),
    BridgeImpl: FailingBridge, reconnectDelayMs: 10,
  }));
  try {
    await Promise.all(runners.map((runner) => runner.start()));
    const response = await fetch(`${baseUrl}/api/matches`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer admin-secret",
    }, body: JSON.stringify({ matchId: "will-cancel", players: ["broken-a", "broken-b"] }) });
    assert.equal(response.status, 201);
    await eventually(() => !lobby.getMatch("will-cancel"));
    await eventually(() => [...lobby.registrations.values()].every((registration) => registration.status === "available"));
  } finally {
    await Promise.all(runners.map((runner) => runner.close()));
    await lobby.stop();
  }
});
