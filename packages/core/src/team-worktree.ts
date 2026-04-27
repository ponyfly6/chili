import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionId, TaskId, TeamId, ThreadId, TimestampMs } from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";

const WORKTREE_METADATA_KEY = "worktree";
const MERGE_METADATA_KEY = "merge";
const DEFAULT_BASE_REF = "HEAD";

export type TeamTaskWorktreeStatus = "active";
export type TeamTaskMergeStatus = "pending";

export interface TeamWorktreeServiceOptions {
  teams: TeamControlService;
  cwd: string;
  now?: () => TimestampMs;
  runGit?: TeamWorktreeGitRunner;
}

export interface TeamWorktreeGitRunnerInput {
  cwd: string;
  args: readonly string[];
  signal?: AbortSignal;
}

export interface TeamWorktreeGitRunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type TeamWorktreeGitRunner = (input: TeamWorktreeGitRunnerInput) => Promise<TeamWorktreeGitRunnerResult>;

export interface TeamWorktreeEnsureInput {
  teamId: TeamId;
  taskId: TaskId;
  cwd?: string;
  baseRef?: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  signal?: AbortSignal;
}

export interface TeamWorktreeEnsureResult {
  path: string;
  baseRef: string;
  createdAt: number;
  status: TeamTaskWorktreeStatus;
  created: boolean;
  task: TeamTaskRow;
}

export interface TeamTaskWorktreeMetadata {
  path: string;
  baseRef: string;
  createdAt: number;
  status: TeamTaskWorktreeStatus;
}

export interface TeamTaskMergeMetadata {
  status: TeamTaskMergeStatus;
  createdAt: number;
  worktreePath?: string;
  baseRef?: string;
  diff?: string;
}

export class TeamWorktreeService {
  constructor(private readonly options: TeamWorktreeServiceOptions) {}

  async ensureTaskWorktree(input: TeamWorktreeEnsureInput): Promise<TeamWorktreeEnsureResult> {
    const task = await this.requireTeamTask(input.teamId, input.taskId);
    const existing = worktreeMetadata(task.metadata);
    if (existing?.status === "active") {
      return {
        path: existing.path,
        baseRef: existing.baseRef,
        createdAt: existing.createdAt,
        status: existing.status,
        created: false,
        task,
      };
    }

    const cwd = resolve(input.cwd ?? this.options.cwd);
    const baseRef = input.baseRef ?? DEFAULT_BASE_REF;
    const path = resolve(cwd, join(".chili", "worktrees", safePathSegment(input.teamId), safePathSegment(input.taskId)));
    await mkdir(dirname(path), { recursive: true });
    await this.git({
      cwd,
      args: ["worktree", "add", "--detach", path, baseRef],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);

    const createdAt = Number(this.now());
    const metadata = mergeWorktreeMetadata(task.metadata, {
      path,
      baseRef,
      createdAt,
      status: "active",
    });
    const updatedTask = await this.options.teams.updateTask({
      teamId: input.teamId,
      taskId: input.taskId,
      metadata,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });

    return {
      path,
      baseRef,
      createdAt,
      status: "active",
      created: true,
      task: updatedTask,
    };
  }

  private async requireTeamTask(teamId: TeamId, taskId: TaskId): Promise<TeamTaskRow> {
    const task = (await this.options.teams.tasks(teamId)).find((item) => item.id === taskId);
    if (!task) throw new TeamTaskNotFoundError(teamId, taskId);
    return task;
  }

  private async git(input: TeamWorktreeGitRunnerInput): Promise<void> {
    const result = this.options.runGit
      ? await this.options.runGit(input)
      : await runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: 30_000,
          maxOutputBytes: 128_000,
        });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${input.args.join(" ")} exited with code ${result.exitCode}`);
    }
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

export function worktreeMetadata(metadata: Record<string, unknown> | undefined): TeamTaskWorktreeMetadata | undefined {
  const value = metadata?.[WORKTREE_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (
    typeof value.path !== "string" ||
    typeof value.baseRef !== "string" ||
    typeof value.createdAt !== "number" ||
    value.status !== "active"
  ) {
    return undefined;
  }
  return value as unknown as TeamTaskWorktreeMetadata;
}

export function taskMergeMetadata(metadata: Record<string, unknown> | undefined): TeamTaskMergeMetadata | undefined {
  const value = metadata?.[MERGE_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (value.status !== "pending" || typeof value.createdAt !== "number") return undefined;
  return value as unknown as TeamTaskMergeMetadata;
}

export function mergeWorktreeMetadata(
  metadata: Record<string, unknown> | undefined,
  worktree: TeamTaskWorktreeMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [WORKTREE_METADATA_KEY]: pruneUndefined(worktree),
  };
}

export function mergeMergeMetadata(
  metadata: Record<string, unknown> | undefined,
  merge: TeamTaskMergeMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [MERGE_METADATA_KEY]: pruneUndefined(merge),
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Team worktree creation aborted");
  error.name = "AbortError";
  throw error;
}
