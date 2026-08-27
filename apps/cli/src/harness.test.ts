import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  chiliBasePromptFragment,
  type AgentTaskControlService,
  type AgentTreeControlService,
  type ModelRouter,
  type ModelStreamEvent,
  type ModelStreamInput,
  type PromptFragment,
  type TeamControlService,
} from "@chili/core";
import type { AgentPath, AgentRunId, ApprovalId, ChiliEvent, SessionId, TaskId, TeamId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { SkillRegistry, type Skill } from "@chili/skills";
import { SqliteEventStore, type AgentMailboxRow, type AgentTaskRow } from "@chili/store";
import {
  DeferredUserInputQueue,
  PolicyApprovalBroker,
  PolicyApprovalState,
  type BashRunner,
  type ChiliToolDefinition,
  type ChiliToolExecutionContext,
} from "@chili/tools";
import {
  buildCliChildPromptFragments,
  buildCliPromptFragments,
  createCliHarness,
  createCompleteTaskController,
  createSubagentControlController,
  createTeamToolController,
  type CliHarness,
} from "./harness.js";
import { formatPromptDebugJson, formatPromptDebugText, type CliPromptDebugOutput } from "./prompt-debug.js";
import { createCliMcpRuntime } from "./mcp-control.js";
import { runPrompt, runSessionPrompt } from "./runner.js";
import { readUserModelSelection, writeUserModelSelection } from "./user-model-state.js";

test("CLI harness close interrupts and settles an active root prompt before closing SQLite", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const sessionId = "session_harness_graceful_close" as SessionId;
  const model = new AbortAwareSlowModel();
  let harness: CliHarness | undefined;
  let restarted: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      quiet: true,
      yes: true,
      modelRouter: model,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    });
    await harness.service.createSession({ sessionId, cwd: repo });
    const prompt = harness.service.submitPrompt({ sessionId, text: "wait until shutdown" });
    await model.started.promise;

    const closingHarness = harness;
    const close = closingHarness.close();
    await model.abortObserved.promise;
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    model.finish.resolve();
    expect((await prompt).status).toBe("cancelled");
    await close;
    expect(closeSettled).toBe(true);
    harness = undefined;

    const persisted = new SqliteEventStore(join(repo, ".chili", "chili.sqlite"));
    try {
      const statuses = (await persisted.events({ sessionId, type: "session.status_changed", limit: 20 }))
        .map((event) => (event.payload as { status?: string }).status);
      expect(statuses).not.toContain("cancelling");
      expect(statuses.at(-1)).toBe("cancelled");
      expect(persisted.claimSessionRun({
        sessionId,
        claimId: "claim_after_graceful_close",
        allowSubagentSessions: false,
        time: Date.now(),
        leaseDurationMs: 1_000,
      })).toEqual({ status: "claimed" });
      persisted.releaseSessionRun({ sessionId, claimId: "claim_after_graceful_close" });
    } finally {
      persisted.close();
    }

    restarted = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    });
    expect((await restarted.service.submitPrompt({ sessionId, text: "reused immediately" })).status).toBe("completed");
  } finally {
    model.finish.resolve();
    await restarted?.close();
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness publishes one close promise before an abort listener synchronously reenters", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const sessionId = "session_harness_reentrant_close" as SessionId;
  const model = new AbortAwareSlowModel();
  let harness: CliHarness | undefined;
  let mcpCloseCalls = 0;
  let storeCloseCalls = 0;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      quiet: true,
      yes: true,
      modelRouter: model,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
      async mcpRuntimeFactory(options, baseCommands) {
        const runtime = await createCliMcpRuntime(options, baseCommands);
        return new Proxy(runtime, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                mcpCloseCalls += 1;
                await target.close();
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    await harness.service.createSession({ sessionId, cwd: repo });
    const prompt = harness.service.submitPrompt({ sessionId, text: "reenter close from abort" });
    await model.started.promise;

    const closingHarness = harness;
    const originalStoreClose = closingHarness.store.close.bind(closingHarness.store);
    closingHarness.store.close = () => {
      storeCloseCalls += 1;
      originalStoreClose();
    };
    let reentrantClose: Promise<void> | undefined;
    model.onAbort = () => {
      reentrantClose = closingHarness.close();
    };

    const firstClose = closingHarness.close();
    expect(reentrantClose).toBe(firstClose);
    expect(closingHarness.close()).toBe(firstClose);
    model.finish.resolve();

    expect((await prompt).status).toBe("cancelled");
    await firstClose;
    expect(mcpCloseCalls).toBe(1);
    expect(storeCloseCalls).toBe(1);
    harness = undefined;
  } finally {
    model.finish.resolve();
    await harness?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness close observes rejected MCP and synchronous SQLite cleanup failures once", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  let mcpCloseCalls = 0;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
      async mcpRuntimeFactory(options, baseCommands) {
        const runtime = await createCliMcpRuntime(options, baseCommands);
        return new Proxy(runtime, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                mcpCloseCalls += 1;
                await target.close();
                throw new Error("injected MCP close failure");
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const dbPath = join(repo, ".chili", "chili.sqlite");
    const originalClose = harness.store.close.bind(harness.store);
    let storeCloseCalls = 0;
    harness.store.close = () => {
      storeCloseCalls += 1;
      originalClose();
      throw new Error("injected synchronous SQLite close failure");
    };

    const first = harness.close();
    const second = harness.close();
    expect(second).toBe(first);
    const firstError = await first.catch((error: unknown) => error);
    const secondError = await second.catch((error: unknown) => error);
    expect(firstError).toBe(secondError);
    expect(firstError).toBeInstanceOf(AggregateError);
    expect((firstError as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: injected MCP close failure",
      "Error: injected synchronous SQLite close failure",
    ]);
    expect(mcpCloseCalls).toBe(1);
    expect(storeCloseCalls).toBe(1);

    const reopened = new SqliteEventStore(dbPath);
    try {
      expect(await reopened.sessions()).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    await harness?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness retries stale-turn reconciliation after a crashed run claim lease expires", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const stateDir = join(repo, ".chili");
  const dbPath = join(stateDir, "chili.sqlite");
  const sessionId = "session_harness_crash_recovery" as SessionId;
  const turnId = "turn_harness_crash_recovery" as TurnId;
  let harness: CliHarness | undefined;
  const observedRecoveryEvents: ChiliEvent[] = [];
  let unsubscribe: (() => void) | undefined;
  try {
    await mkdir(stateDir, { recursive: true });
    const crashed = new SqliteEventStore(dbPath);
    const now = Date.now();
    try {
      await crashed.appendMany([
        {
          id: "event_harness_crash_session",
          type: "session.created",
          time: (now - 1_000) as TimestampMs,
          sessionId,
          payload: { sessionId, cwd: repo },
        },
        {
          id: "event_harness_crash_running",
          type: "session.status_changed",
          time: (now - 900) as TimestampMs,
          sessionId,
          payload: { sessionId, status: "running", reason: "prompt_submitted" },
        },
        {
          id: "event_harness_crash_turn",
          type: "turn.started",
          time: (now - 800) as TimestampMs,
          sessionId,
          payload: { turnId },
        },
      ]);
      expect(crashed.claimSessionRun({
        sessionId,
        claimId: "claim_harness_crashed_process",
        allowSubagentSessions: false,
        time: now,
        leaseDurationMs: 60,
      })).toEqual({ status: "claimed" });
    } finally {
      // Closing a crashed owner's connection deliberately leaves its durable
      // lease behind, matching SIGKILL semantics.
      crashed.close();
    }

    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryMs: 0,
      staleTurnRecoveryIntervalMs: 10,
    });
    unsubscribe = harness.events.subscribe((event) => observedRecoveryEvents.push(event));
    expect((await harness.events.events({ sessionId, type: "session.status_changed", limit: 20 })).at(-1)?.payload).toMatchObject({
      status: "running",
    });

    await waitFor(async () => {
      const statuses = await harness?.events.events({ sessionId, type: "session.status_changed", limit: 20 });
      return (statuses?.at(-1)?.payload as { status?: string } | undefined)?.status === "failed";
    });
    const events = await harness.events.events({ sessionId, limit: 20 });
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(observedRecoveryEvents.map((event) => event.type)).toEqual([
      "turn.completed",
      "session.status_changed",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      sessionId,
      status: "failed",
      reason: "stale_turn_recovered",
    });
    expect((await harness.service.submitPrompt({ sessionId, text: "usable after recovery" })).status).toBe("completed");
  } finally {
    unsubscribe?.();
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness recovers an expired child task, agent run, and child turn through live events exactly once", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const stateDir = join(repo, ".chili");
  const dbPath = join(stateDir, "chili.sqlite");
  const parentSessionId = "session_harness_child_parent" as SessionId;
  const childSessionId = "session_harness_child_crash" as SessionId;
  const taskId = "task_harness_child_crash" as TaskId;
  const runId = "agent_harness_child_crash" as AgentRunId;
  const turnId = "turn_harness_child_crash" as TurnId;
  const path = "/root/task_harness_child_crash" as AgentPath;
  let harness: CliHarness | undefined;
  let unsubscribe: (() => void) | undefined;
  const observed: ChiliEvent[] = [];
  try {
    await mkdir(stateDir, { recursive: true });
    const crashed = new SqliteEventStore(dbPath);
    const now = Date.now();
    try {
      await crashed.appendMany([
        {
          id: "event_harness_child_parent",
          type: "session.created",
          time: (now - 1_000) as TimestampMs,
          sessionId: parentSessionId,
          payload: { sessionId: parentSessionId, cwd: repo },
        },
        {
          id: "event_harness_child_task",
          type: "agent.task_created",
          time: (now - 950) as TimestampMs,
          sessionId: parentSessionId,
          payload: {
            taskId,
            path,
            parentPath: "/root" as AgentPath,
            parentSessionId,
            childSessionId,
            taskName: "crashed child",
            cwd: repo,
            prompt: "keep working",
            mode: "background",
          },
        },
        {
          id: "event_harness_child_spawned",
          type: "agent.spawned",
          time: (now - 900) as TimestampMs,
          sessionId: parentSessionId,
          payload: {
            runId,
            taskId,
            path,
            parentPath: "/root" as AgentPath,
            parentSessionId,
            childSessionId,
            taskName: "crashed child",
            cwd: repo,
            mode: "background",
            generation: 1,
          },
        },
        {
          id: "event_harness_child_session",
          type: "session.created",
          time: (now - 850) as TimestampMs,
          sessionId: childSessionId,
          payload: { sessionId: childSessionId, cwd: repo },
        },
        {
          id: "event_harness_child_running",
          type: "session.status_changed",
          time: (now - 800) as TimestampMs,
          sessionId: childSessionId,
          payload: { sessionId: childSessionId, status: "running" },
        },
        {
          id: "event_harness_child_turn",
          type: "turn.started",
          time: (now - 750) as TimestampMs,
          sessionId: childSessionId,
          payload: { turnId },
        },
      ]);
      expect(await crashed.claimAgentTaskLease({
        taskId,
        runId,
        generation: 1,
        owner: "crashed-child-owner",
        ttlMs: 100,
        now,
      })).toMatchObject({ acquired: true });
    } finally {
      crashed.close();
    }

    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryMs: 0,
      staleTurnRecoveryIntervalMs: 10,
    });
    unsubscribe = harness.events.subscribe((event) => observed.push(event));

    await waitFor(async () => {
      const task = await harness?.events.agentTask(taskId);
      const statuses = await harness?.events.events({
        sessionId: childSessionId,
        type: "session.status_changed",
        limit: 20,
      });
      const childStatus = (statuses?.at(-1)?.payload as { status?: string } | undefined)?.status;
      return task?.status === "cancelled" && childStatus === "failed";
    });

    expect(await harness.events.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "cancelled",
      error: "stale_agent_worker",
    });
    expect((await harness.events.agentRuns({ taskId, limit: 10 }))[0]).toMatchObject({
      id: runId,
      status: "cancelled",
    });
    expect(observed.filter((event) => event.type === "agent.task_completed")).toHaveLength(1);
    expect(observed.filter((event) => event.type === "agent.completed")).toHaveLength(1);
    expect(observed.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(observed.filter((event) => event.type === "session.status_changed")).toHaveLength(1);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const durable = await harness.events.events({ limit: 100 });
    expect(durable.filter((event) => event.type === "agent.task_completed"
      && (event.payload as { taskId?: TaskId }).taskId === taskId)).toHaveLength(1);
    expect(durable.filter((event) => event.type === "agent.completed"
      && (event.payload as { runId?: AgentRunId }).runId === runId)).toHaveLength(1);
    expect(durable.filter((event) => event.type === "turn.completed"
      && (event.payload as { turnId?: TurnId }).turnId === turnId)).toHaveLength(1);
  } finally {
    unsubscribe?.();
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness recovery never steals another store's pending or lease-null running task", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const stateDir = join(repo, ".chili");
  const dbPath = join(stateDir, "chili.sqlite");
  const parentSessionId = "session_harness_live_peer" as SessionId;
  const pendingTaskId = "task_harness_peer_pending" as TaskId;
  const runningTaskId = "task_harness_peer_running" as TaskId;
  const runningRunId = "agent_harness_peer_running" as AgentRunId;
  const leasedTaskId = "task_harness_peer_leased" as TaskId;
  const leasedRunId = "agent_harness_peer_leased" as AgentRunId;
  const pendingPath = "/root/task_harness_peer_pending" as AgentPath;
  const runningPath = "/root/task_harness_peer_running" as AgentPath;
  const leasedPath = "/root/task_harness_peer_leased" as AgentPath;
  let peer: SqliteEventStore | undefined;
  let harness: CliHarness | undefined;
  try {
    await mkdir(stateDir, { recursive: true });
    peer = new SqliteEventStore(dbPath);
    const now = Date.now();
    await peer.appendMany([
      {
        id: "event_harness_peer_session",
        type: "session.created",
        time: (now - 1_000) as TimestampMs,
        sessionId: parentSessionId,
        payload: { sessionId: parentSessionId, cwd: repo },
      },
      {
        id: "event_harness_peer_pending",
        type: "agent.task_created",
        time: (now - 900) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId: pendingTaskId,
          path: pendingPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId: "session_harness_peer_pending" as SessionId,
          taskName: "peer pending",
          cwd: repo,
          prompt: "queued behind a peer limiter",
          mode: "background",
        },
      },
      {
        id: "event_harness_peer_running_task",
        type: "agent.task_created",
        time: (now - 850) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId: runningTaskId,
          path: runningPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId: "session_harness_peer_running" as SessionId,
          taskName: "peer beginning",
          cwd: repo,
          prompt: "between spawn commit and lease claim",
          mode: "background",
        },
      },
      {
        id: "event_harness_peer_spawned",
        type: "agent.spawned",
        time: (now - 800) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          runId: runningRunId,
          taskId: runningTaskId,
          path: runningPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId: "session_harness_peer_running" as SessionId,
          taskName: "peer beginning",
          cwd: repo,
          mode: "background",
          generation: 1,
        },
      },
      {
        id: "event_harness_peer_leased_task",
        type: "agent.task_created",
        time: (now - 750) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId: leasedTaskId,
          path: leasedPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId: "session_harness_peer_leased" as SessionId,
          taskName: "peer leased",
          cwd: repo,
          prompt: "owned by a live peer before startup recovery",
          mode: "background",
        },
      },
      {
        id: "event_harness_peer_leased_spawned",
        type: "agent.spawned",
        time: (now - 700) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          runId: leasedRunId,
          taskId: leasedTaskId,
          path: leasedPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId: "session_harness_peer_leased" as SessionId,
          taskName: "peer leased",
          cwd: repo,
          mode: "background",
          generation: 1,
        },
      },
    ]);
    expect(await peer.claimAgentTaskLease({
      taskId: leasedTaskId,
      runId: leasedRunId,
      generation: 1,
      owner: "startup-live-peer-owner",
      ttlMs: 10_000,
      now,
    })).toMatchObject({ acquired: true });

    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryMs: 0,
      staleTurnRecoveryIntervalMs: 5,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

    expect(await peer.agentTask(pendingTaskId)).toMatchObject({ status: "pending" });
    expect(await peer.agentTask(leasedTaskId)).toMatchObject({
      status: "running",
      leaseOwner: "startup-live-peer-owner",
    });
    const runningBeforeLease = await peer.agentTask(runningTaskId);
    expect(runningBeforeLease).toMatchObject({ status: "running" });
    expect(runningBeforeLease?.leaseOwner).toBeUndefined();

    expect(await peer.claimAgentTaskLease({
      taskId: runningTaskId,
      runId: runningRunId,
      generation: 1,
      owner: "live-peer-owner",
      ttlMs: 1_000,
      now: Date.now(),
    })).toMatchObject({ acquired: true });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(await peer.agentTask(runningTaskId)).toMatchObject({
      status: "running",
      leaseOwner: "live-peer-owner",
    });
  } finally {
    await harness?.close();
    peer?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness isolates a stale-recovery reporter that throws", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  let reports = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryMs: 0,
      staleTurnRecoveryIntervalMs: 5,
      onStaleTurnRecoveryError() {
        reports += 1;
        throw new Error("reporter failure must be isolated");
      },
    });
    harness.store.close();

    await waitFor(async () => reports > 0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await harness?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness exposes one shared request_user_input tool only when a queue is injected", async () => {
  const root = await mkdtempName();
  const plainRepo = join(root, "plain");
  const controlledRepo = join(root, "controlled");
  let plainHarness: CliHarness | undefined;
  let controlledHarness: CliHarness | undefined;
  try {
    await mkdir(plainRepo, { recursive: true });
    await mkdir(controlledRepo, { recursive: true });
    plainHarness = await createCliHarness({
      cwd: plainRepo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const plain = harnessToolRegistries(plainHarness);
    expect(plain.root.get("request_user_input")).toBeUndefined();
    expect(plain.child?.get("request_user_input")).toBeUndefined();

    controlledHarness = await createCliHarness({
      cwd: controlledRepo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      userInputQueue: new DeferredUserInputQueue(),
    });
    const controlled = harnessToolRegistries(controlledHarness);
    const rootTool = controlled.root.get("request_user_input");
    const childTool = controlled.child?.get("request_user_input");
    expect(rootTool).toBeDefined();
    expect(childTool).toBe(rootTool);
  } finally {
    await controlledHarness?.close();
    await plainHarness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt fragments include base, memory/project context, and skills catalog", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(join(home, ".chili"), { recursive: true });
    await mkdir(join(repo, ".chili"), { recursive: true });
    await writeFile(join(repo, ".chili", "memory.md"), "project uses bun\n", "utf8");
    await writeFile(join(repo, "AGENTS.md"), "prefer focused patches\n", "utf8");

    const skillRegistry = new SkillRegistry([skill("reviewer")]);
    const fragments = await buildCliPromptFragments({
      cwd: repo,
      homeDir: home,
      projectRoot: repo,
      skillRegistry,
    });

    const contextual = fragments.filter((fragment) => fragment.layer === "contextual_user");
    const developer = fragments.filter((fragment) => fragment.layer === "developer");

    expect(fragments[0]).toEqual(chiliBasePromptFragment());
    expect(contextual.some((fragment) => fragment.source === "memory" && fragment.content.includes("project uses bun"))).toBe(true);
    expect(contextual.some((fragment) => fragment.source === "project" && fragment.content.includes("prefer focused patches"))).toBe(true);
    expect(developer.some((fragment) => fragment.id === "chili.memory.mechanics" && fragment.source === "memory")).toBe(true);
    const skills = developer.find((fragment) => fragment.id === "chili.skills.catalog");
    expect(skills).toMatchObject({
      id: "chili.skills.catalog",
      source: "skills",
      layer: "developer",
    });
    expect(skills?.content).toContain("<available_skills>");
    expect(skills?.content).toContain("reviewer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness promptFragments provider includes chili.base", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({ cwd: repo, model: "fake", quiet: true, yes: true });

    const service = harness.service as unknown as {
      options: {
        promptFragments?: (input: { sessionId: SessionId; cwd: string }) => Promise<PromptFragment[]> | PromptFragment[];
      };
    };
    const fragments = await service.options.promptFragments?.({
      sessionId: "session_harness" as SessionId,
      cwd: repo,
    });
    expect(fragments?.some((fragment) => fragment.id === "chili.base")).toBe(true);
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness scopes skill catalogs, mentions, and activation to the session cwd", async () => {
  const root = await mkdtempName();
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const skillName = "workspace-skill";
  let harness: CliHarness | undefined;
  try {
    for (const [repo, marker] of [[repoA, "WORKSPACE_A"], [repoB, "WORKSPACE_B"]] as const) {
      const skillDir = join(repo, ".chili", "skills", skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${skillName}`,
          `description: ${marker} description`,
          "---",
          `${marker} instructions`,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    harness = await createCliHarness({
      cwd: repoB,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const service = harness.service as unknown as {
      options: {
        promptFragments?: (input: {
          sessionId: SessionId;
          cwd: string;
          turn?: { text: string };
        }) => Promise<PromptFragment[]>;
      };
    };

    const fragmentsA = await service.options.promptFragments?.({
      sessionId: "session_skill_a" as SessionId,
      cwd: repoA,
      turn: { text: `use $${skillName}` },
    });
    const textA = (fragmentsA ?? []).map((fragment) => fragment.content).join("\n");
    expect(textA).toContain("WORKSPACE_A description");
    expect(textA).toContain("WORKSPACE_A instructions");
    expect(textA).not.toContain("WORKSPACE_B");

    const fragmentsB = await service.options.promptFragments?.({
      sessionId: "session_skill_b" as SessionId,
      cwd: repoB,
      turn: { text: `use $${skillName}` },
    });
    const textB = (fragmentsB ?? []).map((fragment) => fragment.content).join("\n");
    expect(textB).toContain("WORKSPACE_B description");
    expect(textB).toContain("WORKSPACE_B instructions");
    expect(textB).not.toContain("WORKSPACE_A");

    const session = await harness.service.createSession({
      sessionId: "session_skill_activation" as SessionId,
      cwd: repoA,
    });
    const executor = (harness.runtime as unknown as {
      options: {
        toolExecutor: {
          execute(input: {
            sessionId: SessionId;
            turnId: TurnId;
            toolName: string;
            input: unknown;
            cwd: string;
          }): Promise<{ status: string; result?: { output: string } }>;
        };
      };
    }).options.toolExecutor;
    const activated = await executor.execute({
      sessionId: session.sessionId,
      turnId: "turn_skill_activation" as TurnId,
      toolName: "activate_skill",
      input: { name: skillName },
      cwd: repoA,
    });
    expect(activated.status).toBe("completed");
    expect(activated.result?.output).toContain("WORKSPACE_A instructions");
    expect(activated.result?.output).not.toContain("WORKSPACE_B");
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness does not expose an opaque injected Bash runner to scoped workers", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  const injectedRunner: BashRunner = {
    async run() {
      throw new Error("injected runner must not be called by this test");
    },
  };
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      bashRunner: injectedRunner,
    });

    type ToolRegistryView = { list(): Array<{ name: string }> };
    const rootRegistry = (harness.runtime as unknown as {
      options: { toolRegistry: ToolRegistryView };
    }).options.toolRegistry;
    const childRegistry = (harness.agents as unknown as {
      options: {
        runtime?: {
          options: {
            runtime: { options: { toolRegistry: ToolRegistryView } };
          };
        };
      };
    }).options.runtime?.options.runtime.options.toolRegistry;

    expect(rootRegistry.list().some((tool) => tool.name === "bash")).toBe(true);
    expect(childRegistry?.list().some((tool) => tool.name === "bash")).toBe(false);
    expect(rootRegistry.list().some((tool) => tool.name === "delegation_status")).toBe(true);
    expect(rootRegistry.list().some((tool) => tool.name === "delegation_set")).toBe(true);
    expect(childRegistry?.list().some((tool) => tool.name === "delegation_status")).toBe(false);
    expect(childRegistry?.list().some((tool) => tool.name === "delegation_set")).toBe(false);
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI task tool adapter forwards the tool AbortSignal to task follow-up", async () => {
  let receivedSignal: AbortSignal | undefined;
  const task: AgentTaskRow = {
    id: "task_signal" as TaskId,
    path: "/root/task_signal" as AgentPath,
    taskName: "signal worker",
    parentSessionId: "session_signal" as SessionId,
    status: "completed",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  const tasks = {
    async getTask() {
      return task;
    },
    async followupTask(input: { signal?: AbortSignal }) {
      receivedSignal = input.signal;
      return {
        task,
        result: { status: "completed", turns: [], finishReason: "stop" },
      };
    },
  } as unknown as AgentTaskControlService;
  const controller = createSubagentControlController(
    tasks,
    {} as AgentTreeControlService,
  );
  const context = agentMessageToolContext(
    "/repo",
    "session_signal" as SessionId,
  );

  await controller.followupTask({ taskId: task.id, prompt: "continue" }, context);

  expect(receivedSignal).toBe(context.signal);
});

test("CLI task and mailbox controls reject targets owned by another root session", async () => {
  const sessionId = "session_control_current" as SessionId;
  const otherSessionId = "session_control_other" as SessionId;
  const currentChildSessionId = "session_control_current_child" as SessionId;
  const otherChildSessionId = "session_control_other_child" as SessionId;
  const sharedPath = "/root/shared" as AgentPath;
  const currentTask: AgentTaskRow = {
    id: "task_control_current" as TaskId,
    path: sharedPath,
    taskName: "current worker",
    parentSessionId: sessionId,
    childSessionId: currentChildSessionId,
    status: "completed",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  const otherTask: AgentTaskRow = {
    id: "task_control_other" as TaskId,
    path: sharedPath,
    taskName: "other worker",
    parentSessionId: otherSessionId,
    childSessionId: otherChildSessionId,
    status: "completed",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  const mailbox: AgentMailboxRow[] = [
    {
      id: "message_control_current",
      path: sharedPath,
      fromPath: "/root" as AgentPath,
      triggerTurn: false,
      status: "queued",
      taskId: currentTask.id,
      recipientSessionId: currentChildSessionId,
      createdAt: 1,
    },
    {
      id: "message_control_other",
      path: sharedPath,
      fromPath: "/root" as AgentPath,
      triggerTurn: false,
      status: "queued",
      taskId: otherTask.id,
      recipientSessionId: otherChildSessionId,
      createdAt: 2,
    },
    {
      id: "message_control_mismatched",
      path: sharedPath,
      fromPath: "/root" as AgentPath,
      triggerTurn: false,
      status: "queued",
      taskId: currentTask.id,
      recipientSessionId: otherChildSessionId,
      createdAt: 3,
    },
  ];
  let followupCalls = 0;
  let closeCalls = 0;
  let consumeCalls = 0;
  const tasks = {
    async getTask(taskId: TaskId) {
      const task = [currentTask, otherTask].find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Agent task not found: ${taskId}`);
      return task;
    },
    async listTasks() {
      // Deliberately ignore the query so the controller must enforce ownership itself.
      return [currentTask, otherTask];
    },
    async followupTask() {
      followupCalls += 1;
      return {
        task: otherTask,
        result: { status: "completed", turns: [], finishReason: "stop" },
      };
    },
    async closeTask() {
      closeCalls += 1;
      return otherTask;
    },
  } as unknown as AgentTaskControlService;
  const agents = {
    async mailbox(query?: { messageId?: string }) {
      return query?.messageId
        ? mailbox.filter((message) => message.id === query.messageId)
        : mailbox;
    },
    async consumeMailbox() {
      consumeCalls += 1;
      return mailbox[0];
    },
  } as unknown as AgentTreeControlService;
  const controller = createSubagentControlController(tasks, agents);
  const context = agentMessageToolContext("/repo", sessionId);

  await expect(controller.followupTask({
    taskId: otherTask.id,
    prompt: "continue foreign work",
  }, context)).rejects.toThrow(`Agent task is not visible to this session: ${otherTask.id}`);
  await expect(controller.closeTask({ taskId: otherTask.id }, context)).rejects.toThrow(
    `Agent task is not visible to this session: ${otherTask.id}`,
  );
  expect(followupCalls).toBe(0);
  expect(closeCalls).toBe(0);
  expect(await controller.listTasks({ all: true }, context)).toEqual([
    expect.objectContaining({ taskId: currentTask.id }),
  ]);

  for (const input of [
    { all: true },
    { path: sharedPath },
  ]) {
    expect(await controller.listMailbox(input, context)).toEqual([
      expect.objectContaining({ messageId: "message_control_current" }),
    ]);
  }
  expect(await controller.listMailbox({ taskId: otherTask.id }, context)).toEqual([]);
  await expect(controller.consumeMailbox({
    messageId: "message_control_mismatched",
  }, context)).rejects.toThrow("Mailbox message is not visible to this session");
  expect(consumeCalls).toBe(0);
});

test("CLI complete_task cannot complete or abort sibling and foreign runs", async () => {
  const sessionId = "session_complete_owner" as SessionId;
  const siblingSessionId = "session_complete_sibling" as SessionId;
  const otherSessionId = "session_complete_other" as SessionId;
  const rows: AgentTaskRow[] = [
    {
      id: "task_complete_owner" as TaskId,
      path: "/root/owner" as AgentPath,
      taskName: "owner",
      parentSessionId: "session_complete_parent" as SessionId,
      childSessionId: sessionId,
      status: "running",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "task_complete_sibling" as TaskId,
      path: "/root/sibling" as AgentPath,
      taskName: "sibling",
      parentSessionId: "session_complete_parent" as SessionId,
      childSessionId: siblingSessionId,
      status: "running",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "task_complete_foreign" as TaskId,
      path: "/root/foreign" as AgentPath,
      taskName: "foreign",
      parentSessionId: otherSessionId,
      childSessionId: "session_complete_foreign_child" as SessionId,
      status: "running",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  let targetRunAbortCalls = 0;
  const tasks = {
    async getTask(taskId: TaskId) {
      const task = rows.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Agent task not found: ${taskId}`);
      return task;
    },
    async listTasks(query: { childSessionId?: SessionId }) {
      return rows.filter((task) => task.childSessionId === query.childSessionId);
    },
    async completeTask() {
      targetRunAbortCalls += 1;
      throw new Error("must not abort target run");
    },
  } as unknown as AgentTaskControlService;
  const fallback = {
    async completeTask() {
      targetRunAbortCalls += 1;
      throw new Error("must not abort fallback run");
    },
  } as unknown as import("@chili/tools").SubagentController;
  const controller = createCompleteTaskController(tasks, fallback);
  const context = agentMessageToolContext("/repo", sessionId);

  for (const taskId of [rows[1]?.id, rows[2]?.id]) {
    await expect(controller.completeTask({
      taskId: taskId as TaskId,
      summary: "forged completion",
    }, context)).rejects.toThrow(`Agent task cannot be completed by this session: ${taskId}`);
  }
  expect(targetRunAbortCalls).toBe(0);
});

test("CLI team tools isolate teams and descendant session bindings between roots", async () => {
  const sessionId = "session_team_scope_current" as SessionId;
  const otherSessionId = "session_team_scope_other" as SessionId;
  const teamId = "team_scope_current" as TeamId;
  const otherTeamId = "team_scope_other" as TeamId;
  const teamPath = "/root" as AgentPath;
  const memberPath = "/root/member" as AgentPath;
  const teamRows = [
    {
      id: teamId,
      sessionId,
      name: "current team",
      leadPath: teamPath,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: otherTeamId,
      sessionId: otherSessionId,
      name: "other team",
      leadPath: teamPath,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  let addMemberCalls = 0;
  let createTaskCalls = 0;
  let createTeamCalls = 0;
  const teams = {
    async listTeams() {
      return teamRows;
    },
    async members(targetTeamId: TeamId) {
      const ownerSessionId = targetTeamId === teamId ? sessionId : otherSessionId;
      return [{
        teamId: targetTeamId,
        path: teamPath,
        name: "lead",
        role: "leader",
        status: "running" as const,
        childSessionId: ownerSessionId,
        createdAt: 1,
        updatedAt: 1,
      }];
    },
    async addMember() {
      addMemberCalls += 1;
      throw new Error("must not mutate");
    },
    async createTeam() {
      createTeamCalls += 1;
      throw new Error("must not mutate");
    },
    async createTask() {
      createTaskCalls += 1;
      throw new Error("must not mutate");
    },
  } as unknown as TeamControlService;
  const directChildSessionId = "session_team_scope_child" as SessionId;
  const foreignChildSessionId = "session_team_scope_foreign_child" as SessionId;
  const duplicateChildSessionId = "session_team_scope_duplicate_child" as SessionId;
  const taskRows: AgentTaskRow[] = [
    {
      id: "task_team_scope_child" as TaskId,
      path: memberPath,
      taskName: "member",
      parentSessionId: sessionId,
      childSessionId: directChildSessionId,
      status: "completed",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "task_team_scope_foreign" as TaskId,
      path: memberPath,
      taskName: "foreign member",
      parentSessionId: otherSessionId,
      childSessionId: foreignChildSessionId,
      status: "completed",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ...[0, 1].map((index): AgentTaskRow => ({
      id: `task_team_scope_duplicate_${index}` as TaskId,
      path: memberPath,
      taskName: `duplicate ${index}`,
      parentSessionId: sessionId,
      childSessionId: duplicateChildSessionId,
      status: "completed",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
  ];
  const tasks = {
    async listTasks(query: { childSessionId?: SessionId }) {
      return taskRows.filter((task) => (
        query.childSessionId ? task.childSessionId === query.childSessionId : true
      ));
    },
  } as unknown as AgentTaskControlService;
  const controller = createTeamToolController(teams, tasks, "root");
  const context = agentMessageToolContext("/repo", sessionId);

  await expect(controller.createTeam({
    name: "spoofed root team",
    leadPath: "/root/fake",
  }, context)).rejects.toThrow("does not match current agent /root");
  const childController = createTeamToolController(teams, tasks, "child");
  await expect(childController.createTeam({
    name: "spoofed child team",
    leadPath: "/root",
  }, agentMessageToolContext("/repo", directChildSessionId))).rejects.toThrow(
    "does not match current agent /root/member",
  );
  expect(createTeamCalls).toBe(0);

  expect(await controller.listTeams({}, context)).toEqual([
    expect.objectContaining({ teamId }),
  ]);
  await expect(controller.createTask({
    teamId: otherTeamId,
    title: "cross-root mutation",
  }, context)).rejects.toThrow(`Team is not visible to this session: ${otherTeamId}`);
  expect(createTaskCalls).toBe(0);

  for (const childSessionId of [
    foreignChildSessionId,
    sessionId,
    duplicateChildSessionId,
  ]) {
    await expect(controller.addMember({
      teamId,
      path: memberPath,
      name: "attacker",
      role: "worker",
      childSessionId,
    }, context)).rejects.toThrow("Team member session is not a unique visible descendant");
  }
  expect(addMemberCalls).toBe(0);
});

test("CLI child team task updates are marked as scoped worker mutations", async () => {
  const ownerSessionId = "session_team_update_owner" as SessionId;
  const workerSessionId = "session_team_update_worker" as SessionId;
  const teamId = "team_update_scope" as TeamId;
  const taskId = "task_update_scope" as TaskId;
  const workerPath = "/root/worker" as AgentPath;
  const updates: Array<Record<string, unknown>> = [];
  const teams = {
    async listTeams() {
      return [{
        id: teamId,
        sessionId: ownerSessionId,
        name: "update scope",
        leadPath: "/root" as AgentPath,
        status: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      }];
    },
    async members() {
      return [{
        teamId,
        path: workerPath,
        name: "worker",
        role: "implementer",
        status: "running" as const,
        childSessionId: workerSessionId,
        createdAt: 1,
        updatedAt: 1,
      }];
    },
    async updateTask(input: Record<string, unknown>) {
      updates.push(input);
      return {
        id: taskId,
        teamId,
        status: "in_progress" as const,
        title: "scoped update",
        ownerPath: workerPath,
        dependsOn: [],
        summary: input.summary as string | undefined,
        createdAt: 1,
        updatedAt: 2,
      };
    },
  } as unknown as TeamControlService;
  const tasks = {} as AgentTaskControlService;

  await createTeamToolController(teams, tasks, "child").updateTask({
    teamId,
    taskId,
    status: "in_progress",
    summary: "halfway",
  }, agentMessageToolContext("/repo", workerSessionId));
  expect(updates[0]).toMatchObject({
    sessionId: workerSessionId,
    actorScope: "scoped_worker",
    teamId,
    taskId,
    status: "in_progress",
    summary: "halfway",
  });

  await createTeamToolController(teams, tasks, "root").updateTask({
    teamId,
    taskId,
    status: "completed",
  }, agentMessageToolContext("/repo", ownerSessionId));
  expect(updates[1]).not.toHaveProperty("actorScope");
});

test("CLI agent message controllers bind senders, list descendants, and isolate root sessions", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  const rootSessionId = "session_message_root" as SessionId;
  const workerSessionId = "session_message_worker" as SessionId;

  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    await harness.events.appendMany([
      agentMessageTaskCreated({
        id: "task_message_worker" as TaskId,
        path: "/root/worker" as AgentPath,
        parentPath: "/root" as AgentPath,
        taskName: "worker",
        parentSessionId: rootSessionId,
        childSessionId: workerSessionId,
      }),
      agentMessageTaskCreated({
        id: "task_message_nested" as TaskId,
        path: "/root/worker/reader" as AgentPath,
        parentPath: "/root/worker" as AgentPath,
        taskName: "nested-reader",
        parentSessionId: workerSessionId,
        childSessionId: "session_message_nested" as SessionId,
      }),
    ]);

    type ToolRegistryView = { get(name: string): ChiliToolDefinition | undefined };
    const rootRegistry = (harness.runtime as unknown as {
      options: { toolRegistry: ToolRegistryView };
    }).options.toolRegistry;
    const childRegistry = (harness.agents as unknown as {
      options: {
        runtime?: {
          options: {
            runtime: { options: { toolRegistry: ToolRegistryView } };
          };
        };
      };
    }).options.runtime?.options.runtime.options.toolRegistry;
    const rootSend = rootRegistry.get("agent_message_send");
    const rootList = rootRegistry.get("agent_message_list");
    const childSend = childRegistry?.get("agent_message_send");
    expect(rootSend).toBeDefined();
    expect(rootList).toBeDefined();
    expect(childSend).toBeDefined();

    await expect(rootSend?.execute({
      messageId: "message_nested_from_root",
      to: "nested-reader",
      content: "nested context",
      delivery: "queueOnly",
    }, agentMessageToolContext(repo, rootSessionId))).resolves.toMatchObject({
      metadata: { messageId: "message_nested_from_root", from: "/root", to: "/root/worker/reader" },
    });
    await harness.agents.sendMessage({
      messageId: "message_current_root",
      from: "/root/worker" as AgentPath,
      to: "/root",
      content: "private to the current root session",
      delivery: "queueOnly",
      recipientSessionId: rootSessionId,
      sessionId: workerSessionId,
    });
    await harness.agents.sendMessage({
      messageId: "message_other_root",
      from: "/root" as AgentPath,
      to: "/root",
      content: "private to another root session",
      delivery: "queueOnly",
      recipientSessionId: "session_message_other_root" as SessionId,
      sessionId: "session_message_other_root" as SessionId,
    });
    await harness.events.append({
      id: "message_mismatched_scope",
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      sessionId: rootSessionId,
      payload: {
        path: "/root" as AgentPath,
        from: "/root/worker" as AgentPath,
        triggerTurn: false,
        taskId: "task_message_worker" as TaskId,
        recipientSessionId: "session_message_other_root" as SessionId,
        message: { role: "user", content: "corrupt mixed ownership metadata" },
      },
    });
    const listed = await rootList?.execute({}, agentMessageToolContext(repo, rootSessionId));
    const listedOutput = JSON.parse(listed?.output ?? "{}") as {
      count?: number;
      messages?: Array<{ message_id?: string; to_path?: string }>;
    };
    expect(listedOutput.count).toBe(2);
    expect(listedOutput.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ message_id: "message_nested_from_root", to_path: "/root/worker/reader" }),
      expect.objectContaining({ message_id: "message_current_root", to_path: "/root" }),
    ]));
    expect(listed?.output).not.toContain("message_other_root");
    expect(listed?.output).not.toContain("message_mismatched_scope");

    await expect(childSend?.execute({
      from: "/root",
      to: "parent",
      content: "spoof",
    }, agentMessageToolContext(repo, workerSessionId))).rejects.toThrow(
      "does not match current agent /root/worker",
    );
    await expect(childSend?.execute({
      to: "parent",
      content: "orphan must not become root",
    }, agentMessageToolContext(
      repo,
      "session_message_orphan" as SessionId,
    ))).rejects.toThrow("sender is unavailable for child session");
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness keeps failed MCP status out of root and child prompt fragments", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "mcp.json"), JSON.stringify({
      mcpServers: {
        broken: {
          command: "sh",
          args: ["-c", "exit 99"],
          enabled: true,
        },
      },
    }), "utf8");

    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "eager",
    });
    expect((await harness.mcp.status?.())?.servers[0]).toMatchObject({
      name: "broken",
      status: "error",
    });

    type PromptFragmentsProvider = (input: {
      sessionId: SessionId;
      cwd: string;
    }) => Promise<PromptFragment[]> | PromptFragment[];
    const rootProvider = (harness.service as unknown as {
      options: { promptFragments?: PromptFragmentsProvider };
    }).options.promptFragments;
    const childProvider = (harness.agents as unknown as {
      options: {
        runtime?: {
          options: { promptFragments?: PromptFragmentsProvider };
        };
      };
    }).options.runtime?.options.promptFragments;
    expect(rootProvider).toBeDefined();
    expect(childProvider).toBeDefined();
    const input = {
      sessionId: "session_mcp_prompt" as SessionId,
      cwd: repo,
    };
    const [rootFragments, childFragments] = await Promise.all([
      Promise.resolve(rootProvider?.(input) ?? []),
      Promise.resolve(childProvider?.(input) ?? []),
    ]);

    for (const fragments of [rootFragments, childFragments]) {
      expect(fragments.some((fragment) => fragment.id === "chili.base")).toBe(true);
      expect(fragments.some((fragment) => fragment.id === "mcp.server.status")).toBe(false);
      expect(fragments.some((fragment) => fragment.content.includes("exit 99"))).toBe(false);
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness resolves root and child approval policy from each persisted session cwd", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const repoBLink = join(root, "repo-b-link");
  const parentA = "session_policy_harness_parent_a" as SessionId;
  const parentB = "session_policy_harness_parent_b" as SessionId;
  const childA = "session_policy_harness_child_a" as SessionId;
  const childB = "session_policy_harness_child_b" as SessionId;
  let harness: CliHarness | undefined;
  try {
    await mkdir(join(repoA, ".chili"), { recursive: true });
    await mkdir(join(repoB, ".chili"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(repoA, ".chili", "config.toml"),
      '[permissions]\ndeny = ["workspace.guard(a-only)"]\n',
      "utf8",
    );
    await writeFile(
      join(repoB, ".chili", "config.toml"),
      '[permissions]\ndeny = ["workspace.guard(b-only)"]\n',
      "utf8",
    );
    await symlink(repoB, repoBLink, "dir");

    harness = await createCliHarness({
      cwd: repoA,
      chiliHome: home,
      model: "fake",
      quiet: true,
      mcpConnectMode: "manual",
    });
    await harness.service.createSession({ sessionId: parentA, cwd: repoA });
    await harness.service.createSession({ sessionId: parentB, cwd: repoBLink });
    await harness.service.createSession({ sessionId: childA, cwd: repoA });
    await harness.service.createSession({ sessionId: childB, cwd: repoBLink });

    await harness.events.append({
      id: "event_policy_harness_spawn_b",
      type: "agent.spawned",
      time: 1 as TimestampMs,
      sessionId: parentB,
      payload: {
        runId: "run_policy_harness_child_b" as never,
        path: "/root/child-b" as AgentPath,
        taskName: "child-b",
        parentSessionId: parentB,
        childSessionId: childB,
      },
    });
    await harness.events.append({
      id: "event_policy_harness_spawn_a",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId: parentA,
      payload: {
        runId: "run_policy_harness_child_a" as never,
        path: "/root/child-a" as AgentPath,
        taskName: "child-a",
        parentSessionId: parentA,
        childSessionId: childA,
      },
    });

    type RuntimeWithApprovals = {
      options: { toolExecutor: { options: { approvals: PolicyApprovalBroker } } };
    };
    type ServiceWithRuntime = { options: { runtime: RuntimeWithApprovals } };
    const rootBroker = (harness.runtime as unknown as RuntimeWithApprovals).options.toolExecutor.options.approvals;
    const childService = (harness.agents as unknown as { options: { runtime: ServiceWithRuntime } }).options.runtime;
    const childBroker = childService.options.runtime.options.toolExecutor.options.approvals;
    const preflight = (broker: PolicyApprovalBroker, sessionId: SessionId, pattern: string) => broker.preflight({
      sessionId,
      callId: `toolcall_policy_${sessionId}_${pattern}` as ToolCallId,
      toolName: "workspace_guard",
      risk: "write",
      permission: "workspace.guard",
      patterns: [pattern],
    });

    const [rootAA, rootBA, rootBB, rootAB, childAA, childBA, childBB, childAB] = await Promise.all([
      preflight(rootBroker, parentA, "a-only"),
      preflight(rootBroker, parentB, "a-only"),
      preflight(rootBroker, parentB, "b-only"),
      preflight(rootBroker, parentA, "b-only"),
      preflight(childBroker, childA, "a-only"),
      preflight(childBroker, childB, "a-only"),
      preflight(childBroker, childB, "b-only"),
      preflight(childBroker, childA, "b-only"),
    ]);
    expect(rootAA).toMatchObject({ action: "deny" });
    expect(rootBA).toMatchObject({ action: "ask" });
    expect(rootBB).toMatchObject({ action: "deny" });
    expect(rootAB).toMatchObject({ action: "ask" });
    expect(childAA).toMatchObject({ action: "deny" });
    expect(childBA).toMatchObject({ action: "ask" });
    expect(childBB).toMatchObject({ action: "deny" });
    expect(childAB).toMatchObject({ action: "ask" });

    const state = (rootBroker as unknown as { state: PolicyApprovalState }).state;
    expect((childBroker as unknown as { state: PolicyApprovalState }).state).toBe(state);
    state.addSessionGrant({
      sessionId: parentA,
      permission: "workspace.guard",
      patterns: ["a-only", "grant-from-a"],
      source: "test-parent-a",
    });
    state.addSessionGrant({
      sessionId: parentB,
      permission: "workspace.guard",
      patterns: ["b-only", "grant-from-b"],
      source: "test-parent-b",
    });
    expect(await preflight(childBroker, childA, "grant-from-a")).toMatchObject({
      action: "allow",
      source: "session_grant",
    });
    expect(await preflight(childBroker, childB, "grant-from-a")).toMatchObject({ action: "ask" });
    expect(await preflight(childBroker, childA, "a-only")).toMatchObject({ action: "deny" });
    expect(await preflight(childBroker, childB, "grant-from-b")).toMatchObject({
      action: "allow",
      source: "session_grant",
    });
    expect(await preflight(childBroker, childA, "grant-from-b")).toMatchObject({ action: "ask" });
    expect(await preflight(childBroker, childB, "b-only")).toMatchObject({ action: "deny" });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness approval resolver denies preflight and decide after session archival", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const sessionId = "session_policy_archived" as SessionId;
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      mcpConnectMode: "manual",
    });
    await harness.service.createSession({ sessionId, cwd: repo });
    const broker = (harness.runtime as unknown as {
      options: { toolExecutor: { options: { approvals: PolicyApprovalBroker } } };
    }).options.toolExecutor.options.approvals;
    const request = {
      sessionId,
      callId: "toolcall_policy_archived" as ToolCallId,
      toolName: "read",
      risk: "read" as const,
      permission: "read",
      patterns: ["README.md"],
    };

    expect(await broker.preflight(request)).toMatchObject({ action: "allow" });
    await harness.service.archiveSession(sessionId);
    expect(await broker.preflight(request)).toMatchObject({
      action: "deny",
      source: "session_workspace_policy",
      feedback: `Unable to resolve permission policy for session ${sessionId}.`,
    });
    expect(await broker.decide({
      ...request,
      approvalId: "approval_policy_archived" as ApprovalId,
    })).toEqual({
      action: "deny",
      feedback: `Unable to resolve permission policy for session ${sessionId}.`,
    });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness approval resolver denies archived and orphan subagent ancestry roots", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  const rootSessionId = "session_policy_root_archived" as SessionId;
  const childSessionId = "session_policy_child_active" as SessionId;
  const orphanSessionId = "session_policy_orphan_subagent" as SessionId;
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      mcpConnectMode: "manual",
    });
    await harness.service.createSession({ sessionId: rootSessionId, cwd: repo });
    await harness.service.createSession({ sessionId: childSessionId, cwd: repo });
    await harness.service.createSession({ sessionId: orphanSessionId, cwd: repo });
    await harness.events.append({
      id: "event_policy_archived_root_child",
      type: "agent.spawned",
      time: 1 as TimestampMs,
      sessionId: rootSessionId,
      payload: {
        runId: "run_policy_archived_root_child" as never,
        path: "/root/active-child" as AgentPath,
        taskName: "active-child",
        parentSessionId: rootSessionId,
        childSessionId,
      },
    });
    await harness.events.append({
      id: "event_policy_orphan_subagent",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      payload: {
        runId: "run_policy_orphan_subagent" as never,
        path: "/root/orphan" as AgentPath,
        taskName: "orphan",
        childSessionId: orphanSessionId,
      },
    });

    const beforeArchive = await harness.events.sessions();
    expect(beforeArchive.find((session) => session.id === childSessionId)).toMatchObject({
      source: "subagent",
      status: "active",
    });
    expect(beforeArchive.find((session) => session.id === orphanSessionId)).toMatchObject({
      source: "subagent",
      status: "active",
    });
    await harness.service.archiveSession(rootSessionId);
    const afterArchive = await harness.events.sessions();
    expect(afterArchive.find((session) => session.id === rootSessionId)?.status).toBe("archived");
    expect(afterArchive.find((session) => session.id === childSessionId)?.status).toBe("active");

    type RuntimeWithApprovals = {
      options: { toolExecutor: { options: { approvals: PolicyApprovalBroker } } };
    };
    type ServiceWithRuntime = { options: { runtime: RuntimeWithApprovals } };
    const childService = (harness.agents as unknown as { options: { runtime: ServiceWithRuntime } }).options.runtime;
    const broker = childService.options.runtime.options.toolExecutor.options.approvals;
    const request = (sessionId: SessionId, suffix: string) => ({
      sessionId,
      callId: `toolcall_policy_${suffix}` as ToolCallId,
      toolName: "read",
      risk: "read" as const,
      permission: "read",
      patterns: ["README.md"],
    });

    for (const [sessionId, suffix] of [
      [childSessionId, "archived_root"],
      [orphanSessionId, "orphan_root"],
    ] as const) {
      const approvalRequest = request(sessionId, suffix);
      expect(await broker.preflight(approvalRequest)).toMatchObject({
        action: "deny",
        source: "session_workspace_policy",
      });
      expect(await broker.decide({
        ...approvalRequest,
        approvalId: `approval_policy_${suffix}` as ApprovalId,
      })).toEqual({
        action: "deny",
        feedback: `Unable to resolve permission policy for session ${sessionId}.`,
      });
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness uses the user last model for new workspaces without forcing a prompt override", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await writeUserModelSelection(
      { provider: "openai-codex", model: "gpt-5.6-sol" },
      { chiliHome: home, now: () => 1 },
    );

    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_user_model" as SessionId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.6-sol" });
    expect(harness.defaultModelSelection).toBeUndefined();
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness applies default reasoning and service tier", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });

    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_default_tier" as SessionId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.reasoningLevel).toBe("xhigh");
    expect(config.serviceTier).toBe("fast");
    expect(harness.defaultReasoningLevel).toBe("xhigh");
    expect(harness.defaultServiceTier).toBe("fast");
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness prefers workspace model history over user last model", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(join(repo, ".chili"), { recursive: true });
    await writeUserModelSelection(
      { provider: "openai-codex", model: "gpt-5.5" },
      { chiliHome: home, now: () => 1 },
    );
    await writeWorkspaceModelEvent(repo, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_workspace_model" as SessionId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.modelSelection).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness persists setModel to the user last model state", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_set_model" as SessionId,
    });

    await harness.service.setModel({
      ...session,
      modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    });

    expect(await readUserModelSelection({ chiliHome: home })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt fragments inject explicitly mentioned skill bodies for one turn", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  try {
    await mkdir(repo, { recursive: true });
    const skillDir = join(repo, ".chili", "skills", "reviewer");
    await mkdir(join(skillDir, "templates"), { recursive: true });
    await writeFile(join(skillDir, "templates", "review.md"), "review template\n", "utf8");
    const skillRegistry = new SkillRegistry([skill("reviewer", "project", skillDir)]);
    const fragments = await buildCliPromptFragments({
      cwd: repo,
      skillRegistry,
      turn: {
        text: "please use $reviewer here",
      },
    });

    const body = fragments.find((fragment) => fragment.id === "chili.skill.reviewer");
    expect(body).toMatchObject({
      layer: "contextual_user",
      source: "skills",
      lifecycle: "turn",
      metadata: {
        kind: "skill_body",
        name: "reviewer",
        path: join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        skillFiles: ["templates/review.md"],
      },
    });
    expect(body?.content).toContain("<instructions>\nreview body\n</instructions>");
    expect(body?.content).toContain("<skill_files>\n- templates/review.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt fragments warn instead of choosing ambiguous plain skill mentions", async () => {
  const userSkill = skill("same", "user");
  const projectSkill = skill("same", "project");
  const fragments = await buildCliPromptFragments({
    cwd: "/repo",
    skillRegistry: new SkillRegistry([projectSkill], [], [userSkill, projectSkill]),
    turn: {
      text: "try $same",
    },
  });

  expect(fragments.some((fragment) => fragment.id.startsWith("chili.skill.same"))).toBe(false);
  expect(fragments.find((fragment) => fragment.id === "chili.skill_mentions.warnings")?.content).toContain("ambiguous");
});

test("CLI prompt fragments use structured skill path bindings for duplicate names", async () => {
  const userSkill = skill("same", "user");
  const projectSkill = skill("same", "project");
  const fragments = await buildCliPromptFragments({
    cwd: "/repo",
    skillRegistry: new SkillRegistry([projectSkill], [], [userSkill, projectSkill]),
    turn: {
      text: "try $same",
      skillMentions: [{ name: "same", path: userSkill.filePath }],
    },
  });

  const body = fragments.find((fragment) => fragment.id.startsWith("chili.skill.same"));
  expect(body?.metadata).toMatchObject({ name: "same", path: userSkill.filePath });
  expect(body?.content).toContain("review body");
  expect(fragments.some((fragment) => fragment.id === "chili.skill_mentions.warnings")).toBe(false);
});

test("CLI runPrompt leaves system prompt selection to the harness service", async () => {
  const submitted: Record<string, unknown>[] = [];
  const harness = {
    service: {
      submitPrompt: async (input: Record<string, unknown>) => {
        submitted.push(input);
        return { status: "completed", turns: [] };
      },
    },
  } as unknown as CliHarness;
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await runPrompt({
      harness,
      sessionId: "session_prompt" as SessionId,
      prompt: "hello",
      maxTurns: 3,
    });
  } finally {
    console.log = originalLog;
  }

  expect(submitted).toHaveLength(1);
  expect(submitted[0]).not.toHaveProperty("system");
});

test("CLI exact-session resume rejects a subagent session and points to task_followup", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  const parentSessionId = "session_cli_parent" as SessionId;
  const childSessionId = "session_cli_child" as SessionId;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    await harness.events.appendMany([
      {
        id: "event_session_cli_parent_created",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId: parentSessionId,
        payload: { sessionId: parentSessionId, cwd: repo },
      },
      {
        id: "event_session_cli_child_created",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId: childSessionId,
        payload: { sessionId: childSessionId, cwd: repo },
      },
      agentMessageTaskCreated({
        id: "task_cli_child" as TaskId,
        path: "/root/task_cli_child" as AgentPath,
        parentPath: "/root" as AgentPath,
        taskName: "cli child",
        parentSessionId,
        childSessionId,
      }),
    ]);

    await expect(runSessionPrompt({
      harness,
      sessionId: childSessionId,
      prompt: "resume by raw child session id",
      maxTurns: 1,
    })).rejects.toThrow("Use task_followup for the owning task");

    await harness.events.append({
      id: "event_task_cli_child_terminal",
      type: "agent.task_completed",
      time: 2 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        taskId: "task_cli_child" as TaskId,
        path: "/root/task_cli_child" as AgentPath,
        status: "completed",
        generation: 1,
        summary: "initial child turn complete",
      },
    });
    await expect(harness.tasks.followupTask({
      taskId: "task_cli_child" as TaskId,
      text: "resume through the authorized task lifecycle",
      maxTurns: 1,
    })).resolves.toMatchObject({
      task: { id: "task_cli_child" },
      result: { status: "completed" },
    });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exact-session resume rejects a pending child before session creation", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  const parentSessionId = "session_cli_pending_parent" as SessionId;
  const childSessionId = "session_cli_pending_child" as SessionId;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    await harness.events.append(agentMessageTaskCreated({
      id: "task_cli_pending_child" as TaskId,
      path: "/root/task_cli_pending_child" as AgentPath,
      parentPath: "/root" as AgentPath,
      taskName: "pending CLI child",
      parentSessionId,
      childSessionId,
    }));
    expect((await harness.events.sessions()).some((session) => session.id === childSessionId)).toBe(false);

    await expect(runSessionPrompt({
      harness,
      sessionId: childSessionId,
      prompt: "resume the capacity-queued child directly",
      maxTurns: 1,
    })).rejects.toThrow("Use task_followup for the owning task");
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI session prompts leave harness model defaults to Runtime normalization", async () => {
  const submitted: Record<string, unknown>[] = [];
  const harness = {
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M3[1m]" },
    defaultReasoningLevel: "high",
    defaultServiceTier: "fast",
    service: {
      submitPrompt: async (input: Record<string, unknown>) => {
        submitted.push(input);
        return { status: "completed", turns: [] };
      },
    },
  } as unknown as CliHarness;
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await runSessionPrompt({
      harness,
      sessionId: "session_normalized_defaults" as SessionId,
      prompt: "hello",
      maxTurns: 3,
    });
  } finally {
    console.log = originalLog;
  }

  expect(submitted).toHaveLength(1);
  expect(submitted[0]).not.toHaveProperty("modelSelection");
  expect(submitted[0]).not.toHaveProperty("reasoningLevel");
  expect(submitted[0]).not.toHaveProperty("serviceTier");
});

test("CLI runPrompt warns for every output-limit finish reason", async () => {
  let finishReason = "length";
  const harness = {
    service: {
      submitPrompt: async () => ({ status: "completed", turns: [], finishReason }),
    },
  } as unknown as CliHarness;
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = () => undefined;
    console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    for (const reason of ["length", "max_tokens", "max_output_tokens"]) {
      finishReason = reason;
      await runPrompt({
        harness,
        sessionId: "session_output_limit_warning" as SessionId,
        prompt: "hello",
        maxTurns: 1,
      });
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  expect(warnings).toEqual([
    "[warning] model stopped at length; response may be truncated",
    "[warning] model stopped at max_tokens; response may be truncated",
    "[warning] model stopped at max_output_tokens; response may be truncated",
  ]);
});

test("CLI prompt-debug text output shows manifest without content by default", () => {
  const output = promptDebugOutput(false);
  const text = formatPromptDebugText(output);

  expect(text).toContain("totalChars=31");
  expect(text).toContain("sessionId=session_prompt_debug");
  expect(text).toContain("cwd=/repo");
  expect(text).toContain("created=true");
  expect(text).toContain("id=debug.project");
  expect(text).toContain("layer=contextual_user");
  expect(text).toContain("source=project");
  expect(text).toContain("trust=project");
  expect(text).toContain("lifecycle=session");
  expect(text).toContain("priority=100");
  expect(text).toContain("chars=12");
  expect(text).toContain("path=/repo/AGENTS.md");
  expect(text).toContain("kind=project_instruction");
  expect(text).toContain("scope=project");
  expect(text).toContain("truncated=false");
  expect(text).not.toContain("SECRET fragment content");
  expect(text).not.toContain("--- fragment debug.project begin ---");
});

test("CLI prompt-debug content output includes fragment boundaries", () => {
  const text = formatPromptDebugText(promptDebugOutput(true));

  expect(text).toContain("--- fragment debug.project begin ---");
  expect(text).toContain("SECRET fragment content");
  expect(text).toContain("--- fragment debug.project end ---");
});

test("CLI prompt-debug json output is machine-readable and omits content unless requested", () => {
  const parsed = JSON.parse(formatPromptDebugJson(promptDebugOutput(false))) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    sessionId: "session_prompt_debug",
    cwd: "/repo",
    created: true,
  });
  expect(parsed).toHaveProperty("debug");
  expect(parsed).not.toHaveProperty("fragments");

  const parsedWithContent = JSON.parse(formatPromptDebugJson(promptDebugOutput(true))) as {
    fragments?: Array<{ content?: string }>;
  };
  expect(parsedWithContent.fragments?.some((fragment) => fragment.content === "SECRET fragment content")).toBe(true);
});

test("CLI child prompt fragments only inject follow-up context for the matching child session", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(repo, { recursive: true });
    const task = {
      id: "task_reader" as TaskId,
      path: "/root/task_reader" as AgentPath,
      status: "completed",
      taskName: "reader",
      generation: 1,
      childSessionId: "session_child" as SessionId,
      cwd: "/stale/task-projection",
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentTaskRow;
    const store = {
      agentTasks: async (query?: { childSessionId?: SessionId; limit?: number }) => {
        expect(query?.limit).toBe(10);
        return query?.childSessionId === task.childSessionId ? [task] : [];
      },
    } as unknown as Parameters<typeof buildCliChildPromptFragments>[0]["store"];
    const common = {
      cwd: repo,
      sessionId: "session_child" as SessionId,
      skillRegistry: new SkillRegistry([]),
      store,
      homeDir: home,
      projectRoot: repo,
    };

    const mismatched = await buildCliChildPromptFragments({ ...common, sessionId: "session_other" as SessionId });
    expect(mismatched.some((fragment) => fragment.id.startsWith("chili.task.followup."))).toBe(false);

    const matched = await buildCliChildPromptFragments(common);
    const followupFragment = matched.find((fragment) => fragment.id.startsWith("chili.task.followup."));
    expect(followupFragment).toEqual(
      expect.objectContaining({
        id: "chili.task.followup.task_reader",
        layer: "developer",
        source: "runtime",
      }),
    );
    expect(followupFragment?.content).toContain(`Repository cwd: ${repo}.`);
    expect(followupFragment?.content).not.toContain("/stale/task-projection");

    const duplicateStore = {
      agentTasks: async () => [
        task,
        {
          ...task,
          id: "task_duplicate" as TaskId,
          path: "/root/task_duplicate" as AgentPath,
        },
      ],
    } as unknown as Parameters<typeof buildCliChildPromptFragments>[0]["store"];
    await expect(buildCliChildPromptFragments({ ...common, store: duplicateStore })).rejects.toThrow(
      "Agent task metadata invariant violated: child session session_child maps to 2 tasks",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdtempName(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chili-harness-"));
}

class AbortAwareSlowModel implements ModelRouter {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();
  readonly finish = deferred<void>();
  onAbort?: () => void;

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.started.resolve();
    await new Promise<void>((resolvePromise) => {
      const onAbort = (): void => {
        this.onAbort?.();
        this.abortObserved.resolve();
        resolvePromise();
      };
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    await this.finish.promise;
    const error = new Error("slow model aborted during harness close");
    error.name = "AbortError";
    throw error;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function writeWorkspaceModelEvent(
  repo: string,
  modelSelection: { provider: string; model: string },
): Promise<void> {
  const sessionId = "session_previous_model" as SessionId;
  const store = new SqliteEventStore(join(repo, ".chili", "chili.sqlite"));
  const events: ChiliEvent[] = [
    {
      id: "event_previous_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: repo },
    },
    {
      id: "event_previous_model",
      type: "session.model_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, modelSelection },
    },
  ];
  try {
    for (const event of events) await store.append(event);
  } finally {
    store.close();
  }
}

function agentMessageTaskCreated(input: {
  id: TaskId;
  path: AgentPath;
  parentPath: AgentPath;
  taskName: string;
  parentSessionId: SessionId;
  childSessionId: SessionId;
}): ChiliEvent {
  return {
    id: `event_created_${input.id}`,
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: input.parentSessionId,
    payload: {
      taskId: input.id,
      path: input.path,
      parentPath: input.parentPath,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      taskName: input.taskName,
      cwd: "/repo",
      prompt: "work",
      mode: "resumable",
    },
  };
}

function agentMessageToolContext(
  cwd: string,
  sessionId: SessionId,
): ChiliToolExecutionContext {
  const callId = `call_agent_message_${sessionId}` as ToolCallId;
  return {
    cwd,
    sessionId,
    turnId: `turn_agent_message_${sessionId}` as TurnId,
    callId,
    outputArtifactId: callId,
    signal: new AbortController().signal,
    metadata: async () => {},
    streamOutput: async () => {},
    requestApproval: async () => ({ action: "allow_once" }),
    registerPersistedOutput: async () => {},
  };
}

function skill(name: string, source: Skill["source"] = "project", baseDir?: string): Skill {
  const resolvedBaseDir = baseDir ?? (source === "user" ? `/home/.chili/skills/${name}` : `/repo/.chili/skills/${name}`);
  return {
    name,
    source,
    filePath: join(resolvedBaseDir, "SKILL.md"),
    baseDir: resolvedBaseDir,
    metadata: {
      name,
      description: "Review code changes.",
      when_to_use: "When reviewing code.",
    },
    body: "review body",
  };
}

function harnessToolRegistries(harness: CliHarness): {
  root: { get(name: string): ChiliToolDefinition | undefined };
  child?: { get(name: string): ChiliToolDefinition | undefined };
} {
  type Registry = { get(name: string): ChiliToolDefinition | undefined };
  const root = (harness.runtime as unknown as { options: { toolRegistry: Registry } }).options.toolRegistry;
  const child = (harness.agents as unknown as {
    options: {
      runtime?: {
        options: {
          runtime: { options: { toolRegistry: Registry } };
        };
      };
    };
  }).options.runtime?.options.runtime.options.toolRegistry;
  return { root, ...(child ? { child } : {}) };
}

function promptDebugOutput(includeContent: boolean): CliPromptDebugOutput {
  const output: CliPromptDebugOutput = {
    sessionId: "session_prompt_debug" as SessionId,
    cwd: "/repo",
    created: true,
    debug: {
      totalChars: 31,
      fragments: [
        {
          id: "debug.base",
          layer: "base",
          source: "core",
          priority: 0,
          chars: 19,
          lifecycle: "stable",
          trust: "system",
        },
        {
          id: "debug.project",
          layer: "contextual_user",
          source: "project",
          priority: 100,
          chars: 12,
          lifecycle: "session",
          trust: "project",
          metadata: {
            path: "/repo/AGENTS.md",
            kind: "project_instruction",
            scope: "project",
            truncated: false,
            truncatedAfter: 5000,
            ruleType: "unconditional",
          },
        },
      ],
    },
  };
  if (!includeContent) return output;
  return {
    ...output,
    fragments: [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        chars: 19,
        lifecycle: "stable",
        trust: "system",
        content: "base fragment text",
      },
      {
        id: "debug.project",
        layer: "contextual_user",
        source: "project",
        priority: 100,
        chars: 12,
        lifecycle: "session",
        trust: "project",
        content: "SECRET fragment content",
        metadata: {
          path: "/repo/AGENTS.md",
          kind: "project_instruction",
          scope: "project",
          truncated: false,
        },
      },
    ],
  };
}
