import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubagentManager, type LocalSubagentRunInput, type WorkerToolPolicy } from "@chili/core";
import {
  timestampNow,
  type AgentPath,
  type SessionId,
  type TaskId,
  type TeamId,
  type ToolCallId,
  type TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { SubagentToolContext } from "@chili/tools";
import { createAgentExpansionController, recursiveWorkerPolicy, resolveAgentAncestry } from "./agent-expansion.js";
import type { HostAgentConfig } from "./config.js";

const limits: HostAgentConfig = { maxChildren: 3, maxDepth: 3, maxConcurrent: 3 };
const rootSessionId = "session_root" as SessionId;

test("expansion follows durable ancestry and binds each descendant's own identity", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.controller.spawnTask({ description: "First", prompt: "Inspect", mode: "resumable" }, context());
    const firstRun = fixture.runs[0]!;
    const second = await fixture.controller.spawnTask({ description: "Second", prompt: "Inspect deeper" }, context(firstRun.childSessionId));
    const secondRun = fixture.runs[1]!;
    await fixture.controller.spawnTask({ description: "Third", prompt: "Inspect deepest" }, context(secondRun.childSessionId));
    const thirdRun = fixture.runs[2]!;
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(firstRun.mode).toBe("resumable");
    expect(secondRun.parentPath).toBe(firstRun.path);
    expect(thirdRun.parentPath).toBe(secondRun.path);
    for (const run of fixture.runs) {
      expect(run.workerPolicy).toMatchObject({
        parentSessionId: run.parentSessionId,
        childSessionId: run.childSessionId,
        memberPath: run.path,
      });
      expect(run.workerPolicy!.allowedTools).toEqual(expect.arrayContaining(["agent_spawn", "agent_wait", "agent_stop", "agent_resume"]));
    }
    expect(await resolveAgentAncestry(fixture.store, thirdRun.childSessionId)).toEqual({
      path: thirdRun.path, depth: 3, rootSessionId,
    });
    await expect(fixture.controller.spawnTask({ description: "Fourth", prompt: "Too deep" }, context(thirdRun.childSessionId)))
      .rejects.toThrow("max_depth=3");
    expect(fixture.runs).toHaveLength(3);
  } finally { await fixture.close(); }
});

test("descendants inherit effective tool and path restrictions without extra capabilities", async () => {
  const fixture = await createFixture();
  try {
    await fixture.controller.spawnTask({ description: "Parent", prompt: "Inspect" }, context());
    const parent = fixture.runs[0]!;
    const restricted: WorkerToolPolicy = {
      allowedTools: ["read", "agent_spawn", "code_mode"],
      deniedTools: ["bash", "agent_resume"],
      writeScope: ["src/one.ts"],
      executeScope: [],
      metadata: { profile: "restricted" },
      parentSessionId: rootSessionId,
      childSessionId: parent.childSessionId,
      memberPath: parent.path,
    };
    fixture.policies.set(parent.childSessionId, restricted);
    await fixture.controller.spawnTask({ description: "Child", prompt: "Inspect" }, context(parent.childSessionId));
    const child = fixture.runs[1]!;
    expect(child.workerPolicy).toEqual({
      ...restricted,
      parentSessionId: parent.childSessionId,
      childSessionId: child.childSessionId,
      memberPath: child.path,
    });
    expect(restricted.childSessionId).toBe(parent.childSessionId);
    expect(restricted.memberPath).toBe(parent.path);
  } finally { await fixture.close(); }
});

test("expansion derives ownership and scheduling source from trusted execution context", async () => {
  const fixture = await createFixture();
  try {
    const input = {
      description: "Child", prompt: "Inspect", mode: "background",
      parentSessionId: "spoofed", parentPath: "/root/spoofed", depth: 0, maxChildren: 999,
      sourceCallId: "spoofed-call" as ToolCallId, batchId: "batch_1", batchIndex: 0,
      expectedBatchSize: 1, maxConcurrency: 1, completionPolicy: "join" as const,
    };
    await fixture.controller.spawnTask(input, context());
    await fixture.manager.waitForBackgroundTasks();
    expect(fixture.runs[0]).toMatchObject({
      parentSessionId: rootSessionId, parentPath: "/root", sourceCallId: "call_test",
      batchId: "batch_1", batchIndex: 0, expectedBatchSize: 1, maxConcurrency: 1, completionPolicy: "join",
    });
  } finally { await fixture.close(); }
});

