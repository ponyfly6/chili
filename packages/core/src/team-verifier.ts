import type { AgentPath, AgentRunId, SessionId, TaskId, TeamId, ThreadId, TimestampMs } from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { TeamMemberRow, TeamRow, TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import type { LocalSubagentTaskResult } from "./subagent.js";
import type { TeamTaskSubagentRunner } from "./team-dispatcher.js";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import type { WorkerToolPolicyTemplate } from "./worker-policy.js";

const VERIFICATION_METADATA_KEY = "verification";
const DEFAULT_GIT_DIFF_MAX_BYTES = 200_000;

export type TeamTaskVerificationStatus = "pending" | "passed" | "failed";
export type TeamTaskVerifierResultStatus = "passed" | "failed" | "skipped";
export type TeamTaskVerifierSkipReason = "missing_owner" | "missing_session" | "not_completed" | "already_passed";

export interface TeamTaskVerificationMetadata {
  status: TeamTaskVerificationStatus;
  verifierTaskId?: TaskId;
  verifierRunId?: AgentRunId;
  verifierPath?: AgentPath;
  checkedAt?: number;
  startedAt?: number;
  feedback?: string;
  workerSummary?: string;
  gitDiff?: string;
}

export interface TeamTaskVerifierOptions {
  teams: TeamControlService;
  subagents: TeamTaskSubagentRunner;
  cwd: string;
  now?: () => TimestampMs;
  gitDiff?: (input: TeamTaskVerifierGitDiffInput) => Promise<string>;
}

export interface TeamTaskVerifierGitDiffInput {
  team: TeamRow;
  task: TeamTaskRow;
  member?: TeamMemberRow;
  cwd: string;
  signal?: AbortSignal;
}

export interface TeamTaskVerifierSweepInput {
  teamId: TeamId;
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
  signal?: AbortSignal;
}

export interface TeamTaskVerifierTaskInput extends TeamTaskVerifierSweepInput {
  taskId: TaskId;
}

export interface TeamTaskVerifierSweepResult {
  scanned: number;
  verified: TeamTaskVerifierVerifiedResult[];
  skipped: TeamTaskVerifierSkipped[];
  errors: TeamTaskVerifierError[];
}

export type TeamTaskVerifierResult = TeamTaskVerifierVerifiedResult | TeamTaskVerifierSkippedResult;

export interface TeamTaskVerifierVerifiedResult {
  status: Exclude<TeamTaskVerifierResultStatus, "skipped">;
  teamTask: TeamTaskRow;
  verifierTask: LocalSubagentTaskResult;
  feedback?: string;
}

export interface TeamTaskVerifierSkipped {
  teamTask: TeamTaskRow;
  reason: TeamTaskVerifierSkipReason;
}

export interface TeamTaskVerifierSkippedResult extends TeamTaskVerifierSkipped {
  status: "skipped";
}

export interface TeamTaskVerifierError {
  teamId: TeamId;
  taskId: TaskId;
  error: string;
}

export class TeamTaskVerificationService {
  constructor(private readonly options: TeamTaskVerifierOptions) {}

  async verifyCompletedTasks(input: TeamTaskVerifierSweepInput): Promise<TeamTaskVerifierSweepResult> {
    const [team, tasks, members] = await Promise.all([
      this.requireTeam(input.teamId),
      this.options.teams.tasks(input.teamId),
      this.options.teams.members(input.teamId),
    ]);
    const result: TeamTaskVerifierSweepResult = {
      scanned: 0,
      verified: [],
      skipped: [],
      errors: [],
    };

    for (const task of tasks) {
      if (!isCompletedButUnverifiedTeamTask(task)) continue;
      result.scanned++;
      try {
        const verified = await this.verifyTaskWithState({ ...input, taskId: task.id }, team, task, members);
        if (verified.status === "skipped") result.skipped.push(verified);
        else result.verified.push(verified);
      } catch (error) {
        result.errors.push({
          teamId: input.teamId,
          taskId: task.id,
          error: toError(error).message,
        });
      }
    }

    return result;
  }

  async verifyTask(input: TeamTaskVerifierTaskInput): Promise<TeamTaskVerifierResult> {
    const [team, tasks, members] = await Promise.all([
      this.requireTeam(input.teamId),
      this.options.teams.tasks(input.teamId),
      this.options.teams.members(input.teamId),
    ]);
    const task = tasks.find((item) => item.id === input.taskId);
    if (!task) throw new TeamTaskNotFoundError(input.teamId, input.taskId);
    return this.verifyTaskWithState(input, team, task, members);
  }

  private async verifyTaskWithState(
    input: TeamTaskVerifierTaskInput,
    team: TeamRow,
    task: TeamTaskRow,
    members: readonly TeamMemberRow[],
  ): Promise<TeamTaskVerifierResult> {
    if (task.status !== "completed") {
      return { status: "skipped", reason: "not_completed", teamTask: task };
    }
    if (isAcceptedTeamTask(task)) {
      return { status: "skipped", reason: "already_passed", teamTask: task };
    }
    if (!task.ownerPath) {
      return { status: "skipped", reason: "missing_owner", teamTask: task };
    }

    const parentSessionId = input.sessionId ?? task.sessionId ?? team.sessionId;
    if (!parentSessionId) {
      return { status: "skipped", reason: "missing_session", teamTask: task };
    }

    const cwd = input.cwd ?? this.options.cwd;
    const member = members.find((item) => item.path === task.ownerPath);
    const gitDiffInput: TeamTaskVerifierGitDiffInput = { team, task, cwd };
    if (member) gitDiffInput.member = member;
    if (input.signal) gitDiffInput.signal = input.signal;
    const gitDiff = await this.gitDiff(gitDiffInput);
    const startedAt = Number(this.now());
    const pendingTask = await this.options.teams.updateTask({
      teamId: task.teamId,
      taskId: task.id,
      metadata: mergeVerificationMetadata(task.metadata, verificationFields({
        status: "pending",
        startedAt,
        workerSummary: task.summary,
        gitDiff,
      })),
      sessionId: parentSessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });

    const verifierInput = {
      parentSessionId,
      ...(input.threadId ? { parentThreadId: input.threadId } : {}),
      parentPath: task.ownerPath,
      cwd,
      taskName: `Verify ${task.title}`,
      prompt: verifierPrompt(verifierPromptInput({ team, task: pendingTask, member, gitDiff })),
      mode: "one_shot" as const,
      workerPolicy: verifierWorkerPolicy({
        teamId: task.teamId,
        taskId: task.id,
        memberPath: task.ownerPath,
        parentSessionId,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const verifierTask = await this.options.subagents.spawnTask(verifierInput);
    const verdict = verifierVerdict(verifierTask);
    const checkedAt = Number(this.now());
    const feedback = verdict.feedback;

    if (verdict.status === "passed") {
      const acceptedTask = await this.options.teams.updateTask({
        teamId: task.teamId,
        taskId: task.id,
        metadata: mergeVerificationMetadata(pendingTask.metadata, verificationFields({
          status: "passed",
          verifierTaskId: verifierTask.taskId,
          verifierRunId: verifierTask.runId,
          verifierPath: verifierTask.path,
          checkedAt,
          feedback,
          workerSummary: task.summary,
          gitDiff,
        })),
        sessionId: parentSessionId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      return { status: "passed", teamTask: acceptedTask, verifierTask, feedback };
    }

    const reopenedTask = await this.options.teams.updateTask({
      teamId: task.teamId,
      taskId: task.id,
      status: "pending",
      error: "verification_failed",
      metadata: mergeVerificationMetadata(pendingTask.metadata, verificationFields({
        status: "failed",
        verifierTaskId: verifierTask.taskId,
        verifierRunId: verifierTask.runId,
        verifierPath: verifierTask.path,
        checkedAt,
        feedback,
        workerSummary: task.summary,
        gitDiff,
      })),
      sessionId: parentSessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    return { status: "failed", teamTask: reopenedTask, verifierTask, feedback };
  }

  private async requireTeam(teamId: TeamId): Promise<TeamRow> {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return team;
  }

  private async gitDiff(input: TeamTaskVerifierGitDiffInput): Promise<string> {
    try {
      if (this.options.gitDiff) return await this.options.gitDiff(input);
      const processInput = {
        cwd: input.cwd,
        timeoutMs: 15_000,
        maxOutputBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
      };
      const result = await runProcess("git", ["diff", "--no-ext-diff", "--no-color"], input.signal ? { ...processInput, signal: input.signal } : processInput);
      if (result.exitCode !== 0) return `(git diff failed: ${result.stderr || `exit ${result.exitCode}`})`;
      return result.stdout || "(no diff)";
    } catch (error) {
      return `(git diff unavailable: ${toError(error).message})`;
    }
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

export function verifierWorkerPolicy(input: {
  teamId: TeamId;
  taskId: TaskId;
  memberPath: AgentPath;
  parentSessionId: SessionId;
}): WorkerToolPolicyTemplate {
  return {
    teamId: input.teamId,
    taskId: input.taskId,
    memberPath: input.memberPath,
    parentSessionId: input.parentSessionId,
    allowedTools: ["read", "glob", "grep", "git_diff", "bash", "complete_task"],
    writeScope: [],
    executeScope: [],
  };
}

export function verificationMetadata(metadata: Record<string, unknown> | undefined): TeamTaskVerificationMetadata | undefined {
  const value = metadata?.[VERIFICATION_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (status !== "pending" && status !== "passed" && status !== "failed") return undefined;
  return value as unknown as TeamTaskVerificationMetadata;
}

export function isAcceptedTeamTask(task: TeamTaskRow): boolean {
  return task.status === "completed" && verificationMetadata(task.metadata)?.status === "passed";
}

export function isCompletedButUnverifiedTeamTask(task: TeamTaskRow): boolean {
  if (task.status !== "completed") return false;
  const status = verificationMetadata(task.metadata)?.status;
  return status !== "passed";
}

export function isReopenedAfterFailedVerification(task: TeamTaskRow): boolean {
  return task.status === "pending" && verificationMetadata(task.metadata)?.status === "failed";
}

function verifierPrompt(input: {
  team: TeamRow;
  task: TeamTaskRow;
  member?: TeamMemberRow;
  gitDiff: string;
}): string {
  const writeScope = metadataStringArray(input.task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
  const suggestedTests = metadataStringArray(input.task.metadata, [
    "suggestedTestCommands",
    "suggested_test_commands",
    "testCommands",
    "test_commands",
  ]);
  return [
    `Verifier for team task: ${input.team.id}/${input.task.id}`,
    `Task title: ${input.task.title}`,
    input.task.description ? `Task description:\n${input.task.description}` : undefined,
    `Member: ${input.member?.path ?? input.task.ownerPath ?? "(unknown)"}`,
    `Write scope: ${formatList(writeScope)}`,
    `Worker summary: ${input.task.summary ?? "(none)"}`,
    `Suggested test commands: ${formatList(suggestedTests)}`,
    "",
    "You are a read-only verifier. Do not edit, write, or apply patches. Inspect the implementation, run read-only test commands when useful, and judge whether the task is acceptable.",
    "Use complete_task with a concise summary that starts with exactly one of:",
    "VERDICT: passed",
    "VERDICT: failed",
    "",
    "Git diff at verifier start:",
    input.gitDiff,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function verifierPromptInput(input: {
  team: TeamRow;
  task: TeamTaskRow;
  member: TeamMemberRow | undefined;
  gitDiff: string;
}): { team: TeamRow; task: TeamTaskRow; member?: TeamMemberRow; gitDiff: string } {
  const output: { team: TeamRow; task: TeamTaskRow; member?: TeamMemberRow; gitDiff: string } = {
    team: input.team,
    task: input.task,
    gitDiff: input.gitDiff,
  };
  if (input.member) output.member = input.member;
  return output;
}

function verifierVerdict(task: LocalSubagentTaskResult): { status: Exclude<TeamTaskVerifierResultStatus, "skipped">; feedback: string } {
  const feedback = task.error?.message ?? task.summary ?? "";
  if (task.status !== "completed") {
    return { status: "failed", feedback: feedback || `Verifier task ended with status ${task.status}.` };
  }
  const text = feedback.trim();
  if (/^\s*VERDICT:\s*passed\b/im.test(text)) return { status: "passed", feedback: text };
  if (/^\s*VERDICT:\s*failed\b/im.test(text)) return { status: "failed", feedback: text };
  return {
    status: "failed",
    feedback: text ? `Verifier did not report a passing verdict.\n\n${text}` : "Verifier did not report a passing verdict.",
  };
}

function verificationFields(input: {
  status: TeamTaskVerificationStatus;
  verifierTaskId?: TaskId;
  verifierRunId?: AgentRunId;
  verifierPath?: AgentPath;
  checkedAt?: number;
  startedAt?: number;
  feedback?: string;
  workerSummary: string | undefined;
  gitDiff: string;
}): TeamTaskVerificationMetadata {
  const output: TeamTaskVerificationMetadata = {
    status: input.status,
    gitDiff: input.gitDiff,
  };
  if (input.verifierTaskId) output.verifierTaskId = input.verifierTaskId;
  if (input.verifierRunId) output.verifierRunId = input.verifierRunId;
  if (input.verifierPath) output.verifierPath = input.verifierPath;
  if (input.checkedAt !== undefined) output.checkedAt = input.checkedAt;
  if (input.startedAt !== undefined) output.startedAt = input.startedAt;
  if (input.feedback) output.feedback = input.feedback;
  if (input.workerSummary) output.workerSummary = input.workerSummary;
  return output;
}

function mergeVerificationMetadata(
  metadata: Record<string, unknown> | undefined,
  verification: TeamTaskVerificationMetadata,
): Record<string, unknown> {
  const current = metadata ?? {};
  const previous = isRecord(current[VERIFICATION_METADATA_KEY]) ? current[VERIFICATION_METADATA_KEY] : {};
  return {
    ...current,
    [VERIFICATION_METADATA_KEY]: pruneUndefined({
      ...previous,
      ...verification,
    }),
  };
}

function metadataStringArray(metadata: Record<string, unknown> | undefined, keys: readonly string[]): string[] | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return undefined;
}

function formatList(items: readonly string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
