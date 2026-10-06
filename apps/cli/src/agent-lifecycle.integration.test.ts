import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createCliHarness, type CliHarness } from "./harness.js";

test("CLI host keeps one Agent identity across input completion, pause, and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-agents-"));
  let harness: CliHarness | undefined;
  try {
    const cwd = join(root, "repo");
    await mkdir(cwd);
    harness = await createCliHarness({ cwd, chiliHome: join(root, "home"), model: "fake", quiet: true, yes: true, mcpConnectMode: "manual" });
    const parent = await harness.service.createSession({ cwd });
    const other = await harness.service.createSession({ cwd });
    const agents = harness.agents.forSession(parent.sessionId);
    const foreign = harness.agents.forSession(other.sessionId);
    const created = await agents.spawnAgent({ name: "reader", prompt: "Say hello." });
    expect((await agents.waitAgent({ ...created, timeoutMs: 2_000 })).input.outcome).toBe("completed");
    await agents.stopAgent({ agentId: created.agentId });
    await agents.stopAgent({ agentId: created.agentId });
    const pausedAgents = await agents.listAgents({});
    expect(pausedAgents.filter((agent) => agent.agentId === parent.sessionId)).toEqual([
      expect.objectContaining({ name: "root", path: "/root" }),
    ]);
    expect(pausedAgents.filter((agent) => agent.agentId !== parent.sessionId)).toEqual([
      expect.objectContaining({ agentId: created.agentId, name: "reader", state: "paused" }),
    ]);
    const queued = await agents.sendAgent({ agentId: created.agentId, text: "Continue with the next input." });
    expect((await agents.waitAgent({ ...queued, timeoutMs: 1 })).timedOut).toBe(true);
    await expect(foreign.stopAgent({ agentId: created.agentId })).rejects.toThrow("descendant");
    await expect(foreign.sendAgent({ agentId: created.agentId, text: "cross session" })).rejects.toThrow("same root");
    expect(await foreign.listAgents({})).toEqual([
      expect.objectContaining({ agentId: other.sessionId, name: "root", path: "/root" }),
    ]);
    await agents.resumeAgent({ agentId: created.agentId });
    const completed = await agents.waitAgent({ ...queued, timeoutMs: 2_000 });
    expect(completed.timedOut).toBe(false);
    expect(completed.input.outcome).toBe("completed");
    expect(completed.result).toMatchObject({ role: "assistant" });
    const resumedAgents = await agents.listAgents({});
    expect(resumedAgents.filter((agent) => agent.agentId === parent.sessionId)).toEqual([
      expect.objectContaining({ name: "root", path: "/root" }),
    ]);
    expect(resumedAgents.filter((agent) => agent.agentId !== parent.sessionId)).toEqual([
      expect.objectContaining({ agentId: created.agentId, state: "idle" }),
    ]);
    await harness.waitForAgents();
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});
