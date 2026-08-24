import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPath, ApprovalDecision, SessionId, TeamId, TimestampMs, ToolCallId, TurnId } from "../packages/protocol/src/index.js";
import {
  LocalSubagentManager,
  TeamControlService,
  TeamExecutionRunner,
  TeamTaskDispatchService,
  type LocalSubagentRunInput,
  type LocalSubagentRunResult,
  type LocalSubagentRunner,
} from "../packages/core/src/index.js";
import { SqliteEventStore, type TeamTaskRow } from "../packages/store/src/index.js";
import {
  createTeamTaskCreateBatchTool,
  createTeamRunLoopTool,
  type TeamRunLoopRecord,
  type TeamRunLoopToolController,
  type TeamRunLoopToolInput,
  type TeamTaskCreateToolInput,
  type TeamTaskRecord,
  type TeamToolController,
  type TeamToolContext,
} from "../packages/tools/src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "chili-p3-team-parallel-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p3-team-parallel-smoke" }, null, 2), "utf8");

  const store = new SqliteEventStore(join(workspace, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 10_000 as TimestampMs;
  const sessionId = "session_team_parallel_smoke" as SessionId;
  const leadPath = "/root" as AgentPath;
  const coreWorker = "/root/core" as AgentPath;
  const docsWorker = "/root/docs" as AgentPath;
  const runner = new ParallelSmokeRunner();

  try {
    await store.append({
      id: "event_team_parallel_smoke_session",
      type: "session.created",
      time: now(),
      sessionId,
      payload: { sessionId, cwd: workspace },
    });
    const persistedSession = (await store.sessions()).find((candidate) => candidate.id === sessionId);
    assert.ok(persistedSession, "smoke parent session was not persisted");
    assert.equal(persistedSession.status, "active");
    assert.equal(persistedSession.source, "interactive");
    assert.equal(persistedSession.cwd, workspace);
    const resolveSession = async (requestedSessionId: SessionId) => {
      const session = (await store.sessions()).find((candidate) => candidate.id === requestedSessionId);
      assert.ok(session, `Session not found: ${requestedSessionId}`);
      assert.equal(session.status, "active", `Session is not active: ${requestedSessionId}`);
      assert.equal(session.source, "interactive", `Session is not a root session: ${requestedSessionId}`);
      return { cwd: session.cwd };
    };
    const sessionOperations = {
      async withSessionOperation<T>(
        _sessionId: SessionId,
        fn: (operation: { readonly signal: AbortSignal; assertCurrent(): void }) => Promise<T> | T,
      ): Promise<T> {
        return fn({ signal: new AbortController().signal, assertCurrent() {} });
      },
    };

    const teams = new TeamControlService({ store, createId: ids, now, sessionOperations });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: workspace,
      now,
      resolveSession,
      sessionOperations,
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: workspace,
      now,
      resolveSession,
      sessionOperations,
    });

    const team = await teams.createTeam({ sessionId, name: "parallel smoke", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: coreWorker,
      name: "core",
      role: "implementer",
      writeScope: ["packages/core"],
      toolScope: ["edit", "bash"],
    });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: docsWorker,
      name: "docs",
      role: "implementer",
      writeScope: ["docs"],
      toolScope: ["edit"],
    });

    await createScopedTasksWithTool(teams, team.id, sessionId, workspace);

    const dispatch = await runTeamLoopWithTool(execution, team.id, sessionId, workspace, {
      teamId: team.id,
      once: true,
      maxConcurrentDispatches: 2,
    });
    assert.equal(dispatch.errors.length, 0, JSON.stringify(dispatch.errors));
    assert.deepEqual(dispatch.blocked, []);
    assert.match(JSON.stringify(dispatch.dispatched), /task_core/);
    assert.match(JSON.stringify(dispatch.dispatched), /task_docs/);
    assert.ok(dispatch.dispatched.some((item) => item.taskId === "task_core" && item.ownerPath === coreWorker));
    assert.ok(dispatch.dispatched.some((item) => item.taskId === "task_docs" && item.ownerPath === docsWorker));

    await subagents.waitForBackgroundTasks();
    assert.equal(runner.maxRunning, 2, `expected parallel workers, saw max ${runner.maxRunning}`);
    assert.ok(runner.runs.some((run) => run.taskName === "Core implementation" && run.workerPolicy?.allowedTools?.includes("edit")));
    assert.ok(runner.runs.some((run) => run.taskName === "Docs implementation" && run.workerPolicy?.writeScope?.includes("docs")));

    const reconciled = await runTeamLoopWithTool(execution, team.id, sessionId, workspace, {
      teamId: team.id,
      once: true,
      maxConcurrentDispatches: 2,
    });
    assert.equal(reconciled.errors.length, 0, JSON.stringify(reconciled.errors));
    assert.ok(reconciled.completed.some((item) => item.taskId === "task_core"));
    assert.ok(reconciled.completed.some((item) => item.taskId === "task_docs"));

    const stored = await teams.tasks(team.id);
    assert.equal(stored.find((task) => task.id === "task_core")?.status, "completed");
    assert.equal(stored.find((task) => task.id === "task_docs")?.status, "completed");
    console.log("P3 team parallel smoke ok");
  } finally {
    store.close();
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function runTeamLoopWithTool(
  execution: TeamExecutionRunner,
  teamId: TeamId,
  sessionId: SessionId,
  cwd: string,
  input: TeamRunLoopToolInput,
): Promise<TeamRunLoopRecord> {
  const controller = {
    async runTeam(runInput: TeamRunLoopToolInput): Promise<TeamRunLoopRecord> {
      return execution.run({
        teamId: runInput.teamId as TeamId,
        sessionId,
        cwd,
        once: runInput.once,
        mode: runInput.mode,
        maxCycles: runInput.maxCycles,
        timeoutMs: runInput.timeoutMs,
        pollIntervalMs: runInput.pollIntervalMs,
        maxConcurrentDispatches: runInput.maxConcurrentDispatches,
      });
    },
  } as TeamRunLoopToolController;
  const tool = createTeamRunLoopTool(controller);
  const validated = await tool.validate?.({ ...input, team_id: teamId, timeout_ms: 10_000 });
  assert.ok(validated?.ok, validated && "message" in validated ? validated.message : "validation failed");
  const result = await tool.execute(validated.value, toolContext(sessionId, cwd));
  return JSON.parse(result.output) as TeamRunLoopRecord;
}

async function createScopedTasksWithTool(
  teams: TeamControlService,
  teamId: TeamId,
  sessionId: SessionId,
  cwd: string,
): Promise<void> {
  const controller = {
    async createTask(input: TeamTaskCreateToolInput): Promise<TeamTaskRecord> {
      const task = await teams.createTask({
        teamId: input.teamId as TeamId,
        taskId: input.taskId,
        title: input.title,
        sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy as AgentPath } : {}),
        ...(input.ownerPath ? { ownerPath: input.ownerPath as AgentPath } : {}),
        ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      return toTeamTaskRecord(task);
    },
  } as unknown as TeamToolController;
  const tool = createTeamTaskCreateBatchTool(controller);
  const input = {
    team_id: teamId,
    created_by: "/root",
    tasks: [
      {
        task_id: "task_core",
        title: "Core implementation",
        write_scope: ["packages/core/src"],
        required_tools: ["edit"],
        suggested_test_commands: ["bun test packages/core/src/team-execution-runner.test.ts"],
      },
      {
        task_id: "task_docs",
        title: "Docs implementation",
        write_scope: ["docs"],
        required_tools: ["edit"],
      },
    ],
  };
  const validated = await tool.validate?.(input);
  assert.ok(validated?.ok, validated && "message" in validated ? validated.message : "validation failed");
  const result = await tool.execute(validated.value, toolContext(sessionId, cwd));
  const output = JSON.parse(result.output) as { count?: number };
  assert.equal(output.count, 2);
}

function toolContext(sessionId: SessionId, cwd: string): TeamToolContext {
  return {
    sessionId,
    turnId: "turn_team_parallel_smoke" as TurnId,
    callId: "toolcall_team_parallel_smoke" as ToolCallId,
    signal: new AbortController().signal,
    cwd,
    metadata: async () => undefined,
    streamOutput: async () => undefined,
    requestApproval: async (): Promise<ApprovalDecision> => ({ action: "allow_once" }),
  };
}

function toTeamTaskRecord(task: TeamTaskRow): TeamTaskRecord {
  return {
    taskId: task.id,
    teamId: task.teamId,
    title: task.title,
    status: task.status,
    dependsOn: task.dependsOn,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(task.ownerPath ? { ownerPath: task.ownerPath } : {}),
    ...(task.createdBy ? { createdBy: task.createdBy } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  };
}

class ParallelSmokeRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  running = 0;
  maxRunning = 0;

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      await sleepMs(30);
      return { status: "completed", summary: `Done ${input.taskName}` };
    } finally {
      this.running--;
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
