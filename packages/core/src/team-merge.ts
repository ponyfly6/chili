import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionId, TaskId, TeamId, TimestampMs } from "@chili/protocol";
import { normalizePersistedError, timestampNow } from "@chili/protocol";
import type { TeamRow, TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import { TeamNotFoundError, TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import {
  resolveTeamSessionAuthority,
  TeamSessionAuthorityError,
  type TeamSessionResolver,
} from "./team-session-authority.js";
import { verificationMetadata } from "./team-verifier.js";
import {
  assertTeamTaskWorktreePath,
  mergeMergeMetadata,
  preflightTeamTaskWorktree,
  taskMergeMetadata,
  type TeamTaskMergeMetadata,
  type TeamTaskWorktreeMetadata,
} from "./team-worktree.js";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MERGE_PATCH_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_CONCURRENT_MERGE_PRECHECKS = 4;
const MAX_SUMMARY_PATHS = 100;

export type TeamMergeResultStatus = "applied" | "failed" | "conflicted" | "skipped";
export type TeamMergeSkippedReason = "not_passed" | "missing_merge_metadata" | "not_pending" | "missing_worktree";

export interface TeamMergeServiceOptions {
  teams: TeamControlService;
  cwd: string;
  resolveSession: TeamSessionResolver;
  sessionOperations: SessionOperationCoordinator;
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
  signal?: AbortSignal;
}

type AuthorizedTeamMergeInput = TeamMergeInput & { sessionId: SessionId; cwd: string };

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

interface PreparedMergeTask {
  status: "prepared";
  task: TeamTaskRow;
  merge: DurableTeamTaskMergeMetadata;
  cwd: string;
  worktreePath: string;
  patch: WorktreePatch;
  baseCommit: string;
  postStateFingerprint: string;
  recovering: boolean;
  mainHead?: string;
  worktreeHead?: string;
}

interface DurableTeamTaskMergeMetadata extends TeamTaskMergeMetadata {
  applyStartedAt?: number;
  patchFingerprint?: string;
  applyPaths?: string[];
  baseCommit?: string;
  postStateFingerprint?: string;
}

type MergePreparationResult = PreparedMergeTask | TeamMergeTaskResult | TeamMergeTaskSkipped;

interface PatchCheckResult {
  ok: boolean;
  error?: string;
  conflicts?: string[];
}

interface PatchApplicationInspection {
  state: "applied" | "unapplied" | "partial";
  forward: PatchCheckResult;
  reverse: PatchCheckResult;
}

type FrozenApplyIntent =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | {
      kind: "valid";
      patch: WorktreePatch;
      baseCommit: string;
      patchFingerprint: string;
      postStateFingerprint: string;
    };

interface FinalizeMergeInput {
  task: TeamTaskRow;
  merge: DurableTeamTaskMergeMetadata;
  status: TeamMergeResultStatus;
  diff: string;
  summary: TeamMergeDiffSummary;
  mergedAt: number;
  worktreePath?: string;
  error?: string;
  conflicts?: string[];
  reason?: string;
  mainHead?: string;
  worktreeHead?: string;
  baseCommit?: string;
  expectedPatchFingerprint?: string;
}

interface AuthorizedTeamMergeState {
  input: AuthorizedTeamMergeInput;
  tasks: TeamTaskRow[];
}

interface RevalidatedPendingMergeTask {
  input: AuthorizedTeamMergeInput;
  task: TeamTaskRow;
  merge: DurableTeamTaskMergeMetadata;
  worktree?: TeamTaskWorktreeMetadata;
}

export class TeamMergeService {
  constructor(private readonly options: TeamMergeServiceOptions) {}

  async mergeTeamTasks(input: TeamMergeInput): Promise<TeamMergeSweepResult> {
    const initialAuthority = await this.authorizedInput(input);
    return this.options.sessionOperations.withSessionOperation(
      initialAuthority.sessionId,
      async (operation) => {
        operation.assertCurrent();
        const authorizedInput = await this.authorizedInput({
          ...initialAuthority,
          signal: combinedAbortSignal(input.signal, operation.signal),
        });
        operation.assertCurrent();
        throwIfAborted(authorizedInput.signal);
        return this.mergeAuthorizedTeamTasks(authorizedInput, operation);
      },
    );
  }

  private async mergeAuthorizedTeamTasks(
    authorizedInput: AuthorizedTeamMergeInput,
    operation: RuntimeSessionOperation,
  ): Promise<TeamMergeSweepResult> {
    const { tasks } = await this.teamState(authorizedInput.teamId);
    const input = authorizedInput;
    const selected = input.taskId ? [this.requireTask(input.teamId, input.taskId, tasks)] : tasks;
    const result: TeamMergeSweepResult = {
      scanned: 0,
      applied: [],
      failed: [],
      conflicted: [],
      skipped: [],
      errors: [],
    };

    const pending: TeamTaskRow[] = [];
    for (const task of selected) {
      const skipReason = pendingMergeSkipReason(task);
      if (skipReason) {
        if (input.taskId) {
          result.skipped.push({ status: "skipped", teamTask: task, reason: skipReason });
        }
        continue;
      }

      result.scanned++;
      pending.push(task);
    }

    const ready: PreparedMergeTask[] = [];
    for (const batch of chunk(pending, DEFAULT_MAX_CONCURRENT_MERGE_PRECHECKS)) {
      const prepared = await Promise.all(batch.map(async (task) => {
        try {
          return { task, result: await this.prepareMergeTask(authorizedInput, task, operation) };
        } catch (error) {
          if (shouldRethrowMergeBoundaryError(error, authorizedInput.signal)) throw error;
          return { task, error };
        }
      }));

      for (const item of prepared) {
        if ("error" in item) {
          result.errors.push({
            teamId: input.teamId,
            taskId: item.task.id,
            error: toError(item.error).message,
          });
          continue;
        }
        if (item.result.status === "prepared") ready.push(item.result);
        else collectMergeResult(result, item.result);
      }
    }

    for (const item of ready) {
      try {
        const refreshedInput = await this.authorizedInput(authorizedInput);
        operation.assertCurrent();
        collectMergeResult(result, await this.applyPreparedMergeTask(refreshedInput, item, operation));
      } catch (error) {
        if (shouldRethrowMergeBoundaryError(error, authorizedInput.signal)) throw error;
        result.errors.push({
          teamId: input.teamId,
          taskId: item.task.id,
          error: toError(error).message,
        });
      }
    }

    return result;
  }

  private async prepareMergeTask(
    input: AuthorizedTeamMergeInput,
    task: TeamTaskRow,
    operation: RuntimeSessionOperation,
  ): Promise<MergePreparationResult> {
    const merge = durableMergeMetadata(task.metadata);
    if (!merge || merge.status !== "pending") {
      return { status: "skipped", teamTask: task, reason: merge ? "not_pending" : "missing_merge_metadata" };
    }

    const cwd = input.cwd;
    const worktree = await preflightTeamTaskWorktree({
      cwd,
      teamId: task.teamId,
      taskId: task.id,
      metadata: task.metadata,
    });
    if (merge.worktreePath !== undefined) {
      await assertTeamTaskWorktreePath({
        cwd,
        teamId: task.teamId,
        taskId: task.id,
        candidatePath: merge.worktreePath,
      });
    }
    const resolvedWorktreePath = worktree?.path;
    const mergedAt = Number(this.now());

    const frozenIntent = frozenApplyIntent(merge);
    if (frozenIntent.kind === "invalid") {
      const summary = emptyDiffSummary();
      const conflicts = [frozenIntent.error];
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "conflicted",
        diff: merge.diff ?? "(invalid frozen patch)",
        summary,
        mergedAt,
        ...(resolvedWorktreePath ? { worktreePath: resolvedWorktreePath } : {}),
        error: "Pending merge apply intent is incomplete or corrupted",
        conflicts,
      }, operation);
      return {
        status: "conflicted",
        teamTask: updated,
        diffSummary: summary,
        error: "Pending merge apply intent is incomplete or corrupted",
        conflicts,
      };
    }
    if (frozenIntent.kind === "valid") {
      if (!resolvedWorktreePath) {
        throw new Error(`Task ${task.teamId}/${task.id} lost worktree metadata after merge apply started`);
      }
      return {
        status: "prepared",
        task,
        merge,
        cwd,
        worktreePath: resolvedWorktreePath,
        patch: frozenIntent.patch,
        baseCommit: frozenIntent.baseCommit,
        postStateFingerprint: frozenIntent.postStateFingerprint,
        recovering: true,
        ...(merge.mainHead ? { mainHead: merge.mainHead } : {}),
        ...(merge.worktreeHead ? { worktreeHead: merge.worktreeHead } : {}),
      };
    }

    if (!resolvedWorktreePath || !(await isDirectory(resolvedWorktreePath))) {
      const summary = emptyDiffSummary();
      const error = resolvedWorktreePath ? `Task worktree is missing: ${resolvedWorktreePath}` : "Task worktree metadata is missing";
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "skipped",
        diff: merge.diff ?? "(no diff)",
        summary,
        mergedAt,
        ...(worktree ? { worktreePath: worktree.path } : {}),
        error,
        reason: "missing_worktree",
      }, operation);
      return { status: "skipped", teamTask: updated, reason: "missing_worktree", error };
    }

    throwIfAborted(input.signal);
    const confirmedWorktree = await preflightTeamTaskWorktree({
      cwd,
      teamId: task.teamId,
      taskId: task.id,
      metadata: task.metadata,
      requireExisting: true,
    });
    if (!confirmedWorktree) {
      throw new Error(`Task ${task.teamId}/${task.id} worktree metadata disappeared during merge preparation`);
    }
    const baseCommit = await this.revParseCommit(cwd, confirmedWorktree.baseRef, input.signal);
    const [patch, mainHead, worktreeHead] = await Promise.all([
      this.worktreePatch(confirmedWorktree.path, baseCommit, input.signal),
      this.revParseHead(cwd, input.signal),
      this.revParseHead(confirmedWorktree.path, input.signal),
    ]);
    throwIfAborted(input.signal);

    const postStateFingerprint = await pathStateFingerprint(confirmedWorktree.path, patch.paths);

    if (patch.patch.trim().length === 0) {
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "applied",
        diff: "(no diff)",
        summary: patch.summary,
        mergedAt,
        worktreePath: confirmedWorktree.path,
        baseCommit,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "applied", teamTask: updated, diffSummary: patch.summary };
    }

    if (!mainHead) {
      throw new Error(`Task ${task.teamId}/${task.id} could not resolve the main workspace HEAD`);
    }
    const committedPaths = await this.committedMainPaths(
      cwd,
      baseCommit,
      mainHead,
      patch.paths,
      input.signal,
    );
    if (committedPaths.length > 0) {
      const conflicts = committedPaths.map((path) => `Main workspace has committed divergence at ${path}`);
      const error = "Main workspace has committed changes in files touched by the task patch";
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath: confirmedWorktree.path,
        baseCommit,
        error,
        conflicts,
        mainHead,
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
    }

    const dirtyPaths = await this.dirtyMainPaths(cwd, patch.paths, input.signal);
    if (dirtyPaths.length > 0) {
      const conflicts = dirtyPaths.map((path) => `Main workspace has local changes at ${path}`);
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath: confirmedWorktree.path,
        baseCommit,
        error: "Main workspace has local changes in files touched by the task patch",
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, conflicts };
    }

    const checked = await this.checkPatch(cwd, patch.patch, input.signal);
    if (!checked.ok) {
      const updated = await this.finalizeMerge(input, {
        task,
        merge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath: confirmedWorktree.path,
        baseCommit,
        ...(checked.error ? { error: checked.error } : {}),
        ...(checked.conflicts ? { conflicts: checked.conflicts } : {}),
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return {
        status: "conflicted",
        teamTask: updated,
        diffSummary: patch.summary,
        ...(checked.error ? { error: checked.error } : {}),
        ...(checked.conflicts ? { conflicts: checked.conflicts } : {}),
      };
    }

    const prepared: PreparedMergeTask = {
      status: "prepared",
      task,
      merge,
      cwd,
      worktreePath: confirmedWorktree.path,
      patch,
      baseCommit,
      postStateFingerprint,
      recovering: false,
    };
    if (mainHead) prepared.mainHead = mainHead;
    if (worktreeHead) prepared.worktreeHead = worktreeHead;
    return prepared;
  }

  private async applyPreparedMergeTask(
    input: AuthorizedTeamMergeInput,
    prepared: PreparedMergeTask,
    operation: RuntimeSessionOperation,
  ): Promise<TeamMergeTaskResult> {
    const { task, cwd, worktreePath, patch, mainHead, worktreeHead, baseCommit } = prepared;
    const mergedAt = Number(this.now());
    const durableInput: AuthorizedTeamMergeInput = {
      ...input,
      signal: operation.signal,
    };

    const validationInput = prepared.recovering ? durableInput : input;
    await this.revalidatePendingMergeTask(validationInput, task.id, worktreePath, !prepared.recovering);

    let durableMerge = prepared.merge;
    if (!prepared.recovering) {
      const currentMainHead = await this.revParseHead(cwd, input.signal);
      if (!mainHead || currentMainHead !== mainHead) {
        const error = "Main workspace HEAD changed before the merge apply intent was recorded";
        const conflicts = [`Expected main HEAD ${mainHead ?? "(missing)"}, found ${currentMainHead ?? "(unresolved)"}`];
        const updated = await this.finalizeMerge(input, {
          task,
          merge: prepared.merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          worktreePath,
          baseCommit,
          error,
          conflicts,
          ...(mainHead ? { mainHead } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
        }, operation);
        return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
      }
      const committedPaths = await this.committedMainPaths(
        cwd,
        baseCommit,
        mainHead,
        patch.paths,
        input.signal,
      );
      if (committedPaths.length > 0) {
        const conflicts = committedPaths.map((path) => `Main workspace has committed divergence at ${path}`);
        const error = "Main workspace has committed changes in files touched by the task patch";
        const updated = await this.finalizeMerge(input, {
          task,
          merge: prepared.merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          worktreePath,
          baseCommit,
          error,
          conflicts,
          mainHead,
          ...(worktreeHead ? { worktreeHead } : {}),
        }, operation);
        return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
      }
      const dirtyPaths = await this.dirtyMainPaths(cwd, patch.paths, input.signal);
      if (dirtyPaths.length > 0) {
        const conflicts = dirtyPaths.map((path) => `Main workspace has local changes at ${path}`);
        const updated = await this.finalizeMerge(input, {
          task,
          merge: prepared.merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          worktreePath,
          baseCommit,
          error: "Main workspace has local changes in files touched by the task patch",
          conflicts,
          ...(mainHead ? { mainHead } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
        }, operation);
        return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, conflicts };
      }

      const checked = await this.checkPatch(cwd, patch.patch, input.signal);
      if (!checked.ok) {
        const updated = await this.finalizeMerge(input, {
          task,
          merge: prepared.merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          worktreePath,
          baseCommit,
          ...(checked.error ? { error: checked.error } : {}),
          ...(checked.conflicts ? { conflicts: checked.conflicts } : {}),
          ...(mainHead ? { mainHead } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
        }, operation);
        return {
          status: "conflicted",
          teamTask: updated,
          diffSummary: patch.summary,
          ...(checked.error ? { error: checked.error } : {}),
          ...(checked.conflicts ? { conflicts: checked.conflicts } : {}),
        };
      }

      const [currentWorktreePatch, currentWorktreeHead] = await Promise.all([
        this.worktreePatch(worktreePath, baseCommit, input.signal),
        this.revParseHead(worktreePath, input.signal),
      ]);
      const currentWorktreePostState = await pathStateFingerprint(worktreePath, currentWorktreePatch.paths);
      if (
        patchFingerprint(currentWorktreePatch.patch) !== patchFingerprint(patch.patch)
        || !samePaths(currentWorktreePatch.paths, patch.paths)
        || currentWorktreePostState !== prepared.postStateFingerprint
        || !worktreeHead
        || currentWorktreeHead !== worktreeHead
      ) {
        const error = "Task worktree changed before the merge apply intent was recorded";
        const conflicts = [error];
        const updated = await this.finalizeMerge(input, {
          task,
          merge: prepared.merge,
          status: "conflicted",
          diff: patch.patch,
          summary: patch.summary,
          mergedAt,
          worktreePath,
          baseCommit,
          error,
          conflicts,
          mainHead,
          ...(worktreeHead ? { worktreeHead } : {}),
        }, operation);
        return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
      }

      durableMerge = await this.persistApplyIntent(input, prepared, operation);
    }

    // The pending apply intent is now durable. From this point on, caller
    // cancellation is advisory; only loss of the owner operation can stop the
    // side effect or its recovery/finalization.
    operation.assertCurrent();
    throwIfAborted(operation.signal);
    const expectedPatchFingerprint = patchFingerprint(patch.patch);
    const currentMainHead = await this.revParseHead(cwd, operation.signal);
    if (!durableMerge.mainHead || currentMainHead !== durableMerge.mainHead) {
      const error = "Main workspace HEAD changed after the merge apply intent was frozen";
      const conflicts = [
        `Expected main HEAD ${durableMerge.mainHead ?? "(missing)"}, found ${currentMainHead ?? "(unresolved)"}`,
      ];
      const updated = await this.finalizeMerge(durableInput, {
        task,
        merge: durableMerge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath,
        baseCommit,
        expectedPatchFingerprint,
        error,
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
    }
    const inspection = await this.inspectPatchApplication(cwd, patch.patch, operation.signal);
    operation.assertCurrent();

    if (inspection.state === "partial") {
      const error = "Frozen task patch is partially applied or conflicts with the main workspace";
      const conflicts = patchInspectionConflicts(inspection);
      const updated = await this.finalizeMerge(durableInput, {
        task,
        merge: durableMerge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath,
        baseCommit,
        expectedPatchFingerprint,
        error,
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
    }

    if (inspection.state === "unapplied") {
      const patchFile = await this.writeTemporaryPatch(patch.patch);
      try {
        const revalidated = await this.revalidatePendingMergeTask(durableInput, task.id, worktreePath, false);
        assertFrozenApplyIntent(revalidated.merge, expectedPatchFingerprint);
        operation.assertCurrent();
        const mainHeadBeforeApply = await this.revParseHead(cwd, operation.signal);
        if (mainHeadBeforeApply !== durableMerge.mainHead) {
          const error = "Main workspace HEAD changed before the frozen task patch could be applied";
          const conflicts = [
            `Expected main HEAD ${durableMerge.mainHead ?? "(missing)"}, found ${mainHeadBeforeApply ?? "(unresolved)"}`,
          ];
          const updated = await this.finalizeMerge(durableInput, {
            task,
            merge: durableMerge,
            status: "conflicted",
            diff: patch.patch,
            summary: patch.summary,
            mergedAt,
            worktreePath,
            baseCommit,
            expectedPatchFingerprint,
            error,
            conflicts,
            ...(mainHead ? { mainHead } : {}),
            ...(worktreeHead ? { worktreeHead } : {}),
          }, operation);
          return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
        }
        const applied = await this.git({
          cwd: revalidated.input.cwd,
          args: ["apply", "--whitespace=nowarn", patchFile],
          signal: operation.signal,
        });
        operation.assertCurrent();
        if (applied.exitCode !== 0) {
          const afterFailure = await this.inspectPatchApplication(cwd, patch.patch, operation.signal);
          operation.assertCurrent();
          if (afterFailure.state === "partial") {
            const error = applied.stderr || "git apply left the frozen task patch partially applied";
            const conflicts = patchInspectionConflicts(afterFailure);
            const updated = await this.finalizeMerge(durableInput, {
              task,
              merge: durableMerge,
              status: "conflicted",
              diff: patch.patch,
              summary: patch.summary,
              mergedAt,
              worktreePath,
              baseCommit,
              expectedPatchFingerprint,
              error,
              conflicts,
              ...(mainHead ? { mainHead } : {}),
              ...(worktreeHead ? { worktreeHead } : {}),
            }, operation);
            return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
          }
          if (afterFailure.state === "unapplied") {
            const error = applied.stderr || `git apply exited with ${applied.exitCode}`;
            const updated = await this.finalizeMerge(durableInput, {
              task,
              merge: durableMerge,
              status: "failed",
              diff: patch.patch,
              summary: patch.summary,
              mergedAt,
              worktreePath,
              baseCommit,
              expectedPatchFingerprint,
              error,
              ...(mainHead ? { mainHead } : {}),
              ...(worktreeHead ? { worktreeHead } : {}),
            }, operation);
            return { status: "failed", teamTask: updated, diffSummary: patch.summary, error };
          }
        }
      } finally {
        await rm(dirname(patchFile), { recursive: true, force: true });
      }
    }

    const mainHeadBeforeFinalize = await this.revParseHead(cwd, operation.signal);
    if (mainHeadBeforeFinalize !== durableMerge.mainHead) {
      const error = "Main workspace HEAD changed before the frozen task patch could be finalized";
      const conflicts = [
        `Expected main HEAD ${durableMerge.mainHead ?? "(missing)"}, found ${mainHeadBeforeFinalize ?? "(unresolved)"}`,
      ];
      const updated = await this.finalizeMerge(durableInput, {
        task,
        merge: durableMerge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath,
        baseCommit,
        expectedPatchFingerprint,
        error,
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
    }

    const actualPostStateFingerprint = await pathStateFingerprint(cwd, patch.paths);
    if (actualPostStateFingerprint !== prepared.postStateFingerprint) {
      const error = "Files touched by the frozen task patch changed after the merge apply intent was recorded";
      const conflicts = [
        `Expected post-state ${prepared.postStateFingerprint}, found ${actualPostStateFingerprint}`,
      ];
      const updated = await this.finalizeMerge(durableInput, {
        task,
        merge: durableMerge,
        status: "conflicted",
        diff: patch.patch,
        summary: patch.summary,
        mergedAt,
        worktreePath,
        baseCommit,
        expectedPatchFingerprint,
        error,
        conflicts,
        ...(mainHead ? { mainHead } : {}),
        ...(worktreeHead ? { worktreeHead } : {}),
      }, operation);
      return { status: "conflicted", teamTask: updated, diffSummary: patch.summary, error, conflicts };
    }

    const updated = await this.finalizeMerge(durableInput, {
      task,
      merge: durableMerge,
      status: "applied",
      diff: patch.patch,
      summary: patch.summary,
      mergedAt,
      worktreePath,
      baseCommit,
      expectedPatchFingerprint,
      ...(mainHead ? { mainHead } : {}),
      ...(worktreeHead ? { worktreeHead } : {}),
    }, operation);
    return { status: "applied", teamTask: updated, diffSummary: patch.summary };
  }

  private async persistApplyIntent(
    input: AuthorizedTeamMergeInput,
    prepared: PreparedMergeTask,
    operation: RuntimeSessionOperation,
  ): Promise<DurableTeamTaskMergeMetadata> {
    const current = await this.revalidatePendingMergeTask(
      input,
      prepared.task.id,
      prepared.worktreePath,
      true,
    );
    if (current.merge.createdAt !== prepared.merge.createdAt) {
      throw new Error(`Task ${prepared.task.teamId}/${prepared.task.id} merge metadata changed before apply intent`);
    }
    if (frozenApplyIntent(current.merge).kind !== "none") {
      throw new Error(`Task ${prepared.task.teamId}/${prepared.task.id} gained a merge apply intent concurrently`);
    }
    if (!prepared.mainHead || !prepared.worktreeHead) {
      throw new Error(`Task ${prepared.task.teamId}/${prepared.task.id} cannot freeze merge intent without full repository heads`);
    }

    const intent: DurableTeamTaskMergeMetadata = {
      status: "pending",
      createdAt: current.merge.createdAt,
      worktreePath: prepared.worktreePath,
      baseRef: prepared.baseCommit,
      baseCommit: prepared.baseCommit,
      diff: prepared.patch.patch,
      diffSummary: prepared.patch.summary as unknown as Record<string, unknown>,
      applyStartedAt: Number(this.now()),
      patchFingerprint: patchFingerprint(prepared.patch.patch),
      applyPaths: [...prepared.patch.paths],
      postStateFingerprint: prepared.postStateFingerprint,
      ...(prepared.mainHead ? { mainHead: prepared.mainHead } : {}),
      ...(prepared.worktreeHead ? { worktreeHead: prepared.worktreeHead } : {}),
    };
    operation.assertCurrent();
    throwIfAborted(input.signal);
    const updated = await this.options.teams.updateTask({
      teamId: current.task.teamId,
      taskId: current.task.id,
      metadata: mergeMergeMetadata(current.task.metadata, intent),
      sessionId: current.input.sessionId,
    });
    operation.assertCurrent();
    const persisted = durableMergeMetadata(updated.metadata);
    if (!persisted) throw new Error(`Task ${prepared.task.teamId}/${prepared.task.id} lost merge metadata after apply intent`);
    assertFrozenApplyIntent(persisted, intent.patchFingerprint!);
    return persisted;
  }

  private async inspectPatchApplication(
    cwd: string,
    patch: string,
    signal: AbortSignal | undefined,
  ): Promise<PatchApplicationInspection> {
    const reverse = await this.checkPatch(cwd, patch, signal, true);
    const forward = await this.checkPatch(cwd, patch, signal);
    if (reverse.ok && !forward.ok) return { state: "applied", forward, reverse };
    if (forward.ok && !reverse.ok) return { state: "unapplied", forward, reverse };
    return { state: "partial", forward, reverse };
  }

  private async worktreePatch(
    cwd: string,
    baseCommit: string,
    signal: AbortSignal | undefined,
  ): Promise<WorktreePatch> {
    const tracked = await this.git({
      cwd,
      args: ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--binary", baseCommit, "--"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(tracked, `git diff ${baseCommit}`);
    ensureNotTruncated(tracked, `git diff ${baseCommit}`);

    const paths = await this.changedPaths(cwd, baseCommit, signal);
    const parts = tracked.stdout.length > 0 ? [tracked.stdout] : [];
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
      if (fileDiff.stdout.length > 0) parts.push(fileDiff.stdout);
    }

    const patch = concatenatePatchParts(parts);
    if (Buffer.byteLength(patch, "utf8") > DEFAULT_MERGE_PATCH_MAX_BYTES) {
      throw new Error(`Task patch output exceeded ${DEFAULT_MERGE_PATCH_MAX_BYTES} bytes`);
    }
    return {
      patch,
      paths,
      summary: diffSummary(paths, patch),
    };
  }

  private async changedPaths(
    cwd: string,
    baseCommit: string,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const tracked = await this.git({
      cwd,
      args: ["diff", "--no-renames", "--name-only", "-z", baseCommit, "--"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(tracked, `git diff --name-only ${baseCommit}`);
    ensureNotTruncated(tracked, `git diff --name-only ${baseCommit}`);
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

  private async committedMainPaths(
    cwd: string,
    baseCommit: string,
    mainHead: string,
    paths: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    if (paths.length === 0) return [];
    const result = await this.git({
      cwd,
      args: [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        baseCommit,
        mainHead,
        "--",
        ...paths.map(literalPathspec),
      ],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(result, `git diff ${baseCommit} ${mainHead}`);
    ensureNotTruncated(result, `git diff ${baseCommit} ${mainHead}`);
    return uniquePaths(splitNul(result.stdout));
  }

  private async dirtyMainPaths(cwd: string, paths: readonly string[], signal: AbortSignal | undefined): Promise<string[]> {
    if (paths.length === 0) return [];
    const result = await this.git({
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--", ...paths.map(literalPathspec)],
      ...(signal ? { signal } : {}),
      maxOutputBytes: DEFAULT_MERGE_PATCH_MAX_BYTES,
    });
    ensureGitSuccess(result, "git status --porcelain");
    ensureNotTruncated(result, "git status --porcelain");
    return splitNul(result.stdout)
      .map((item) => item.slice(3))
      .filter((path) => path.length > 0);
  }

  private async checkPatch(
    cwd: string,
    patch: string,
    signal: AbortSignal | undefined,
    reverse = false,
  ): Promise<PatchCheckResult> {
    const patchFile = await this.writeTemporaryPatch(patch);
    try {
      const checked = await this.git({
        cwd,
        args: ["apply", ...(reverse ? ["--reverse"] : []), "--check", "--whitespace=nowarn", patchFile],
        ...(signal ? { signal } : {}),
      });
      if (checked.exitCode === 0) return { ok: true };
      const error = checked.stderr || `git apply${reverse ? " --reverse" : ""} --check exited with ${checked.exitCode}`;
      return {
        ok: false,
        error,
        conflicts: conflictLines(checked.stderr || checked.stdout || error),
      };
    } finally {
      await rm(dirname(patchFile), { recursive: true, force: true });
    }
  }

  private async revParseHead(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const result = await this.git({
      cwd,
      args: ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      ...(signal ? { signal } : {}),
      maxOutputBytes: 64_000,
    });
    if (result.exitCode !== 0) return undefined;
    const head = result.stdout.trim();
    return isFullObjectId(head) ? head : undefined;
  }

  private async revParseCommit(
    cwd: string,
    ref: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.git({
      cwd,
      args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      ...(signal ? { signal } : {}),
      maxOutputBytes: 64_000,
    });
    ensureGitSuccess(result, `git rev-parse ${ref}`);
    const commit = result.stdout.trim();
    if (!isFullObjectId(commit)) throw new Error(`git rev-parse ${ref} did not return a full object id`);
    return commit;
  }

  private async writeTemporaryPatch(patch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "chili-team-merge-"));
    const path = join(dir, "task.patch");
    await writeFile(path, patch, "utf8");
    return path;
  }

  private async finalizeMerge(
    authorityInput: AuthorizedTeamMergeInput,
    input: FinalizeMergeInput,
    operation: RuntimeSessionOperation,
  ): Promise<TeamTaskRow> {
    const revalidated = await this.revalidatePendingMergeTask(
      authorityInput,
      input.task.id,
      input.worktreePath,
      false,
    );
    if (revalidated.merge.createdAt !== input.merge.createdAt) {
      throw new Error(`Task ${input.task.teamId}/${input.task.id} merge metadata changed before finalization`);
    }
    if (input.expectedPatchFingerprint) {
      assertFrozenApplyIntent(revalidated.merge, input.expectedPatchFingerprint);
    }
    const merge: TeamTaskMergeMetadata = {
      status: input.status,
      createdAt: revalidated.merge.createdAt,
      diff: input.diff,
      diffSummary: input.summary as unknown as Record<string, unknown>,
      mergedAt: input.mergedAt,
    };
    if (revalidated.worktree) {
      merge.worktreePath = revalidated.worktree.path;
      merge.baseRef = input.baseCommit ?? revalidated.worktree.baseRef;
    }
    if (input.error) merge.error = normalizePersistedError(input.error).message;
    if (input.conflicts) {
      merge.conflicts = input.conflicts
        .slice(0, 20)
        .map((conflict) => normalizePersistedError(conflict).message);
    }
    if (input.reason) merge.reason = normalizePersistedError(input.reason).message;
    if (input.mainHead) merge.mainHead = input.mainHead;
    if (input.worktreeHead) merge.worktreeHead = input.worktreeHead;
    const metadata = mergeMergeMetadata(revalidated.task.metadata, merge);
    operation.assertCurrent();
    throwIfAborted(authorityInput.signal);
    const updated = await this.options.teams.updateTask({
      teamId: revalidated.task.teamId,
      taskId: revalidated.task.id,
      metadata,
      sessionId: revalidated.input.sessionId,
    });
    operation.assertCurrent();
    return updated;
  }

  private async authorizedInput(input: TeamMergeInput): Promise<AuthorizedTeamMergeInput> {
    return (await this.authorizedState(input)).input;
  }

  private async authorizedState(input: TeamMergeInput): Promise<AuthorizedTeamMergeState> {
    const { team, tasks } = await this.teamState(input.teamId);
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
      tasks,
    };
  }

  private async revalidatePendingMergeTask(
    input: AuthorizedTeamMergeInput,
    taskId: TaskId,
    expectedWorktreePath: string | undefined,
    requireExistingWorktree: boolean,
  ): Promise<RevalidatedPendingMergeTask> {
    const authorized = await this.authorizedState(input);
    const task = this.requireTask(input.teamId, taskId, authorized.tasks);
    const merge = durableMergeMetadata(task.metadata);
    if (
      task.status !== "completed"
      || verificationMetadata(task.metadata)?.status !== "passed"
      || !merge
      || merge.status !== "pending"
    ) {
      throw new Error(`Task ${task.teamId}/${task.id} is no longer a verifier-passed pending merge`);
    }
    const worktree = await preflightTeamTaskWorktree({
      cwd: authorized.input.cwd,
      teamId: task.teamId,
      taskId: task.id,
      metadata: task.metadata,
      requireExisting: requireExistingWorktree,
    });
    if (merge.worktreePath !== undefined) {
      await assertTeamTaskWorktreePath({
        cwd: authorized.input.cwd,
        teamId: task.teamId,
        taskId: task.id,
        candidatePath: merge.worktreePath,
        ...(requireExistingWorktree ? { requireExisting: true } : {}),
      });
    }
    if (expectedWorktreePath !== undefined && worktree?.path !== expectedWorktreePath) {
      throw new Error(`Task ${task.teamId}/${task.id} worktree changed before merge side effect`);
    }
    if (expectedWorktreePath === undefined && worktree !== undefined) {
      throw new Error(`Task ${task.teamId}/${task.id} gained worktree metadata before merge side effect`);
    }
    return {
      input: authorized.input,
      task,
      merge,
      ...(worktree ? { worktree } : {}),
    };
  }

  private async teamState(teamId: TeamId): Promise<{ team: TeamRow; tasks: TeamTaskRow[] }> {
    const teams = await this.options.teams.listTeams();
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) throw new TeamNotFoundError(teamId);
    return { team, tasks: await this.options.teams.tasks(teamId) };
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

function collectMergeResult(result: TeamMergeSweepResult, item: TeamMergeTaskResult | TeamMergeTaskSkipped): void {
  if (item.status === "skipped") {
    result.skipped.push({
      ...item,
      ...(item.error ? { error: normalizePersistedError(item.error).message } : {}),
    });
    return;
  }
  const normalized: TeamMergeTaskResult = {
    ...item,
    ...(item.error ? { error: normalizePersistedError(item.error).message } : {}),
    ...(item.conflicts
      ? {
          conflicts: item.conflicts
            .slice(0, 20)
            .map((conflict) => normalizePersistedError(conflict).message),
        }
      : {}),
  };
  switch (item.status) {
    case "applied":
      result.applied.push(normalized);
      return;
    case "failed":
      result.failed.push(normalized);
      return;
    case "conflicted":
      result.conflicted.push(normalized);
      return;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
  return [...new Set(paths.filter((path) => path.length > 0))].sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniquePaths(left);
  const normalizedRight = uniquePaths(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((path, index) => path === normalizedRight[index]);
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function concatenatePatchParts(parts: readonly string[]): string {
  let output = "";
  for (const part of parts) {
    if (part.length === 0) continue;
    if (output.length > 0 && !output.endsWith("\n") && !part.startsWith("\n")) output += "\n";
    output += part;
  }
  return output;
}

function durableMergeMetadata(
  metadata: Record<string, unknown> | undefined,
): DurableTeamTaskMergeMetadata | undefined {
  return taskMergeMetadata(metadata) as DurableTeamTaskMergeMetadata | undefined;
}

function frozenApplyIntent(merge: DurableTeamTaskMergeMetadata): FrozenApplyIntent {
  const hasIntentField = merge.applyStartedAt !== undefined
    || merge.patchFingerprint !== undefined
    || merge.applyPaths !== undefined
    || merge.baseCommit !== undefined
    || merge.postStateFingerprint !== undefined;
  if (!hasIntentField) return { kind: "none" };
  if (typeof merge.applyStartedAt !== "number" || !Number.isFinite(merge.applyStartedAt)) {
    return { kind: "invalid", error: "Merge apply intent is missing applyStartedAt" };
  }
  if (typeof merge.diff !== "string" || merge.diff.length === 0) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen patch" };
  }
  if (typeof merge.patchFingerprint !== "string") {
    return { kind: "invalid", error: "Merge apply intent is missing its patch fingerprint" };
  }
  if (typeof merge.baseCommit !== "string" || !isFullObjectId(merge.baseCommit)) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen base commit" };
  }
  if (!merge.mainHead || !isFullObjectId(merge.mainHead)) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen main HEAD" };
  }
  if (!merge.worktreeHead || !isFullObjectId(merge.worktreeHead)) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen worktree HEAD" };
  }
  if (typeof merge.postStateFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(merge.postStateFingerprint)) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen post-state fingerprint" };
  }
  if (!Array.isArray(merge.applyPaths) || merge.applyPaths.some((path) => typeof path !== "string")) {
    return { kind: "invalid", error: "Merge apply intent is missing its frozen path set" };
  }
  const actualFingerprint = patchFingerprint(merge.diff);
  if (actualFingerprint !== merge.patchFingerprint) {
    return { kind: "invalid", error: "Merge apply intent patch fingerprint does not match its frozen patch" };
  }
  const paths = uniquePaths(merge.applyPaths);
  return {
    kind: "valid",
    patch: {
      patch: merge.diff,
      paths,
      summary: diffSummary(paths, merge.diff),
    },
    baseCommit: merge.baseCommit,
    patchFingerprint: merge.patchFingerprint,
    postStateFingerprint: merge.postStateFingerprint,
  };
}

function assertFrozenApplyIntent(
  merge: DurableTeamTaskMergeMetadata,
  expectedPatchFingerprint: string,
): void {
  const intent = frozenApplyIntent(merge);
  if (intent.kind !== "valid" || intent.patchFingerprint !== expectedPatchFingerprint) {
    throw new Error("Pending merge apply intent changed before the git side effect completed");
  }
}

function patchFingerprint(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

async function pathStateFingerprint(cwd: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of uniquePaths(paths)) {
    if (!isSafeRepositoryPath(path)) {
      throw new Error(`Task patch contains an unsafe repository path: ${path}`);
    }
    hash.update(`path\0${path.length}\0${path}\0`);
    const fullPath = join(cwd, path);
    try {
      const entry = await lstat(fullPath);
      if (entry.isSymbolicLink()) {
        const target = await readlink(fullPath);
        hash.update(`symlink\0${target.length}\0${target}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${(entry.mode & 0o111) === 0 ? "-" : "x"}\0${entry.size}\0`);
        for await (const chunk of createReadStream(fullPath)) hash.update(chunk);
        hash.update("\0");
      } else if (entry.isDirectory()) {
        hash.update("directory\0");
      } else {
        hash.update(`other\0${entry.mode}\0`);
      }
    } catch (error) {
      if (isMissingFileError(error)) hash.update("missing\0");
      else throw error;
    }
  }
  return hash.digest("hex");
}

function isSafeRepositoryPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: string }).code === "ENOENT";
}

function patchInspectionConflicts(inspection: PatchApplicationInspection): string[] {
  const conflicts = [
    ...(inspection.forward.error ? [`Forward check: ${inspection.forward.error}`] : []),
    ...(inspection.reverse.error ? [`Reverse check: ${inspection.reverse.error}`] : []),
  ];
  if (conflicts.length > 0) return conflicts.flatMap(conflictLines).slice(0, 20);
  return ["Frozen patch has an ambiguous forward/reverse application state"];
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
  return normalizePersistedError(error);
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const err = toError(error);
  return err.name === "AbortError" && err.message.toLowerCase().includes("aborted");
}

function shouldRethrowMergeBoundaryError(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return isSignalAbort(error, signal)
    || error instanceof RuntimeBusyError
    || error instanceof TeamSessionAuthorityError;
}

function combinedAbortSignal(
  requestSignal: AbortSignal | undefined,
  operationSignal: AbortSignal,
): AbortSignal {
  if (!requestSignal || requestSignal === operationSignal) return operationSignal;
  return AbortSignal.any([requestSignal, operationSignal]);
}
