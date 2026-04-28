import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionId, TaskId, TeamId, ThreadId, TimestampMs } from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import { TeamNotFoundError, TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import { verificationMetadata } from "./team-verifier.js";
import { mergeMergeMetadata, taskMergeMetadata, worktreeMetadata, type TeamTaskMergeMetadata } from "./team-worktree.js";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MERGE_PATCH_MAX_BYTES = 5_000_000;
const MAX_SUMMARY_PATHS = 100;

export type TeamMergeResultStatus = "applied" | "failed" | "conflicted" | "skipped";
export type TeamMergeSkippedReason = "not_passed" | "missing_merge_metadata" | "not_pending" | "missing_worktree";

export interface TeamMergeServiceOptions {
  teams: TeamControlService;
  cwd: string;
  now?: () => TimestampMs;
  runGit?: TeamMergeGitRunner;
}

export interface TeamMergeGitRunnerInput {
  cwd: string;
  args: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TeamMergeGitRunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type TeamMergeGitRunner = (input: TeamMergeGitRunnerInput) => Promise<TeamMergeGitRunnerResult>;

export interface TeamMergeInput {
  teamId: TeamId;
  taskId?: TaskId;
  cwd?: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  signal?: AbortSignal;
}

export interface TeamMergeSweepResult {
  scanned: number;
  applied: TeamMergeTaskResult[];
  failed: TeamMergeTaskResult[];
  conflicted: TeamMergeTaskResult[];
  skipped: TeamMergeTaskSkipped[];
  errors: TeamMergeError[];
}

export interface TeamMergeTaskResult {
  status: Exclude<TeamMergeResultStatus, "skipped">;
  teamTask: TeamTaskRow;
  diffSummary?: TeamMergeDiffSummary;
  error?: string;
  conflicts?: string[];
}

export interface TeamMergeTaskSkipped {
  status: "skipped";
  teamTask: TeamTaskRow;
  reason: TeamMergeSkippedReason;
  error?: string;
}

export interface TeamMergeError {
  teamId: TeamId;
  taskId: TaskId;
  error: string;
}

export interface TeamMergeDiffSummary {
  filesChanged: number;
  paths: string[];
  truncatedPaths: boolean;
  diffBytes: number;
}

interface WorktreePatch {
  patch: string;
  paths: string[];
  summary: TeamMergeDiffSummary;
}

interface FinalizeMergeInput {
  task: TeamTaskRow;
  merge: TeamTaskMergeMetadata;
  status: TeamMergeResultStatus;
  diff: string;
  summary: TeamMergeDiffSummary;
  mergedAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  error?: string;
  conflicts?: string[];
  reason?: string;
  mainHead?: string;
  worktreeHead?: string;
}

export class TeamMergeService {
  constructor(private readonly options: TeamMergeServiceOptions) {}

  async mergeTeamTasks(input: TeamMergeInput): Promise<TeamMergeSweepResult> {
    const tasks = await this.teamTasks(input.teamId);
    const selected = input.taskId ? [this.requireTask(input.teamId, input.taskId, tasks)] : tasks;
    const result: TeamMergeSweepResult = {
      scanned: 0,
      applied: [],
      failed: [],
      conflicted: [],
      skipped: [],
      errors: [],
    };

    for (const task of selected) {
      const skipReason = pendingMergeSkipReason(task);
      if (skipReason) {
        if (input.taskId) {
          result.skipped.push({ status: "skipped", teamTask: task, reason: skipReason });
        }
        continue;
      }

      result.scanned++;
      try {
        const merged = await this.mergeTask(input, task);
        if (merged.status === "applied") result.applied.push(merged);
        else if (merged.status === "failed") result.failed.push(merged);
        else if (merged.status === "conflicted") result.conflicted.push(merged);
        else if (merged.status === "skipped") result.skipped.push(merged);
      } catch (error) {
        if (isSignalAbort(error, input.signal)) throw error;
        result.errors.push({
          teamId: input.teamId,
          taskId: task.id,
          error: toError(error).message,
        });
      }
    }

    return result;
  }

  private async mergeTask(input: TeamMergeInput, task: TeamTaskRow): Promise<TeamMergeTaskResult | TeamMergeTaskSkipped> {
    const merge = taskMergeMetadata(task.metadata);
    if (!merge || merge.status !== "pending") {
      return { status: "skipped", teamTask: task, reason: merge ? "not_pending" : "missing_merge_metadata" };
    }

    const cwd = resolve(input.cwd ?? this.options.cwd);
    const worktree = worktreeMetadata(task.metadata);
    const worktreePath = merge.worktreePath ?? worktree?.path;
    const resolvedWorktreePath = worktreePath ? resolve(cwd, worktreePath) : undefined;
    const mergedAt = Number(this.now());

    if (!resolvedWorktreePath || !(await isDirectory(resolvedWorktreePath))) {
      const summary = emptyDiffSummary();
      const error = resolvedWorktreePath ? `Task worktree is missing: ${resolvedWorktreePath}` : "Task worktree metadata is missing";
      const updated = await this.finalizeMerge({
        task,
        merge,
        status: "skipped",
        diff: merge.diff ?? "(no diff)",
        summary,
        mergedAt,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        error,
        reason: "missing_worktree",
      });
      return { status: "skipped", teamTask: updated, reason: "missing_worktree", error };
    }

    throwIfAborted(input.signal);
    const [patch, mainHead, worktreeHead] = await Promise.all([
      this.worktreePatch(resolvedWorktreePath, input.signal),
      this.revParseHead(cwd, input.signal),
      this.revParseHead(resolvedWorktreePath, input.signal),
    ]);
    throwIfAborted(input.signal);

    if (patch.patch.trim().length === 0) {
      const updated = await this.finalizeMerge({
        task,
        merge,
        status: "applied",
        diff: "(no diff)",
        summary: patch.summary,
        mergedAt,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      });
      return { status: "applied", teamTask: updated, diffSummary: patch.summary };
    }

    const dirtyPaths = await this.dirtyMainPaths(cwd, patch.paths, input.signal);
    if (dirtyPaths.length > 0) {
      const conflicts = dirtyPaths.map((path) => `Main workspace has local changes at ${path}`);
      const updated = await this.finalizeMerge({
        task,
        merge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        error: "Main workspace has local changes in files touched by the task patch",
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      });
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, conflicts };
    }

    const patchFile = await this.writeTemporaryPatch(patch.patch);
    try {
      const checked = await this.git({
        cwd,
        args: ["apply", "--check", "--whitespace=nowarn", patchFile],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (checked.exitCode !== 0) {
        const conflicts = conflictLines(checked.stderr || checked.stdout || `git apply --check exited with ${checked.exitCode}`);
        const updated = await this.finalizeMerge({
          task,
          merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          error: checked.stderr || `git apply --check exited with ${checked.exitCode}`,
          conflicts,
          ...(mainHead ? { mainHead } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
        });
        return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error: checked.stderr, conflicts };
      }

      const applied = await this.git({
        cwd,
        args: ["apply", "--whitespace=nowarn", patchFile],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (applied.exitCode !== 0) {
        const error = applied.stderr || `git apply exited with ${applied.exitCode}`;
        const updated = await this.finalizeMerge({
          task,
          merge,
          status: "failed",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          error,
          ...(mainHead ? { mainHead } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
        });
        return { status: "failed", teamTask: updated, diffSummary: patch.summary, error };
      }
    } finally {
      await rm(dirname(patchFile), { recursive: true, force: true });
    }

    const updated = await this.finalizeMerge({
      task,
      merge,
      status: "applied",
      diff: patch.patch,
      summary: patch.summary,
      mergedAt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(mainHead ? { mainHead } : {}),
      ...(worktreeHead ? { worktreeHead } : {}),
    });
    return { status: "applied", teamTask: updated, diffSummary: patch.summary };
  }

  private async worktreePatch(cwd: string, signal: AbortSignal | undefined): Promise<WorktreePatch> {
    const tracked = await this.git({
      cwd,
      args: ["diff", "--no-ext-diff", "--no-color", "--binary", "HEAD", "--"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(tracked, "git diff HEAD");
    ensureNotTruncated(tracked, "git diff HEAD");

    const paths = await this.changedPaths(cwd, signal);
    const parts = tracked.stdout.trim().length > 0 ? [tracked.stdout.trimEnd()] : [];
    const untracked = await this.untrackedPaths(cwd, signal);
    for (const path of untracked) {
      const fileDiff = await this.git({
        cwd,
        args: ["diff", "--no-ext-diff", "--no-color", "--binary", "--no-index", "--", "/dev/null", path],
        ...(signal ? { signal } : {}),
        maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
      });
      if (fileDiff.exitCode !== 0 && fileDiff.exitCode !== 1) {
        throw new Error(fileDiff.stderr || `git diff --no-index failed for ${path} with exit ${fileDiff.exitCode}`);
      }
      ensureNotTruncated(fileDiff, `git diff --no-index ${path}`);
      if (fileDiff.stdout.trim().length > 0) parts.push(fileDiff.stdout.trimEnd());
    }

    const joined = parts.join("\n");
    const patch = joined.length > 0 && !joined.endsWith("\n") ? `${joined}\n` : joined;
    return {
      patch,
      paths,
      summary: diffSummary(paths, patch),
    };
  }

  private async changedPaths(cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
    const tracked = await this.git({
      cwd,
      args: ["diff", "--name-only", "-z", "HEAD", "--"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(tracked, "git diff --name-only HEAD");
    ensureNotTruncated(tracked, "git diff --name-only HEAD");
    return uniquePaths([...splitNul(tracked.stdout), ...(await this.untrackedPaths(cwd, signal))]);
  }

  private async untrackedPaths(cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
    const result = await this.git({
      cwd,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(result, "git ls-files --others");
    ensureNotTruncated(result, "git ls-files --others");
    return splitNul(result.stdout);
  }

  private async dirtyMainPaths(cwd: string, paths: readonly string[], signal: AbortSignal | undefined): Promise<string[]> {
    if (paths.length === 0) return [];
    const result = await this.git({
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--", ...paths],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(result, "git status --porcelain");
    ensureNotTruncated(result, "git status --porcelain");
    return splitNul(result.stdout)
      .map((item) => item.slice(3).trim())
      .filter(Boolean);
  }

  private async revParseHead(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const result = await this.git({
      cwd,
      args: ["rev-parse", "HEAD"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: 64_000,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  private async writeTemporaryPatch(patch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "chili-team-merge-"));
    const path = join(dir, "task.patch");
    await writeFile(path, patch, "utf8");
    return path;
  }

  private async finalizeMerge(input: FinalizeMergeInput): Promise<TeamTaskRow> {
    const merge: TeamTaskMergeMetadata = {
      status: input.status,
      createdAt: input.merge.createdAt,
      diff: input.diff,
      diffSummary: input.summary as unknown as Record<string, unknown>,
      mergedAt: input.mergedAt,
    };
    if (input.merge.worktreePath) merge.worktreePath = input.merge.worktreePath;
    if (input.merge.baseRef) merge.baseRef = input.merge.baseRef;
    if (input.error) merge.error = input.error;
    if (input.conflicts) merge.conflicts = input.conflicts;
    if (input.reason) merge.reason = input.reason;
    if (input.mainHead) merge.mainHead = input.mainHead;
    if (input.worktreeHead) merge.worktreeHead = input.worktreeHead;
    const metadata = mergeMergeMetadata(input.task.metadata, merge);
    return this.options.teams.updateTask({
      teamId: input.task.teamId,
      taskId: input.task.id,
      metadata,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
  }

  private async teamTasks(teamId: TeamId): Promise<TeamTaskRow[]> {
    const teams = await this.options.teams.listTeams();
    if (!teams.some((team) => team.id === teamId)) throw new TeamNotFoundError(teamId);
    return this.options.teams.tasks(teamId);
  }

  private requireTask(teamId: TeamId, taskId: TaskId, tasks: readonly TeamTaskRow[]): TeamTaskRow {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new TeamTaskNotFoundError(teamId, taskId);
    return task;
  }

  private async git(input: TeamMergeGitRunnerInput): Promise<TeamMergeGitRunnerResult> {
    return this.options.runGit
      ? this.options.runGit(input)
      : runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
          maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MERGE_PATCH_MAX_BYTES,
        });
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function pendingMergeSkipReason(task: TeamTaskRow): TeamMergeSkippedReason | undefined {
  if (verificationMetadata(task.metadata)?.status !== "passed") return "not_passed";
  const merge = taskMergeMetadata(task.metadata);
  if (!merge) return "missing_merge_metadata";
  if (merge.status !== "pending") return "not_pending";
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function ensureGitSuccess(result: TeamMergeGitRunnerResult, label: string): void {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.exitCode !== 0) throw new Error(result.stderr || `${label} exited with ${result.exitCode}`);
}

function ensureNotTruncated(result: TeamMergeGitRunnerResult, label: string): void {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`${label} output exceeded ${DEFAULT_MERGE_PATCH_MAX_BYTES} bytes`);
  }
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort();
}

function diffSummary(paths: readonly string[], diff: string): TeamMergeDiffSummary {
  return {
    filesChanged: paths.length,
    paths: paths.slice(0, MAX_SUMMARY_PATHS),
    truncatedPaths: paths.length > MAX_SUMMARY_PATHS,
    diffBytes: new TextEncoder().encode(diff).length,
  };
}

function emptyDiffSummary(): TeamMergeDiffSummary {
  return {
    filesChanged: 0,
    paths: [],
    truncatedPaths: false,
    diffBytes: 0,
  };
}

function conflictLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Team merge aborted");
  error.name = "AbortError";
  throw error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const err = toError(error);
  return err.name === "AbortError" && err.message.toLowerCase().includes("aborted");
}