test("width counts durable child identities, including completed children and concurrent attempts", async () => {
  const fixture = await createFixture({ ...limits, maxChildren: 1 });
  try {
    const attempts = await Promise.allSettled([
      fixture.controller.spawnTask({ description: "A", prompt: "Inspect A" }, context()),
      fixture.controller.spawnTask({ description: "B", prompt: "Inspect B" }, context()),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await fixture.store.agentTasks({ parentSessionId: rootSessionId })).toHaveLength(1);
    await expect(fixture.controller.spawnTask({ description: "C", prompt: "Inspect C" }, context())).rejects.toThrow();
    const childSessionId = fixture.runs[0]!.childSessionId;
    await fixture.controller.spawnTask({ description: "Grandchild", prompt: "Inspect" }, context(childSessionId));
    expect(await fixture.store.agentTasks({ parentSessionId: childSessionId })).toHaveLength(1);
  } finally { await fixture.close(); }
});

test("disabled width/depth rejects before creating any child", async () => {
  for (const configuration of [{ ...limits, maxChildren: 0 }, { ...limits, maxDepth: 0 }]) {
    const fixture = await createFixture(configuration);
    try {
      await expect(fixture.controller.spawnTask({ description: "Child", prompt: "Inspect" }, context())).rejects.toThrow();
      expect(await fixture.store.agentTasks()).toHaveLength(0);
      expect(fixture.runs).toHaveLength(0);
    } finally { await fixture.close(); }
  }
});

test("default depth retains the existing worker tools, and explicit Team policy is not weakened", async () => {
  const base: WorkerToolPolicy = { allowedTools: ["read"], deniedTools: ["agent_spawn"] };
  expect(recursiveWorkerPolicy(base, { ...limits, maxDepth: 1 })).toEqual(base);
  expect(recursiveWorkerPolicy(base, limits).deniedTools).toEqual(["agent_spawn"]);
  const fixture = await createFixture();
  try {
    await fixture.controller.spawnTask({ description: "Worker", prompt: "Inspect" }, context());
    const parent = fixture.runs[0]!;
    fixture.policies.set(parent.childSessionId, { ...parent.workerPolicy, teamId: "team_1" as TeamId, taskId: "team_task_1" as TaskId });
    await expect(fixture.controller.spawnTask({ description: "Child", prompt: "Inspect" }, context(parent.childSessionId)))
      .rejects.toThrow("team-scoped workers");
    expect(fixture.runs).toHaveLength(1);
  } finally { await fixture.close(); }
});

test("ancestry rejects missing sessions, ambiguous ownership, cycles and inconsistent paths", async () => {
  const fixture = await createFixture();
  try {
    await expect(resolveAgentAncestry(fixture.store, "missing" as SessionId)).rejects.toThrow("missing");
    for (const name of ["ambiguous", "cycle_a", "cycle_b", "bad_path", "orphan"]) await appendSession(fixture.store, name as SessionId);
    await appendTask(fixture.store, "first", rootSessionId, "ambiguous" as SessionId, "/root/first");
    const first = (await fixture.store.agentTask("first" as TaskId))!;
    const projection = spyOn(fixture.store, "agentTasks").mockResolvedValueOnce([first, { ...first, id: "second" as TaskId }]);
    try {
      await expect(resolveAgentAncestry(fixture.store, "ambiguous" as SessionId)).rejects.toThrow("ambiguous ownership");
    } finally { projection.mockRestore(); }
    await appendTask(fixture.store, "cycle_a", "cycle_b" as SessionId, "cycle_a" as SessionId, "/root/a");
    await appendTask(fixture.store, "cycle_b", "cycle_a" as SessionId, "cycle_b" as SessionId, "/root/b");
    await expect(resolveAgentAncestry(fixture.store, "cycle_a" as SessionId)).rejects.toThrow("cycle");
    await appendTask(fixture.store, "bad", rootSessionId, "bad_path" as SessionId, "/elsewhere/bad", "/elsewhere");
    await expect(resolveAgentAncestry(fixture.store, "bad_path" as SessionId)).rejects.toThrow("path does not match");
    await appendTask(fixture.store, "orphan", "missing_parent" as SessionId, "orphan" as SessionId, "/root/orphan");
    await expect(resolveAgentAncestry(fixture.store, "orphan" as SessionId)).rejects.toThrow("session is missing");
  } finally { await fixture.close(); }
});

test("team member path segments do not inflate depth from actual session ownership", async () => {
  const fixture = await createFixture();
  try {
    const child = "team_child" as SessionId;
    await appendSession(fixture.store, child);
    await appendTask(fixture.store, "team_child", rootSessionId, child, "/root/member/task_child", "/root/member");
    expect(await resolveAgentAncestry(fixture.store, child)).toEqual({
      depth: 1, path: "/root/member/task_child", rootSessionId,
    });
  } finally { await fixture.close(); }
});

function context(sessionId = rootSessionId): SubagentToolContext {
  return {
    sessionId, turnId: "turn_test" as TurnId, callId: "call_test" as ToolCallId,
    cwd: "/repo", signal: new AbortController().signal,
    async metadata() {}, async streamOutput() {}, async requestApproval() { return { action: "allow_once" }; },
  };
}

async function createFixture(configuration: HostAgentConfig = limits) {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-expansion-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runs: LocalSubagentRunInput[] = [];
  const policies = new Map<SessionId, WorkerToolPolicy>();
  let nextId = 0;
  await appendSession(store, rootSessionId);
  const manager = new LocalSubagentManager({
    store, createId: (prefix) => `${prefix}_${++nextId}`,
    runner: { async run(input) {
      runs.push(input);
      policies.set(input.childSessionId, input.workerPolicy!);
      await appendSession(store, input.childSessionId);
      return { status: "completed", summary: "Inspected the requested files." };
    } },
  });
  const controller = createAgentExpansionController({ subagents: manager, store, limits: configuration,
    workerPolicyForSession: async (sessionId) => {
      const policy = policies.get(sessionId);
      if (!policy) throw new Error(`No effective policy: ${sessionId}`);
      return policy;
    },
  });
  return { store, manager, controller, runs, policies, async close() {
    await manager.shutdown(); store.close(); await rm(dir, { recursive: true, force: true });
  } };
}

async function appendSession(store: SqliteEventStore, sessionId: SessionId): Promise<void> {
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId, time: timestampNow(), payload: { sessionId, cwd: "/repo" } });
}

async function appendTask(
  store: SqliteEventStore, taskId: string, parentSessionId: SessionId, childSessionId: SessionId,
  path: AgentPath, parentPath: AgentPath = "/root",
): Promise<void> {
  await store.append({ id: crypto.randomUUID(), type: "agent.task_created", sessionId: parentSessionId, time: timestampNow(),
    payload: { taskId: taskId as TaskId, parentSessionId, childSessionId, path, parentPath, taskName: taskId, cwd: "/repo", prompt: "Inspect" } });
}
