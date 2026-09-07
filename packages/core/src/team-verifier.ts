import { randomUUID } from "node:crypto";
import type { AgentPath, AgentRunId, SessionId, TaskId, TeamId, TimestampMs } from "@chili/protocol";
import { normalizePersistedError, timestampNow } from "@chili/protocol";
import type { TeamMemberRow, TeamRow, TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import type { LocalSubagentTaskResult } from "./subagent.js";
import type { TeamTaskSubagentRunner } from "./team-dispatcher.js";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import {
  resolveTeamSessionAuthority,
  TeamSessionAuthorityError,
  type TeamSessionResolver,
} from "./team-session-authority.js";
import { mergeMergeMetadata, preflightTeamTaskWorktree } from "./team-worktree.js";
import type { WorkerToolPolicyTemplate } from "./worker-policy.js";

const VERIFICATION_METADATA_KEY = "verification";
const DEFAULT_GIT_DIFF_MAX_BYTES = 200_000;
const DEFAULT_GIT_DIFF_MAX_UNTRACKED_FILES = 128;
const DEFAULT_GIT_DIFF_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 2;
const MAX_CONCURRENT_VERIFICATIONS = 4;
const VERIFICATION_PENDING_TTL_MS = 15 * 60_000;

export type TeamTaskVerificationStatus = "pending" | "passed" | "failed";
export type TeamTaskVerifierResultStatus = "passed" | "failed" | "skipped";
export type TeamTaskVerifierSkipReason =
  | "missing_owner"
  | "missing_session"
  | "not_completed"
  | "already_passed"
  | "verification_pending";

export interface TeamTaskVerificationMetadata {
  status: TeamTaskVerificationStatus;
  claimId?: string;
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
  resolveSession: TeamSessionResolver;
  sessionOperations: SessionOperationCoordinator;
  now?: () => TimestampMs;
  gitDiff?: (input: TeamTaskVerifierGitDiffInput) => Promise<string>;
}

export interface TeamTaskVerifierGitDiffInput {
  team: TeamRow;
  task: TeamTaskRow;
  member?: TeamMemberRow;
  cwd: string;
  baseRef?: string;
  baseCwd?: string;
  signal?: AbortSignal;
}

export interface TeamTaskVerifierSweepInput {
  teamId: TeamId;
  sessionId?: SessionId;
  cwd?: string;
  maxConcurrentVerifications?: number;
  signal?: AbortSignal;
}

export interface TeamTaskVerifierTaskInput extends TeamTaskVerifierSweepInput {
  taskId: TaskId;
}

export interface TeamTaskVerifierSweepResult {
  scanned: number;
  maxConcurrentVerifications: number;
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

interface VerifierGitDiffSnapshot {
  text: string;
  incompleteReason?: string;
}

type AuthorizedTeamTaskVerifierInput = TeamTaskVerifierSweepInput & {
  sessionId: SessionId;
  cwd: string;
};

interface AuthorizedTeamTaskVerifierState {
  input: AuthorizedTeamTaskVerifierInput;
  team: TeamRow;
  tasks: TeamTaskRow[];
  members: TeamMemberRow[];
}

export class TeamTaskVerificationService {
  constructor(private readonly options: TeamTaskVerifierOptions) {}

  async verifyCompletedTasks(input: TeamTaskVerifierSweepInput): Promise<TeamTaskVerifierSweepResult> {
    const initial = await this.authorizedState(input);
    return this.options.sessionOperations.withSessionOperation(initial.input.sessionId, async (operation) => {
      operation.assertCurrent();
      const current = await this.authorizedState({
        ...input,
        sessionId: initial.input.sessionId,
        cwd: initial.input.cwd,
        signal: combinedAbortSignal(input.signal, operation.signal),
      });
      operation.assertCurrent();
      throwIfAborted(current.input.signal);
      return this.verifyCompletedTasksWithOperation(current, operation);
    });
  }

  private async verifyCompletedTasksWithOperation(
    state: AuthorizedTeamTaskVerifierState,
    operation: RuntimeSessionOperation,
  ): Promise<TeamTaskVerifierSweepResult> {
    const { input, team, tasks, members } = state;
    const maxConcurrentVerifications = normalizeMaxConcurrentVerifications(input.maxConcurrentVerifications);
    const result: TeamTaskVerifierSweepResult = {
      scanned: 0,
      maxConcurrentVerifications,
      verified: [],
      skipped: [],
      errors: [],
    };

    const candidates = tasks.filter((task) => isVerificationCandidate(task, Number(this.now())));
    result.scanned = candidates.length;
    for (const batch of chunk(candidates, maxConcurrentVerifications)) {
      const verifiedBatch = await Promise.all(batch.map(async (task) => {
        try {
          operation.assertCurrent();
          throwIfAborted(input.signal);
          return {
            task,
            result: await this.verifyTaskWithState(
              input,
              team,
              task,
              members,
              operation,
            ),
          };
        } catch (error) {
          this.assertRecoverableVerificationError(error, input.signal, operation);
          return { task, error };
        }
      }));
      for (const item of verifiedBatch) {
        if ("result" in item) {
          if (item.result.status === "skipped") result.skipped.push(item.result);
          else result.verified.push(item.result);
          continue;
        }
        result.errors.push({
          teamId: input.teamId,
          taskId: item.task.id,
          error: toError(item.error).message,
        });
      }
    }

    return result;
  }

  async verifyTask(input: TeamTaskVerifierTaskInput): Promise<TeamTaskVerifierResult> {
    const initial = await this.authorizedState(input);
    return this.options.sessionOperations.withSessionOperation(initial.input.sessionId, async (operation) => {
      operation.assertCurrent();
      const current = await this.authorizedState({
        ...input,
        sessionId: initial.input.sessionId,
        cwd: initial.input.cwd,
        signal: combinedAbortSignal(input.signal, operation.signal),
      });
      operation.assertCurrent();
      throwIfAborted(current.input.signal);
      const task = current.tasks.find((item) => item.id === input.taskId);
      if (!task) throw new TeamTaskNotFoundError(input.teamId, input.taskId);
      return this.verifyTaskWithState(current.input, current.team, task, current.members, operation);
    });
  }

  private async verifyTaskWithState(
    input: AuthorizedTeamTaskVerifierInput,
    team: TeamRow,
    task: TeamTaskRow,
    members: readonly TeamMemberRow[],
    operation: RuntimeSessionOperation,
  ): Promise<TeamTaskVerifierResult> {
    operation.assertCurrent();
    throwIfAborted(input.signal);
    if (task.status !== "completed") {
      return { status: "skipped", reason: "not_completed", teamTask: task };
    }
    if (isAcceptedTeamTask(task)) {
      return { status: "skipped", reason: "already_passed", teamTask: task };
    }
    if (isFreshPendingVerification(task, Number(this.now()))) {
      return { status: "skipped", reason: "verification_pending", teamTask: task };
    }
    if (!task.ownerPath) {
      return { status: "skipped", reason: "missing_owner", teamTask: task };
    }

    const parentSessionId = input.sessionId;
    const workspaceCwd = input.cwd;
    let worktree = await preflightTeamTaskWorktree({
      cwd: workspaceCwd,
      teamId: task.teamId,
      taskId: task.id,
      metadata: task.metadata,
      requireExisting: true,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    let cwd = worktree?.path ?? workspaceCwd;
    const member = members.find((item) => item.path === task.ownerPath);
    const startedAt = Number(this.now());
    const claimId = randomUUID();
    const pendingMetadata = mergeVerificationMetadata(task.metadata, verificationFields({
      status: "pending",
      claimId,
      startedAt,
      workerSummary: task.summary,
    }));
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const pendingClaim = await this.options.teams.claimTaskVerification({
      teamId: task.teamId,
      taskId: task.id,
      metadata: pendingMetadata,
      sessionId: parentSessionId,
      stalePendingBefore: startedAt - VERIFICATION_PENDING_TTL_MS,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    if (!pendingClaim.applied) {
      return {
        status: "skipped",
        reason: verifierClaimSkipReason(pendingClaim.reason),
        teamTask: pendingClaim.task ?? task,
      };
    }
    const pendingTask = pendingClaim.task ?? task;
    await this.revalidateAuthority(input, operation);
    worktree = await preflightTeamTaskWorktree({
      cwd: workspaceCwd,
      teamId: pendingTask.teamId,
      taskId: pendingTask.id,
      metadata: pendingTask.metadata,
      requireExisting: true,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    cwd = worktree?.path ?? workspaceCwd;
    const gitDiffInput: TeamTaskVerifierGitDiffInput = { team, task: pendingTask, cwd };
    if (member) gitDiffInput.member = member;
    if (worktree) {
      gitDiffInput.baseRef = worktree.baseRef;
      gitDiffInput.baseCwd = workspaceCwd;
    }
    if (input.signal) gitDiffInput.signal = input.signal;
    let gitDiffSnapshot: VerifierGitDiffSnapshot;
    try {
      await this.revalidateAuthority(input, operation);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      gitDiffSnapshot = await this.gitDiff(gitDiffInput);
      operation.assertCurrent();
      throwIfAborted(input.signal);
    } catch (error) {
      if (error instanceof RuntimeBusyError || error instanceof TeamSessionAuthorityError) throw error;
      operation.assertCurrent();
      if (isSignalAbort(error, input.signal)) {
        await this.clearPendingVerificationClaim(task, claimId, input, operation);
      }
      throw error;
    }
    const gitDiff = gitDiffSnapshot.text;
    const testCommands = verifierTestCommands(task.metadata);
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const verificationPendingTask = await this.options.teams.updateTask({
      teamId: task.teamId,
      taskId: task.id,
      metadata: mergeVerificationMetadata(pendingTask.metadata, verificationFields({
        status: "pending",
        claimId,
        startedAt,
        workerSummary: task.summary,
        gitDiff,
      })),
      sessionId: parentSessionId,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    worktree = await preflightTeamTaskWorktree({
      cwd: workspaceCwd,
      teamId: verificationPendingTask.teamId,
      taskId: verificationPendingTask.id,
      metadata: verificationPendingTask.metadata,
      requireExisting: true,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    cwd = worktree?.path ?? workspaceCwd;

    const verifierInput = {
      parentSessionId,
      parentPath: task.ownerPath,
      cwd,
      taskName: `Verify ${task.title}`,
      prompt: verifierPrompt(verifierPromptInput({ team, task: pendingTask, member, gitDiff, testCommands, worktreePath: worktree?.path })),
      mode: "one_shot" as const,
      workerPolicy: verifierWorkerPolicy({
        teamId: task.teamId,
        taskId: task.id,
        memberPath: task.ownerPath,
        parentSessionId,
        testCommands,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    };
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const verifierTask = await this.options.subagents.spawnTask(verifierInput);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const reportedVerdict = verifierVerdict(verifierTask);
    const verdict = gitDiffSnapshot.incompleteReason !== undefined
      ? {
          status: "failed" as const,
          feedback: `Verification cannot pass because git diff collection was incomplete: ${gitDiffSnapshot.incompleteReason}.\n\n${reportedVerdict.feedback}`,
        }
      : reportedVerdict;
    const checkedAt = Number(this.now());
    const feedback = verdict.feedback;

    if (verdict.status === "passed") {
      const verificationMetadata = mergeVerificationMetadata(pendingTask.metadata, verificationFields({
        status: "passed",
        verifierTaskId: verifierTask.taskId,
        verifierRunId: verifierTask.runId,
        verifierPath: verifierTask.path,
        checkedAt,
        feedback,
        workerSummary: task.summary,
        gitDiff,
      }));
      const metadata = worktree
        ? mergeMergeMetadata(verificationMetadata, {
            status: "pending",
            createdAt: checkedAt,
            worktreePath: worktree.path,
            baseRef: worktree.baseRef,
            diff: gitDiff,
          })
        : verificationMetadata;
      await this.revalidateAuthority(input, operation);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      const acceptedTask = await this.options.teams.updateTask({
        teamId: task.teamId,
        taskId: task.id,
        metadata,
        sessionId: parentSessionId,
      });
      operation.assertCurrent();
      throwIfAborted(input.signal);
      return { status: "passed", teamTask: acceptedTask, verifierTask, feedback };
    }

    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
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
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    return { status: "failed", teamTask: reopenedTask, verifierTask, feedback };
  }

  private async clearPendingVerificationClaim(
    task: TeamTaskRow,
    claimId: string,
    input: AuthorizedTeamTaskVerifierInput,
    operation: RuntimeSessionOperation,
  ): Promise<void> {
    const cleanupInput: AuthorizedTeamTaskVerifierInput = {
      ...input,
      signal: operation.signal,
    };
    await this.revalidateAuthority(cleanupInput, operation);
    const current = (await this.options.teams.tasks(task.teamId)).find((item) => item.id === task.id);
    if (!current || verificationMetadata(current.metadata)?.status !== "pending") return;
    if (verificationMetadata(current.metadata)?.claimId !== claimId) return;
    operation.assertCurrent();
    await this.options.teams.updateTask({
      teamId: task.teamId,
      taskId: task.id,
      metadata: restoreVerificationMetadata(current.metadata, task.metadata),
      sessionId: input.sessionId,
    });
    operation.assertCurrent();
  }

  private async authorizedState(input: TeamTaskVerifierSweepInput): Promise<AuthorizedTeamTaskVerifierState> {
    const [team, tasks, members] = await Promise.all([
      this.requireTeam(input.teamId),
      this.options.teams.tasks(input.teamId),
      this.options.teams.members(input.teamId),
    ]);
    const authority = await resolveTeamSessionAuthority({
      team,
      tasks,
      ...(input.sessionId ? { requestedSessionId: input.sessionId } : {}),
      ...(input.cwd !== undefined ? { requestedCwd: input.cwd } : {}),
      resolveSession: this.options.resolveSession,
    });
    return {
      input: {
        ...input,
        sessionId: authority.sessionId,
        cwd: authority.cwd,
      },
      team,
      tasks,
      members,
    };
  }

  private async revalidateAuthority(
    input: AuthorizedTeamTaskVerifierInput,
    operation: RuntimeSessionOperation,
  ): Promise<AuthorizedTeamTaskVerifierState> {
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const state = await this.authorizedState({
      ...input,
      sessionId: input.sessionId,
      cwd: input.cwd,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    return state;
  }

  private assertRecoverableVerificationError(
    error: unknown,
    signal: AbortSignal | undefined,
    operation: RuntimeSessionOperation,
  ): void {
    if (error instanceof RuntimeBusyError || error instanceof TeamSessionAuthorityError) throw error;
    operation.assertCurrent();
    if (isSignalAbort(error, signal)) throw error;
  }

  private async requireTeam(teamId: TeamId): Promise<TeamRow> {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return team;
  }

  private async gitDiff(input: TeamTaskVerifierGitDiffInput): Promise<VerifierGitDiffSnapshot> {
    const snapshot = new VerifierGitDiffCollector();
    const deadline = Date.now() + DEFAULT_GIT_DIFF_TIMEOUT_MS;
    try {
      throwIfAborted(input.signal);
      if (this.options.gitDiff) {
        const diff = await this.options.gitDiff(input);
        throwIfAborted(input.signal);
        return snapshot.append(diff) ? snapshot.complete() : snapshot.incomplete("UTF-8 byte limit reached");
      }
      const runGit = async (cwd: string, args: readonly string[], maxOutputBytes = snapshot.remainingBytes + 4) => {
        throwIfAborted(input.signal);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error(`collection timed out after ${DEFAULT_GIT_DIFF_TIMEOUT_MS}ms`);
        const result = await runProcess("git", args, {
          cwd,
          timeoutMs: remainingMs,
          maxOutputBytes,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        throwIfAborted(input.signal);
        if (result.timedOut) throw new Error(`collection timed out after ${DEFAULT_GIT_DIFF_TIMEOUT_MS}ms`);
        return result;
      };
      let diffBase = "HEAD";
      if (input.baseRef) {
        const resolved = await runGit(input.baseCwd ?? input.cwd, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${input.baseRef}^{commit}`,
        ], 4_096);
        if (resolved.exitCode !== 0 || resolved.stdoutTruncated || !isFullObjectId(resolved.stdout.trim())) {
          return snapshot.incomplete(`could not resolve baseRef ${input.baseRef}: ${resolved.stderr || `exit ${resolved.exitCode}`}`);
        }
        diffBase = resolved.stdout.trim();
      }
      const tracked = await runGit(input.cwd, [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "--binary",
        diffBase,
        "--",
      ]);
      if (tracked.exitCode !== 0) {
        if (!input.baseRef && isReadOnlyVerificationTask(input.task)) {
          const repository = await runGit(input.cwd, ["rev-parse", "--is-inside-work-tree"], 4_096);
          const head = repository.exitCode === 0
            ? await runGit(input.cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 4_096)
            : undefined;
          if (repository.exitCode !== 0 || (head?.exitCode === 1 && !head.stderr)) {
            return {
              text: "(Git diff unavailable: this read-only task has no Git worktree or committed HEAD baseline. Inspect the relevant files and task result directly before reporting a verdict.)",
            };
          }
        }
        return snapshot.incomplete(`git diff failed: ${tracked.stderr || `exit ${tracked.exitCode}`}`);
      }
      const trackedFits = snapshot.append(tracked.stdout);
      if (!trackedFits || tracked.stdoutTruncated) return snapshot.incomplete("tracked diff truncated at UTF-8 byte limit");

      const untracked = await runGit(input.cwd, ["ls-files", "--others", "--exclude-standard", "-z"], DEFAULT_GIT_DIFF_MAX_BYTES + 4);
      if (untracked.exitCode !== 0) {
        return snapshot.incomplete(`untracked file scan failed: ${untracked.stderr || `exit ${untracked.exitCode}`}`);
      }
      // A truncated NUL-delimited scan can end in the middle of a filename.
      if (untracked.stdoutTruncated) return snapshot.incomplete("untracked file list truncated at UTF-8 byte limit");
      let filesCollected = 0;
      for (const path of splitNul(untracked.stdout)) {
        throwIfAborted(input.signal);
        if (filesCollected >= DEFAULT_GIT_DIFF_MAX_UNTRACKED_FILES) {
          return snapshot.incomplete(`untracked file limit reached (${DEFAULT_GIT_DIFF_MAX_UNTRACKED_FILES} files)`);
        }
        if (snapshot.remainingBytes <= 0) return snapshot.incomplete("UTF-8 byte limit reached before remaining untracked files");
        const fileDiff = await runGit(input.cwd, ["diff", "--no-ext-diff", "--no-color", "--binary", "--no-index", "--", "/dev/null", path]);
        filesCollected++;
        if (fileDiff.exitCode !== 0 && fileDiff.exitCode !== 1) {
          return snapshot.incomplete(`diff for untracked file failed: ${path}: ${fileDiff.stderr || `exit ${fileDiff.exitCode}`}`);
        }
        const fileFits = snapshot.append(fileDiff.stdout);
        if (!fileFits || fileDiff.stdoutTruncated) return snapshot.incomplete("untracked diff truncated at UTF-8 byte limit");
      }
      return snapshot.complete();
    } catch (error) {
      if (isSignalAbort(error, input.signal)) throw error;
      return snapshot.incomplete(toError(error).message);
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
  testCommands?: readonly string[];
}): WorkerToolPolicyTemplate {
  return {
    teamId: input.teamId,
    taskId: input.taskId,
    memberPath: input.memberPath,
    parentSessionId: input.parentSessionId,
    allowedTools: ["read", "glob", "grep", "git_diff", "bash", "complete_task"],
    writeScope: [],
    executeScope: normalizedVerifierTestCommands(input.testCommands),
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
  return status !== "passed" && status !== "pending";
}

export function isPendingVerificationTeamTask(task: TeamTaskRow): boolean {
  return task.status === "completed" && verificationMetadata(task.metadata)?.status === "pending";
}

export function isReopenedAfterFailedVerification(task: TeamTaskRow): boolean {
  return task.status === "pending" && verificationMetadata(task.metadata)?.status === "failed";
}

function isVerificationCandidate(task: TeamTaskRow, now: number): boolean {
  return isCompletedButUnverifiedTeamTask(task) || isStalePendingVerification(task, now);
}

function isFreshPendingVerification(task: TeamTaskRow, now: number): boolean {
  return isPendingVerificationTeamTask(task) && !isStalePendingVerification(task, now);
}

function isStalePendingVerification(task: TeamTaskRow, now: number): boolean {
  const verification = verificationMetadata(task.metadata);
  if (task.status !== "completed" || verification?.status !== "pending") return false;
  const startedAt = typeof verification.startedAt === "number" ? verification.startedAt : undefined;
  return startedAt === undefined || now - startedAt >= VERIFICATION_PENDING_TTL_MS;
}

function verifierPrompt(input: {
  team: TeamRow;
  task: TeamTaskRow;
  member?: TeamMemberRow;
  gitDiff: string;
  testCommands: string[];
  worktreePath?: string;
}): string {
  const writeScope = metadataStringArray(input.task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
  return [
    `Verifier for team task: ${input.team.id}/${input.task.id}`,
    `Task title: ${input.task.title}`,
    input.task.description ? `Task description:\n${input.task.description}` : undefined,
    `Member: ${input.member?.path ?? input.task.ownerPath ?? "(unknown)"}`,
    input.worktreePath ? `Isolated worktree: ${input.worktreePath}` : undefined,
    `Write scope: ${formatList(writeScope)}`,
    `Worker summary: ${input.task.summary ?? "(none)"}`,
    `Allowed test commands: ${formatList(input.testCommands)}`,
    "",
    "You are a verifier with no file write scope. Do not edit, write, or apply patches. Inspect the implementation, run only the allowed test commands listed above plus commands the runtime classifies as read-only, and judge whether the task is acceptable.",
    "Use complete_task with a concise summary that starts with exactly one of:",
    "VERDICT: passed",
    "VERDICT: failed",
    "Put the verdict alone on the first line. Do not include additional verdict lines, even when quoting earlier output.",
    "If the git diff is marked incomplete, report failed and explain what prevented complete inspection.",
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
  testCommands: string[];
  worktreePath: string | undefined;
}): { team: TeamRow; task: TeamTaskRow; member?: TeamMemberRow; gitDiff: string; testCommands: string[]; worktreePath?: string } {
  const output: { team: TeamRow; task: TeamTaskRow; member?: TeamMemberRow; gitDiff: string; testCommands: string[]; worktreePath?: string } = {
    team: input.team,
    task: input.task,
    gitDiff: input.gitDiff,
    testCommands: input.testCommands,
  };
  if (input.member) output.member = input.member;
  if (input.worktreePath) output.worktreePath = input.worktreePath;
  return output;
}

function verifierVerdict(task: LocalSubagentTaskResult): { status: Exclude<TeamTaskVerifierResultStatus, "skipped">; feedback: string } {
  const feedback = task.error?.message ?? task.summary ?? "";
  if (task.status !== "completed" || task.error) {
    return { status: "failed", feedback: feedback || `Verifier task ended with status ${task.status}.` };
  }
  const text = feedback.trim();
  const lines = text.split(/\r?\n/);
  const firstVerdict = /^VERDICT:[\t ]*(passed|failed)[\t ]*$/i.exec(lines[0] ?? "");
  const verdictCount = [...text.replace(/[`*_]/g, "").matchAll(/\bVERDICT[\t ]*:[\t ]*(?:passed|failed)\b/gi)].length;
  if (firstVerdict && verdictCount === 1) {
    return { status: firstVerdict[1]?.toLowerCase() === "passed" ? "passed" : "failed", feedback: text };
  }
  return {
    status: "failed",
    feedback: text ? `Verifier did not report a passing verdict.\n\n${text}` : "Verifier did not report a passing verdict.",
  };
}

function verifierClaimSkipReason(reason: string | undefined): TeamTaskVerifierSkipReason {
  if (reason === "already_verified") return "already_passed";
  if (reason === "verification_pending" || reason === "stale") return "verification_pending";
  return "not_completed";
}

function verificationFields(input: {
  status: TeamTaskVerificationStatus;
  claimId?: string;
  verifierTaskId?: TaskId;
  verifierRunId?: AgentRunId;
  verifierPath?: AgentPath;
  checkedAt?: number;
  startedAt?: number;
  feedback?: string;
  workerSummary: string | undefined;
  gitDiff?: string;
}): TeamTaskVerificationMetadata {
  const output: TeamTaskVerificationMetadata = {
    status: input.status,
  };
  if (input.claimId) output.claimId = input.claimId;
  if (input.gitDiff !== undefined) output.gitDiff = input.gitDiff;
  if (input.verifierTaskId) output.verifierTaskId = input.verifierTaskId;
  if (input.verifierRunId) output.verifierRunId = input.verifierRunId;
  if (input.verifierPath) output.verifierPath = input.verifierPath;
  if (input.checkedAt !== undefined) output.checkedAt = input.checkedAt;
  if (input.startedAt !== undefined) output.startedAt = input.startedAt;
  if (input.feedback) output.feedback = input.feedback;
  if (input.workerSummary) output.workerSummary = input.workerSummary;
  return output;
}

function restoreVerificationMetadata(
  currentMetadata: Record<string, unknown> | undefined,
  previousMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...(currentMetadata ?? {}) };
  const previousVerification = previousMetadata?.[VERIFICATION_METADATA_KEY];
  if (previousVerification === undefined) delete output[VERIFICATION_METADATA_KEY];
  else output[VERIFICATION_METADATA_KEY] = previousVerification;
  return output;
}

function mergeVerificationMetadata(
  metadata: Record<string, unknown> | undefined,
  verification: TeamTaskVerificationMetadata,
): Record<string, unknown> {
  const current = metadata ?? {};
  const previous = isRecord(current[VERIFICATION_METADATA_KEY]) ? current[VERIFICATION_METADATA_KEY] : {};
  const merged = {
    ...previous,
    ...verification,
  };
  if (verification.status !== "pending" && verification.claimId === undefined) {
    delete (merged as Record<string, unknown>).claimId;
  }
  return {
    ...current,
    [VERIFICATION_METADATA_KEY]: pruneUndefined(merged),
  };
}

function normalizeMaxConcurrentVerifications(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_VERIFICATIONS;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_CONCURRENT_VERIFICATIONS;
  return Math.min(value, MAX_CONCURRENT_VERIFICATIONS);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

function isReadOnlyVerificationTask(task: TeamTaskRow): boolean {
  const writeScope = metadataStringArray(task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
  const executeScope = metadataStringArray(task.metadata, ["executeScope", "execute_scope", "executionScope", "execution_scope"]);
  if ((writeScope?.length ?? 0) > 0 || (executeScope?.length ?? 0) > 0) return false;
  const tools = metadataStringArray(task.metadata, ["requiredTools", "required_tools", "toolScope", "tool_scope"]);
  const mutatingTools = new Set(["edit", "write", "write_file", "apply_patch", "patch", "bash", "shell", "run_shell_command"]);
  return !(tools ?? []).some((tool) => mutatingTools.has(tool.trim().toLowerCase()));
}

function verifierTestCommands(metadata: Record<string, unknown> | undefined): string[] {
  const commands = metadataStringArray(metadata, [
    "suggestedTestCommands",
    "suggested_test_commands",
    "testCommands",
    "test_commands",
  ]);
  return normalizedVerifierTestCommands(commands);
}

function normalizedVerifierTestCommands(commands: readonly string[] | undefined): string[] {
  return [...new Set((commands ?? []).map((command) => command.trim()).filter(isVerifierTestCommand))];
}

function isVerifierTestCommand(command: string): boolean {
  const argv = simpleCommandArgv(command);
  if (!argv) return false;
  const [program, first, second] = argv;
  if (program === "bun") return first === "test" || (first === "run" && isAllowedScriptName(second));
  if (program === "npm" || program === "pnpm" || program === "yarn") {
    return first === "test" || (first === "run" && isAllowedScriptName(second));
  }
  return program === "tsc";
}

function simpleCommandArgv(command: string): string[] | undefined {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return undefined;
  return argv.every((part) => /^[A-Za-z0-9@%_+=:,./-]+$/.test(part)) ? argv : undefined;
}

function isAllowedScriptName(value: string | undefined): boolean {
  return value === "test" || value === "typecheck" || value === "lint";
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

function splitNul(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

class VerifierGitDiffCollector {
  private text = "";
  private bytes = 0;

  get remainingBytes(): number {
    return DEFAULT_GIT_DIFF_MAX_BYTES - this.bytes;
  }

  append(part: string): boolean {
    if (!part) return true;
    const separator = this.text && !this.text.endsWith("\n") && !part.startsWith("\n") ? "\n" : "";
    const addition = separator + part;
    const bounded = utf8Prefix(addition, this.remainingBytes);
    this.text += bounded;
    this.bytes += Buffer.byteLength(bounded, "utf8");
    return bounded === addition;
  }

  complete(): VerifierGitDiffSnapshot {
    return { text: this.text || "(no diff)" };
  }

  incomplete(reason: string): VerifierGitDiffSnapshot {
    const incompleteReason = utf8Prefix(normalizePersistedError(reason).message || "unknown git diff collection error", 1_024);
    // Persisted metadata may be shortened again, so keep the warning ahead of the patch.
    const marker = `[Git diff incomplete: ${incompleteReason}. Automatic verification cannot pass with omitted changes.]\n\n`;
    return {
      text: marker + utf8Prefix(this.text, DEFAULT_GIT_DIFF_MAX_BYTES - Buffer.byteLength(marker, "utf8")),
      incompleteReason,
    };
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function toError(error: unknown): Error {
  return normalizePersistedError(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Verification aborted");
  error.name = "AbortError";
  throw error;
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const err = toError(error);
  return err.name === "AbortError" && err.message.toLowerCase().includes("aborted");
}

function combinedAbortSignal(
  requestSignal: AbortSignal | undefined,
  operationSignal: AbortSignal,
): AbortSignal {
  if (!requestSignal || requestSignal === operationSignal) return operationSignal;
  return AbortSignal.any([requestSignal, operationSignal]);
}
