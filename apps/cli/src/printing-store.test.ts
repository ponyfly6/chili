import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { TeamControlService, TeamTaskDispatchService, type TeamTaskSubagentRunner } from "@chili/core";
import type { AgentPath, AgentRunId, ChiliEvent, SessionId, TaskId, TeamId, ThreadId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

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
  const threadId = "thread_printing_task" as ThreadId;
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
        threadId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          parentThreadId: threadId,
          childSessionId: "session_printing_child" as SessionId,
          childThreadId: "thread_printing_child" as ThreadId,
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
        threadId,
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
        threadId,
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
      threadId,
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
  const subagents: TeamTaskSubagentRunner = {
    async spawnTask(input) {
      spawned.push(input.prompt);
      return {
        taskId: "agent_task_printing_dispatch" as TaskId,
        runId: "run_printing_dispatch" as AgentRunId,
        path: "/agents/worker/task" as AgentPath,
        parentPath: input.parentPath ?? ("/root" as AgentPath),
        childSessionId: "session_child_printing_dispatch" as SessionId,
        childThreadId: "thread_child_printing_dispatch" as ThreadId,
        status: "completed",
        summary: "worker completed",
      };
    },
  };
  const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir });
  const sessionId = "session_printing_dispatch" as SessionId;
  const teamId = "team_printing_dispatch" as TeamId;
  const taskId = "task_printing_dispatch" as TaskId;
  const workerPath = "/agents/worker" as AgentPath;

  try {
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
