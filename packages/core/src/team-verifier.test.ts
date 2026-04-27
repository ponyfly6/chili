import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TeamId, TimestampMs, ThreadId, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  authorizeToolByPolicy,
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGitDiffTool,
  createReadFileTool,
  createWriteFileTool,
  filterToolsByPolicy,
} from "@chili/tools";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import { TeamTaskDispatchService } from "./team-dispatcher.js";
import { TeamExecutionRunner } from "./team-execution-runner.js";
import { TeamControlService } from "./team.js";
import { TeamTaskVerificationService, verificationMetadata, verifierWorkerPolicy } from "./team-verifier.js";

test("team runner auto-verifies worker completion before accepting the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-runner-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1000 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_runner" as SessionId;
  const threadId = "thread_team_verifier_runner" as ThreadId;
  const runner = new RoutingLocalSubagentRunner();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      gitDiff: async () => "diff --git a/packages/core/src/team.ts b/packages/core/src/team.ts",
    });
    const execution = new TeamExecutionRunner({ teams, dispatcher, verifier, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "verifier-runner", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Implement verifier target",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/core"],
        suggestedTestCommands: ["bun test packages/core/src/team-verifier.test.ts"],
      },
    });

    const summary = await execution.run({ teamId: team.id, sessionId, threadId, mode: "one_shot", maxCycles: 3 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      dispatched: [{ taskId: task.id, status: "completed", ownerPath: workerPath }],
      completed: [{ taskId: task.id, status: "completed", summary: "Implemented Implement verifier target" }],
      accepted: [{ taskId: task.id, status: "completed", summary: "Implemented Implement verifier target" }],
      reopened: [],
      errors: [],
    });
    expect(runner.runs.map((run) => run.taskName)).toEqual(["Implement verifier target", "Verify Implement verifier target"]);
    expect(runner.runs[1]?.prompt).toContain("Worker summary: Implemented Implement verifier target");
    expect(runner.runs[1]?.prompt).toContain("diff --git a/packages/core/src/team.ts b/packages/core/src/team.ts");
    expect(runner.runs[1]?.workerPolicy).toMatchObject({
      allowedTools: ["read", "glob", "grep", "git_diff", "bash", "complete_task"],
      writeScope: [],
      executeScope: ["bun test packages/core/src/team-verifier.test.ts"],
    });

    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask?.status).toBe("completed");
    expect(verificationMetadata(storedTask?.metadata)?.status).toBe("passed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed verifier reopens the task with feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-failed-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1100 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_failed" as SessionId;
  const threadId = "thread_team_verifier_failed" as ThreadId;
  const runner = new FixedVerifierRunner("VERDICT: failed\nMissing coverage for retry timeout.");

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const verifier = new TeamTaskVerificationService({ teams, subagents, cwd: dir, now, gitDiff: async () => "(no diff)" });
    const team = await teams.createTeam({ sessionId, threadId, name: "verifier-failed", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, threadId, teamId: team.id, title: "Needs verification", ownerPath: workerPath });
    await teams.updateTask({
      sessionId,
      threadId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Worker says done",
    });

    const result = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId, threadId });

    expect(result.verified).toMatchObject([
      { status: "failed", feedback: "VERDICT: failed\nMissing coverage for retry timeout." },
    ]);
    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask).toMatchObject({ id: task.id, status: "pending", error: "verification_failed" });
    expect(verificationMetadata(storedTask?.metadata)).toMatchObject({
      status: "failed",
      feedback: "VERDICT: failed\nMissing coverage for retry timeout.",
      workerSummary: "Worker says done",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort during verifier setup does not mark verification pending or reopen the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1150 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_abort" as SessionId;
  const threadId = "thread_team_verifier_abort" as ThreadId;
  const controller = new AbortController();
  const runner = new FixedVerifierRunner("VERDICT: failed\nShould not run.");

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      gitDiff: async () => {
        controller.abort();
        const error = new Error("git diff aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const execution = new TeamExecutionRunner({ teams, dispatcher, verifier, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, threadId, name: "verifier-abort", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, threadId, teamId: team.id, title: "Abort verifier setup", ownerPath: workerPath });
    await teams.updateTask({
      sessionId,
      threadId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Worker says done",
    });

    const summary = await execution.run({ teamId: team.id, sessionId, threadId, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      errors: [],
      reopened: [],
      accepted: [],
    });
    expect(runner.runs).toEqual([]);
    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask).toMatchObject({ id: task.id, status: "completed", summary: "Worker says done" });
    expect(verificationMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier policy is read-only and denies write tools", async () => {
  const policy = verifierWorkerPolicy({
    teamId: "team_policy" as TeamId,
    taskId: "task_policy" as TaskId,
    memberPath: "/root/worker" as AgentPath,
    parentSessionId: "session_policy" as SessionId,
    testCommands: [
      "bun test packages/core/src/team-verifier.test.ts",
      "bun test packages/core/src/team-verifier.test.ts; rm -rf .",
      "npm run test > out.txt",
      "rm -rf .",
    ],
  });
  const read = createReadFileTool();
  const gitDiff = createGitDiffTool();
  const bash = createBashTool();
  const edit = createEditTool();
  const write = createWriteFileTool();
  const applyPatch = createApplyPatchTool();

  expect(policy.allowedTools).toEqual(["read", "glob", "grep", "git_diff", "bash", "complete_task"]);
  expect(policy.writeScope).toEqual([]);
  expect(policy.executeScope).toEqual(["bun test packages/core/src/team-verifier.test.ts"]);
  expect(filterToolsByPolicy([read, gitDiff, bash, edit, write, applyPatch], policy).map((tool) => tool.name)).toEqual([
    "read",
    "git_diff",
    "bash",
  ]);
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        threadId: "thread_policy" as ThreadId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/team-verifier.test.ts" },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/team-verifier.test.ts" },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/team-verifier.test.ts"], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).resolves.toBeUndefined();
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        threadId: "thread_policy" as ThreadId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/other.test.ts" },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/other.test.ts" },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/other.test.ts"], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).rejects.toThrow("execute scope");
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        threadId: "thread_policy" as ThreadId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/team-verifier.test.ts; rm -rf ." },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/team-verifier.test.ts; rm -rf ." },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/team-verifier.test.ts; rm -rf ."], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).rejects.toThrow("execute scope");
  await expect(
    authorizeToolByPolicy({
      tool: edit,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        threadId: "thread_policy" as ThreadId,
        turnId: "turn_policy" as TurnId,
        toolName: "edit",
        input: {},
        cwd: "/tmp",
      },
      validatedInput: {} as never,
      approvalSpec: { permission: "edit", patterns: ["packages/core/src/team.ts"], metadata: {} },
      policy,
      isReadOnly: async () => false,
    }),
  ).rejects.toThrow("not allowed");
});

