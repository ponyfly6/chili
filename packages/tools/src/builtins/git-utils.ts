import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { assertGitResourceAccess } from "../file-resource-access.js";
import { runProcess, type RunProcessResult } from "../process.js";
import type { ChiliToolExecutionContext } from "../types.js";

const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const GIT_ENV = {
  GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0",
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CONFIG: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
};

/** Fixed-command Git calls retain the same resource boundary as the other Git tools. */
export async function runGit(
  context: ChiliToolExecutionContext,
  args: readonly string[],
  options: { mutates?: boolean; cwd?: string; maxOutputBytes?: number } = {},
): Promise<RunProcessResult> {
  const cwd = options.cwd ?? context.cwd;
  return runProcess("git", [...GIT_ARGS, ...args], {
    cwd, env: GIT_ENV, signal: context.signal, timeoutMs: 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    beforeSpawn: async () => {
      await assertGitResourceAccess(context, options.mutates ?? false);
      // Checkout and status can invoke configured filters even without an
      // explicit shell tool. These small tools do not grant that capability.
      const filters = await runProcess("git", [...GIT_ARGS, "config", "--null", "--includes", "--get-regexp", "^filter\\..*\\.(clean|process|smudge)$"], {
        cwd, env: GIT_ENV, signal: context.signal, timeoutMs: 10_000, maxOutputBytes: 64_000,
        beforeSpawn: () => assertGitResourceAccess(context, options.mutates ?? false),
      });
      if (filters.timedOut || filters.aborted || filters.stdoutTruncated || filters.stderrTruncated || (filters.exitCode !== 0 && filters.exitCode !== 1)) {
        throw new Error("Cannot verify Git filter configuration.");
      }
      if (filters.exitCode === 0) throw new Error("This Git tool refuses configured repository filters; use an authorized shell for filter-dependent operations.");
      await assertGitResourceAccess(context, options.mutates ?? false);
    },
  });
}

export function assertGitSuccess(result: RunProcessResult, label: string): void {
  if (result.aborted) throw new Error(`${label} was interrupted; inspect the workspace before retrying.`);
  if (result.timedOut) throw new Error(`${label} timed out; inspect the workspace before retrying.`);
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`${label} exceeded its output limit.`);
  if (result.exitCode !== 0) throw new Error(result.stderr || `${label} exited with code ${result.exitCode}`);
}

export async function resolveGitCommit(context: ChiliToolExecutionContext, ref = "HEAD"): Promise<string> {
  if (!ref || ref.length > 1024 || /[\0\r\n]/.test(ref)) throw new Error("Expected a valid Git commit reference.");
  const result = await runGit(context, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { maxOutputBytes: 64_000 });
  assertGitSuccess(result, "git rev-parse");
  const oid = result.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) throw new Error("Git reference did not resolve to a complete commit ID.");
  return oid.toLowerCase();
}

export async function assertGitRepositoryRoot(context: ChiliToolExecutionContext): Promise<string> {
  const result = await runGit(context, ["rev-parse", "--show-toplevel"], { maxOutputBytes: 64_000 });
  assertGitSuccess(result, "git rev-parse --show-toplevel");
  const root = await realpath(result.stdout.trim());
  if (root !== await realpath(resolve(context.cwd))) throw new Error("Run this Git tool from the repository worktree root.");
  return root;
}
