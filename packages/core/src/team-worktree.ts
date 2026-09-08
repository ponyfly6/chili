import { Buffer } from "node:buffer";
import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionId, TaskId, TeamId, TimestampMs } from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { TeamRow, TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import type { RuntimeSessionOperation, SessionOperationCoordinator } from "./runtime-service.js";
import { composeTeamTaskDependencyBase } from "./team-artifact.js";
import { TeamNotFoundError, TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import {
  canonicalTeamWorkspacePath,
  resolveTeamSessionAuthority,
  type TeamSessionResolver,
} from "./team-session-authority.js";

const WORKTREE_METADATA_KEY = "worktree";
const MERGE_METADATA_KEY = "merge";
const DEFAULT_BASE_REF = "HEAD";
const ENCODED_PATH_SEGMENT_PREFIX = "~u";
const MAX_PATH_SEGMENT_BYTES = 255;
const SAFE_LITERAL_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type TeamTaskWorktreeStatus = "active";
export type TeamTaskMergeStatus = "pending" | "applied" | "failed" | "conflicted" | "skipped";

export interface TeamWorktreeServiceOptions {
  teams: TeamControlService;
  cwd: string;
  resolveSession: TeamSessionResolver;
  sessionOperations: SessionOperationCoordinator;
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

type AuthorizedTeamWorktreeEnsureInput = TeamWorktreeEnsureInput & {
  sessionId: SessionId;
  cwd: string;
};

interface AuthorizedTeamWorktreeEnsureState {
  input: AuthorizedTeamWorktreeEnsureInput;
  team: TeamRow;
  task: TeamTaskRow;
}

interface RecoverableManagedWorktree {
  path: string;
  head: string;
}

export interface TeamTaskMergeMetadata {
  status: TeamTaskMergeStatus;
  createdAt: number;
  worktreePath?: string;
  baseRef?: string;
  diff?: string;
  diffSummary?: Record<string, unknown>;
  mergedAt?: number;
  error?: string;
  conflicts?: string[];
  reason?: string;
  mainHead?: string;
  worktreeHead?: string;
  artifactCommit?: string;
}

export interface TeamTaskWorktreePreflightInput {
  cwd: string;
  teamId: TeamId;
  taskId: TaskId;
  metadata?: Record<string, unknown> | undefined;
  requireExisting?: boolean;
}

export interface TeamTaskWorktreePathInput {
  cwd: string;
  teamId: TeamId;
  taskId: TaskId;
  candidatePath?: string | undefined;
  requireExisting?: boolean;
}

export class TeamTaskWorktreePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamTaskWorktreePathError";
  }
}

/**
 * Read-only preflight for callers that must reject forged worktree metadata
 * before claiming a team task or starting any process.
 */
export async function preflightTeamTaskWorktree(
  input: TeamTaskWorktreePreflightInput,
): Promise<TeamTaskWorktreeMetadata | undefined> {
  const rawWorktree = input.metadata?.[WORKTREE_METADATA_KEY];
  if (rawWorktree === undefined) return undefined;
  const worktree = worktreeMetadata(input.metadata);
  if (!worktree) {
    throw new TeamTaskWorktreePathError(
      `Task ${input.teamId}/${input.taskId} has invalid worktree metadata`,
    );
  }
  const path = await assertTeamTaskWorktreePath({
    cwd: input.cwd,
    teamId: input.teamId,
    taskId: input.taskId,
    candidatePath: worktree.path,
    ...(input.requireExisting !== undefined ? { requireExisting: input.requireExisting } : {}),
  });
  return { ...worktree, path };
}

export async function assertTeamTaskWorktreePath(input: TeamTaskWorktreePathInput): Promise<string> {
  const workspaceRoot = await canonicalTeamWorkspacePath(input.cwd);
  const lexicalManagedRoot = join(workspaceRoot, ".chili", "worktrees");
  const managedRoot = await canonicalTeamWorkspacePath(lexicalManagedRoot);
  assertStrictDescendant(workspaceRoot, managedRoot, "Managed team worktree root");
  if (managedRoot !== lexicalManagedRoot) {
    throw new TeamTaskWorktreePathError(
      `Managed team worktree root is a symlink alias: ${lexicalManagedRoot}`,
    );
  }

  const lexicalExpectedPath = join(
    managedRoot,
    safePathSegment(input.teamId),
    safePathSegment(input.taskId),
  );
  const expectedPath = await canonicalTeamWorkspacePath(lexicalExpectedPath);
  assertStrictDescendant(managedRoot, expectedPath, "Task worktree");
  if (expectedPath !== lexicalExpectedPath) {
    throw new TeamTaskWorktreePathError(
      `Task ${input.teamId}/${input.taskId} expected worktree path is a symlink alias: ${lexicalExpectedPath}`,
    );
  }

  if (input.candidatePath !== undefined) {
    if (
      input.candidatePath.length === 0
      || input.candidatePath.includes("\0")
      || !isAbsolute(input.candidatePath)
      || resolve(input.candidatePath) !== input.candidatePath
    ) {
      throw new TeamTaskWorktreePathError(
        `Task ${input.teamId}/${input.taskId} worktree path must be an absolute canonical path`,
      );
    }
    const canonicalCandidate = await canonicalTeamWorkspacePath(input.candidatePath);
    if (canonicalCandidate !== input.candidatePath) {
      throw new TeamTaskWorktreePathError(
        `Task ${input.teamId}/${input.taskId} worktree path is not canonical: ${input.candidatePath}`,
      );
    }
    if (canonicalCandidate !== expectedPath) {
      throw new TeamTaskWorktreePathError(
        `Task ${input.teamId}/${input.taskId} worktree path ${canonicalCandidate} does not match expected path ${expectedPath}`,
      );
    }
  }

  if (input.requireExisting) await assertDirectory(expectedPath, input.teamId, input.taskId);
  return expectedPath;
}

export class TeamWorktreeService {
  constructor(private readonly options: TeamWorktreeServiceOptions) {}

  async ensureTaskWorktree(input: TeamWorktreeEnsureInput): Promise<TeamWorktreeEnsureResult> {
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
      return this.ensureTaskWorktreeWithOperation(current, operation);
    });
  }

  private async ensureTaskWorktreeWithOperation(
    state: AuthorizedTeamWorktreeEnsureState,
    operation: RuntimeSessionOperation,
  ): Promise<TeamWorktreeEnsureResult> {
    const { input, task } = state;
    const cwd = input.cwd;
    const existing = await preflightTeamTaskWorktree({
      cwd,
      teamId: input.teamId,
      taskId: input.taskId,
      metadata: task.metadata,
      requireExisting: true,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const dependencyBaseRef = task.dependsOn.length === 0
      ? input.baseRef ?? DEFAULT_BASE_REF
      : await composeTeamTaskDependencyBase({
          cwd,
          baseRef: input.baseRef ?? DEFAULT_BASE_REF,
          task,
          tasks: await this.options.teams.tasks(task.teamId),
          ...(input.signal ? { signal: input.signal } : {}),
        });
    const requestedBaseRef = task.dependsOn.length > 0
      ? await this.resolveCommit(cwd, dependencyBaseRef, input.signal)
      : dependencyBaseRef;
    operation.assertCurrent();
    throwIfAborted(input.signal);
    if (existing?.status === "active") {
      if (task.dependsOn.length > 0 && existing.baseRef !== requestedBaseRef) {
        throw new TeamTaskWorktreePathError("Existing task worktree does not match its delivered dependency snapshot; create a replacement task and transfer needed edits from the preserved worktree");
      }
      return {
        path: existing.path,
        baseRef: existing.baseRef,
        createdAt: existing.createdAt,
        status: existing.status,
        created: false,
        task,
      };
    }

    const path = await assertTeamTaskWorktreePath({ cwd, teamId: input.teamId, taskId: input.taskId });
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const recovered = await this.recoverManagedWorktree(input, path, operation);
    let canonicalPath: string;
    let baseRef: string;
    if (recovered) {
      if (task.dependsOn.length > 0 && recovered.head !== requestedBaseRef) {
        throw new TeamTaskWorktreePathError("Recovered worktree does not match its delivered dependency snapshot");
      }
      canonicalPath = recovered.path;
      baseRef = recovered.head;
    } else {
      const frozenBaseRef = await this.resolveCommit(cwd, requestedBaseRef, input.signal);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      await this.revalidateAuthority(input, operation);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      await mkdir(dirname(path), { recursive: true });
      operation.assertCurrent();
      throwIfAborted(input.signal);
      await assertTeamTaskWorktreePath({
        cwd,
        teamId: input.teamId,
        taskId: input.taskId,
        candidatePath: path,
      });
      await this.revalidateAuthority(input, operation);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      await this.git({
        cwd,
        args: ["worktree", "add", "--detach", path, frozenBaseRef],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      operation.assertCurrent();
      throwIfAborted(input.signal);
      canonicalPath = await assertTeamTaskWorktreePath({
        cwd,
        teamId: input.teamId,
        taskId: input.taskId,
        candidatePath: path,
        requireExisting: true,
      });
      operation.assertCurrent();
      throwIfAborted(input.signal);
      const createdHead = await this.resolveCommit(canonicalPath, DEFAULT_BASE_REF, input.signal);
      operation.assertCurrent();
      throwIfAborted(input.signal);
      if (createdHead !== frozenBaseRef) {
        throw new TeamTaskWorktreePathError(
          `Task ${input.teamId}/${input.taskId} worktree HEAD ${createdHead} does not match frozen base ${frozenBaseRef}`,
        );
      }
      baseRef = frozenBaseRef;
    }

    const createdAt = Number(this.now());
    const metadata = mergeWorktreeMetadata(task.metadata, {
      path: canonicalPath,
      baseRef,
      createdAt,
      status: "active",
    });
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const updatedTask = await this.options.teams.updateTask({
      teamId: input.teamId,
      taskId: input.taskId,
      metadata,
      sessionId: input.sessionId,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);

    return {
      path: canonicalPath,
      baseRef,
      createdAt,
      status: "active",
      created: !recovered,
      task: updatedTask,
    };
  }

  private async recoverManagedWorktree(
    input: AuthorizedTeamWorktreeEnsureInput,
    path: string,
    operation: RuntimeSessionOperation,
  ): Promise<RecoverableManagedWorktree | undefined> {
    if (!(await pathEntryExists(path))) return undefined;
    await this.revalidateAuthority(input, operation);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const listed = await this.git({
      cwd: input.cwd,
      args: ["worktree", "list", "--porcelain"],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const registered = parseRegisteredWorktrees(listed.stdout).find((entry) => entry.path === path);
    const registeredHead = normalizeCommitOid(registered?.head);
    if (!registeredHead) {
      throw new TeamTaskWorktreePathError(
        `Task ${input.teamId}/${input.taskId} worktree path exists but is not a registered worktree with a commit HEAD for ${input.cwd}: ${path}`,
      );
    }
    const canonicalPath = await assertTeamTaskWorktreePath({
      cwd: input.cwd,
      teamId: input.teamId,
      taskId: input.taskId,
      candidatePath: path,
      requireExisting: true,
    });
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const worktreeHead = await this.resolveCommit(canonicalPath, DEFAULT_BASE_REF, input.signal);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    if (worktreeHead !== registeredHead) {
      throw new TeamTaskWorktreePathError(
        `Task ${input.teamId}/${input.taskId} registered HEAD ${registeredHead} does not match worktree HEAD ${worktreeHead}`,
      );
    }
    return { path: canonicalPath, head: registeredHead };
  }

  private async authorizedState(input: TeamWorktreeEnsureInput): Promise<AuthorizedTeamWorktreeEnsureState> {
    const team = await this.requireTeam(input.teamId);
    const tasks = await this.options.teams.tasks(input.teamId);
    const task = tasks.find((item) => item.id === input.taskId);
    if (!task) throw new TeamTaskNotFoundError(input.teamId, input.taskId);
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
      task,
    };
  }

  private async revalidateAuthority(
    input: AuthorizedTeamWorktreeEnsureInput,
    operation: RuntimeSessionOperation,
  ): Promise<AuthorizedTeamWorktreeEnsureState> {
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const state = await this.authorizedState(input);
    operation.assertCurrent();
    throwIfAborted(input.signal);
    return state;
  }

  private async requireTeam(teamId: TeamId): Promise<TeamRow> {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new TeamNotFoundError(teamId);
    return team;
  }

  private async git(input: TeamWorktreeGitRunnerInput): Promise<TeamWorktreeGitRunnerResult> {
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
    return result;
  }

  private async resolveCommit(
    cwd: string,
    ref: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (ref.length === 0 || ref.length > 1024 || ref.includes("\0")) {
      throw new TeamTaskWorktreePathError("Team worktree base ref must be a non-empty valid Git ref");
    }
    const result = await this.git({
      cwd,
      args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      ...(signal ? { signal } : {}),
    });
    const oid = normalizeCommitOid(result.stdout.trim());
    if (!oid) {
      throw new TeamTaskWorktreePathError("Team worktree base ref did not resolve to a full commit object ID");
    }
    return oid;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

export function worktreeMetadata(metadata: Record<string, unknown> | undefined): TeamTaskWorktreeMetadata | undefined {
  const value = metadata?.[WORKTREE_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  const baseRef = typeof value.baseRef === "string" ? normalizeCommitOid(value.baseRef) : undefined;
  if (
    typeof value.path !== "string" ||
    !baseRef ||
    typeof value.createdAt !== "number" ||
    value.status !== "active"
  ) {
    return undefined;
  }
  return { ...value, baseRef } as unknown as TeamTaskWorktreeMetadata;
}

export function taskMergeMetadata(metadata: Record<string, unknown> | undefined): TeamTaskMergeMetadata | undefined {
  const value = metadata?.[MERGE_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (!isMergeStatus(value.status) || typeof value.createdAt !== "number") return undefined;
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
  if (value.length > MAX_PATH_SEGMENT_BYTES) {
    throw new TeamTaskWorktreePathError(
      `Team worktree identifier exceeds the ${MAX_PATH_SEGMENT_BYTES}-byte path segment limit`,
    );
  }

  const literal = SAFE_LITERAL_PATH_SEGMENT.test(value)
    && value !== "."
    && value !== ".."
    && !value.startsWith(ENCODED_PATH_SEGMENT_PREFIX);
  const segment = literal
    ? value
    : `${ENCODED_PATH_SEGMENT_PREFIX}${Buffer.from(value, "utf16le").toString("base64url")}`;
  if (Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_BYTES) {
    throw new TeamTaskWorktreePathError(
      `Team worktree identifier exceeds the ${MAX_PATH_SEGMENT_BYTES}-byte encoded path segment limit`,
    );
  }
  return segment;
}

function normalizeCommitOid(value: string | undefined): string | undefined {
  if (!value || !COMMIT_OID.test(value)) return undefined;
  return value.toLowerCase();
}

function assertStrictDescendant(parent: string, child: string, label: string): void {
  const relativePath = relative(parent, child);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new TeamTaskWorktreePathError(`${label} ${child} escapes authoritative workspace ${parent}`);
  }
}

async function assertDirectory(path: string, teamId: TeamId, taskId: TaskId): Promise<void> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  throw new TeamTaskWorktreePathError(`Task ${teamId}/${taskId} worktree is not an existing directory: ${path}`);
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseRegisteredWorktrees(value: string): Array<{ path: string; head?: string }> {
  const entries: Array<{ path: string; head?: string }> = [];
  let current: { path: string; head?: string } | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
  }
  if (current) entries.push(current);
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMergeStatus(value: unknown): value is TeamTaskMergeStatus {
  return value === "pending" || value === "applied" || value === "failed" || value === "conflicted" || value === "skipped";
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

function combinedAbortSignal(
  requestSignal: AbortSignal | undefined,
  operationSignal: AbortSignal,
): AbortSignal {
  if (!requestSignal || requestSignal === operationSignal) return operationSignal;
  return AbortSignal.any([requestSignal, operationSignal]);
}