test("runner does not report drained while a completed task is unverified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-undrained-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1200 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_undrained" as SessionId;
  const runner = new RoutingLocalSubagentRunner();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const verifier = new TeamTaskVerificationService({ teams, subagents, cwd: dir, now, gitDiff: async () => "(no diff)" });
    const execution = new TeamExecutionRunner({ teams, dispatcher, verifier, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, name: "verifier-undrained", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId: team.id, title: "Complete then verify later", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, mode: "one_shot", maxCycles: 1 });

    expect(summary).toMatchObject({
      stopReason: "max_cycles",
      completed: [{ status: "completed" }],
      accepted: [],
      stillRunning: [],
    });
    expect(runner.runs.map((run) => run.taskName)).toEqual(["Complete then verify later"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class RoutingLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    if (input.taskName.startsWith("Verify ")) {
      return { status: "completed", summary: "VERDICT: passed\nTests passed." };
    }
    return { status: "completed", summary: `Implemented ${input.taskName}` };
  }
}

class FixedVerifierRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  constructor(private readonly summary: string) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    return { status: "completed", summary: this.summary };
  }
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

async function actualReadOnly<Input>(
  tool: { isReadOnly?: boolean | ((input: Input) => boolean | Promise<boolean>) },
  input: Input,
): Promise<boolean | undefined> {
  const predicate = tool.isReadOnly;
  return typeof predicate === "function" ? predicate(input) : predicate;
}
