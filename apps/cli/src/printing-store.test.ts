import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LocalSubagentManager, TeamControlService, TeamTaskDispatchService } from "@chili/core";
import type { AgentPath, AgentRunId, ChiliEvent, SessionId, TaskId, TeamId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

const PASSTHROUGH_SESSION_OPERATIONS = {
  async withSessionOperation<T>(
    _sessionId: SessionId,
    fn: (operation: { readonly signal: AbortSignal; assertCurrent(): void }) => Promise<T> | T,
  ): Promise<T> {
    return fn({ signal: new AbortController().signal, assertCurrent() {} });
  },
};

test("printing and observable wrappers report mailbox CAS capability recursively", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-mailbox-capability-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const projectionOnly = {
    append: sqlite.append.bind(sqlite),
    appendMany: sqlite.appendMany.bind(sqlite),
    events: sqlite.events.bind(sqlite),
    sessions: sqlite.sessions.bind(sqlite),
    messages: sqlite.messages.bind(sqlite),
    pendingApprovals: sqlite.pendingApprovals.bind(sqlite),
  };

  try {
    const capable = new PrintingEventStore(sqlite, printer);
    expect(capable.supportsAgentMailboxCapability("delivery")).toBe(true);
    expect(new ObservableEventStore(capable).supportsAgentMailboxCapability("delivery")).toBe(true);

    const projectionWrapper = new PrintingEventStore(projectionOnly, printer);
    expect(projectionWrapper.supportsAgentMailboxCapability("delivery")).toBe(false);
    expect(new ObservableEventStore(projectionWrapper).supportsAgentMailboxCapability("delivery")).toBe(false);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing and observable wrappers forward committed stale-turn recovery without duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-stale-recovery-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printed: ChiliEvent[] = [];
  const printer = new CliPrinter();
  printer.event = (event: ChiliEvent) => {
    printed.push(event);
  };
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const observed: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => observed.push(event));
  const sessionId = "session_printing_stale" as SessionId;
  const turnId = "turn_printing_stale" as TurnId;
  let recoveryId = 0;

  try {
    await store.appendMany([
      {
        id: "event_printing_stale_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: dir },
      },
      {
        id: "event_printing_stale_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running" },
      },
      {
        id: "event_printing_stale_turn",
        type: "turn.started",
        time: 3 as TimestampMs,
        sessionId,
        payload: { turnId },
      },
    ]);
    printed.length = 0;
    observed.length = 0;

    const recovered = await store.reconcileStaleTurns({
      staleBefore: 10,
      now: 11,
      status: "failed",
      reason: "stale_turn_recovered",
      createId: (prefix) => `${prefix}_printing_recovery_${++recoveryId}`,
    });

    expect(recovered.map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
    expect(printed).toEqual(recovered);
    expect(observed).toEqual(recovered);
    expect((await sqlite.events({ sessionId, type: "turn.completed", limit: 10 }))).toHaveLength(1);
    expect(await store.reconcileStaleTurns({
      staleBefore: 20,
      now: 21,
      createId: (prefix) => `${prefix}_duplicate_recovery`,
    })).toEqual([]);
    expect(printed).toEqual(recovered);
    expect(observed).toEqual(recovered);
  } finally {
    unsubscribe();
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing and observable wrappers forward session goal projections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-session-goal-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const sessionId = "session_printing_goal" as SessionId;

  try {
    await store.append({
      id: "event_printing_goal_updated",
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        reason: "set",
        goal: {
          sessionId,
          objective: "finish the CLI migration",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 25,
          timeUsedSeconds: 2,
          createdAt: 1 as TimestampMs,
          updatedAt: 2 as TimestampMs,
        },
      },
    });

    expect(await store.sessionGoal(sessionId)).toMatchObject({
      sessionId,
      objective: "finish the CLI migration",
      tokensUsed: 25,
    });
    expect(await store.sessionGoals({ sessionId, limit: 1 })).toHaveLength(1);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing store forwards atomic agent task run claims", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-task-run-claim-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printed: ChiliEvent[] = [];
  const printer = new CliPrinter();
  printer.event = (event: ChiliEvent) => {
    printed.push(event);
  };
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const sessionId = "session_printing_task" as SessionId;
  const taskId = "task_printing_task" as TaskId;
  const path = "/root/task_printing_task" as AgentPath;
  const initialRunId = "agent_printing_initial" as AgentRunId;

  try {
    await store.appendMany([
      {
        id: "event_printing_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          childSessionId: "session_printing_child" as SessionId,
          taskName: "printing worker",
          cwd: dir,
          prompt: "initial work",
          mode: "resumable",
        },
      },
      {
        id: "event_printing_task_spawned",
        type: "agent.spawned",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          runId: initialRunId,
          taskId,
          path,
          taskName: "printing worker",
          generation: 1,
        },
      },
      {
        id: "event_printing_task_completed",
        type: "agent.completed",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          runId: initialRunId,
          taskId,
          path,
          status: "completed",
          generation: 1,
          summary: "initial answer",
        },
      },
    ]);
    printed.length = 0;

    const result = await store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: 1,
      expectedRunId: initialRunId,
      expectedLeaseOwner: null,
      runId: "agent_printing_followup" as AgentRunId,
      generation: 2,
      leaseOwner: "followup:agent_printing_followup",
      leaseTtlMs: 100,
      messageEventId: "event_printing_followup_message",
      messageClaimEventId: "event_printing_followup_message_claimed",
      spawnEventId: "event_printing_followup_spawned",
      from: "/root" as AgentPath,
      message: { role: "user", content: "continue" },
      sessionId,
      time: 4,
    });

    expect(result.applied).toBe(true);
    expect(result.task).toMatchObject({ id: taskId, status: "running", generation: 2 });
    expect(printed.map((event) => event.type)).toEqual([
      "agent.message_queued",
      "agent.message_claimed",
      "agent.spawned",
    ]);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing store forwards team task claims through the observable store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-team-claim-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const teams = new TeamControlService({ store });
  const sessionId = "session_printing_claim" as SessionId;
  const teamId = "team_printing_claim" as TeamId;
  const taskId = "task_printing_claim" as TaskId;
  const workerPath = "/agents/worker" as AgentPath;

  try {
    await teams.createTeam({ sessionId, teamId, name: "printing claim", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId, taskId, title: "Claim me", ownerPath: workerPath });

    const claimed = await teams.claimTask({ sessionId, teamId, taskId, ownerPath: workerPath });

    expect(claimed.applied).toBe(true);
    expect(claimed.task).toMatchObject({
      id: taskId,
      status: "in_progress",
      ownerPath: workerPath,
    });
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team dispatcher can claim through printing store before spawning a worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-team-dispatch-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const teams = new TeamControlService({ store });
  const spawned: string[] = [];
  const subagents = new LocalSubagentManager({
    store,
    runner: {
      async run(input) {
      spawned.push(input.prompt);
      return {
        status: "completed",
        summary: "worker completed",
      };
      },
    },
  });
  const sessionId = "session_printing_dispatch" as SessionId;
  const teamId = "team_printing_dispatch" as TeamId;
  const taskId = "task_printing_dispatch" as TaskId;
  const workerPath = "/agents/worker" as AgentPath;
  const dispatcher = new TeamTaskDispatchService({
    teams,
    subagents,
    store,
    cwd: dir,
    resolveSession: async (requestedSessionId) => {
      const session = (await store.sessions()).find((candidate) => candidate.id === requestedSessionId);
      if (!session) throw new Error(`Session not found: ${requestedSessionId}`);
      if (session.status !== "active") throw new Error(`Session is not active: ${requestedSessionId}`);
      if (session.source !== "interactive") throw new Error(`Session is not a root session: ${requestedSessionId}`);
      return { cwd: session.cwd };
    },
    sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
  });

  try {
    await store.append({
      id: "event_printing_dispatch_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: dir },
    });
    await teams.createTeam({ sessionId, teamId, name: "printing dispatch", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId, taskId, title: "Dispatch me", ownerPath: workerPath });

    const dispatched = await dispatcher.dispatchTask({ sessionId, teamId, taskId, mode: "one_shot" });

    expect(dispatched.status).toBe("completed");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain(`Team task: ${teamId}/${taskId}`);
    expect(dispatched.teamTask).toMatchObject({
      id: taskId,
      status: "completed",
      summary: "worker completed",
    });
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
