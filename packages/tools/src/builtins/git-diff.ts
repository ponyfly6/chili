import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { runProcess, type RunProcessOptions } from "../process.js";

const GIT_BASE_ARGS = ["--no-optional-locks", "-c", "core.quotepath=false"] as const;

export interface GitDiffInput {
  staged?: boolean;
  stat?: boolean;
  base?: string;
  paths?: string[];
  maxOutputBytes?: number;
}

export interface GitStatusInput {
  paths?: string[];
  maxOutputBytes?: number;
}

export interface GitStageInput {
  all?: boolean;
  paths?: string[];
}

export interface GitCommitInput {
  message: string;
  allowEmpty?: boolean;
}

export type GitBranchAction = "current" | "list" | "create" | "switch" | "create_and_switch";

export interface GitBranchInput {
  action?: GitBranchAction;
  name?: string;
  startPoint?: string;
}

interface GitChangedItem {
  path: string;
  status: string;
  code: string;
  oldPath?: string;
}

interface GitBranchState {
  current?: string;
  detached: boolean;
  head?: string;
}

export function createGitDiffTool(): ChiliToolDefinition<GitDiffInput> {
  return {
    name: "git_diff",
    searchHint: "Inspect git diff output, staged changes, stats, or path-specific diffs.",
    description: "Read git diff output for the current workspace.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
        stat: { type: "boolean" },
        base: { type: "string" },
        path: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        maxOutputBytes: { type: "number" },
        max_output_bytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<GitDiffInput> {
      if (input === undefined) return { ok: true, value: {} };
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknownKey = firstUnknownKey(input, [
        "staged",
        "stat",
        "base",
        "path",
        "paths",
        "maxOutputBytes",
        "max_output_bytes",
      ]);
      if (unknownKey) return { ok: false, message: `unsupported git_diff parameter: ${unknownKey}` };

      const value: GitDiffInput = {};
      if (input.staged !== undefined) {
        if (typeof input.staged !== "boolean") return { ok: false, message: "staged must be boolean" };
        value.staged = input.staged;
      }
      if (input.stat !== undefined) {
        if (typeof input.stat !== "boolean") return { ok: false, message: "stat must be boolean" };
        value.stat = input.stat;
      }
      if (input.base !== undefined) {
        if (typeof input.base !== "string" || input.base.trim().length === 0) {
          return { ok: false, message: "base must be a non-empty string" };
        }
        if (!isSafeGitRefish(input.base)) {
          return { ok: false, message: "base must be a safe git revision or ref" };
        }
        value.base = input.base;
      }
      const paths = normalizePathInput(input.path, input.paths, "paths");
      if (!paths.ok) return paths;
      if (paths.value) value.paths = paths.value;

      const maxOutputBytes = input.maxOutputBytes ?? input.max_output_bytes;
      if (maxOutputBytes !== undefined) {
        if (!isPositiveInteger(maxOutputBytes)) {
          return { ok: false, message: "maxOutputBytes must be a positive integer" };
        }
        value.maxOutputBytes = maxOutputBytes;
      }

      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "git_diff",
        patterns: input.paths?.length ? input.paths : ["*"],
        metadata: {
          staged: input.staged ?? false,
          stat: input.stat ?? false,
          base: input.base ?? "",
          paths: input.paths ?? [],
        },
      };
    },
    async execute(input, context) {
      const args = ["diff", "--no-ext-diff", "--no-color"];
      if (input.staged) args.push("--cached");
      if (input.stat) args.push("--stat");
      if (input.base) args.push(input.base);
      if (input.paths?.length) args.push("--", ...input.paths);

      await assertGitRepository(context.cwd, context.signal);
      const result = await runGit(args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 15_000,
        maxOutputBytes: input.maxOutputBytes ?? 512_000,
      });

      if (result.timedOut) {
        throw new Error(`git diff timed out after 15000ms`);
      }
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `git diff exited with code ${result.exitCode}`);
      }

      const output = result.stdout || "(no diff)";
      return {
        title: input.stat ? "git diff --stat" : "git diff",
        output,
        metadata: {
          staged: input.staged ?? false,
          stat: input.stat ?? false,
          base: input.base,
          paths: input.paths ?? [],
          durationMs: result.durationMs,
          truncated: result.stdoutTruncated || result.stderrTruncated,
          outputLimitBytes: result.outputLimitBytes,
        },
      };
    },
  };
}

export function createGitStatusTool(): ChiliToolDefinition<GitStatusInput> {
  return {
    name: "git_status",
    searchHint: "Inspect current git branch, staged changes, unstaged changes, and untracked files.",
    description: "Return structured git status for the current workspace.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        maxOutputBytes: { type: "number" },
        max_output_bytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<GitStatusInput> {
      if (input === undefined) return { ok: true, value: {} };
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknownKey = firstUnknownKey(input, ["path", "paths", "maxOutputBytes", "max_output_bytes"]);
      if (unknownKey) return { ok: false, message: `unsupported git_status parameter: ${unknownKey}` };

      const value: GitStatusInput = {};
      const paths = normalizePathInput(input.path, input.paths, "paths");
      if (!paths.ok) return paths;
      if (paths.value) value.paths = paths.value;

      const maxOutputBytes = input.maxOutputBytes ?? input.max_output_bytes;
      if (maxOutputBytes !== undefined) {
        if (!isPositiveInteger(maxOutputBytes)) {
          return { ok: false, message: "maxOutputBytes must be a positive integer" };
        }
        value.maxOutputBytes = maxOutputBytes;
      }
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "git_status",
        patterns: input.paths?.length ? input.paths : ["*"],
        metadata: { paths: input.paths ?? [] },
      };
    },
    async execute(input, context) {
      await assertGitRepository(context.cwd, context.signal);
      const pathArgs = input.paths?.length ? ["--", ...input.paths] : [];
      const [branch, staged, unstaged, untracked] = await Promise.all([
        readCurrentBranch(context.cwd, context.signal),
        runGit(["diff", "--no-ext-diff", "--name-status", "-z", "--cached", ...pathArgs], {
          cwd: context.cwd,
          signal: context.signal,
          timeoutMs: 15_000,
          maxOutputBytes: input.maxOutputBytes ?? 256_000,
        }),
        runGit(["diff", "--no-ext-diff", "--name-status", "-z", ...pathArgs], {
          cwd: context.cwd,
          signal: context.signal,
          timeoutMs: 15_000,
          maxOutputBytes: input.maxOutputBytes ?? 256_000,
        }),
        runGit(["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs], {
          cwd: context.cwd,
          signal: context.signal,
          timeoutMs: 15_000,
          maxOutputBytes: input.maxOutputBytes ?? 256_000,
        }),
      ]);

      assertGitSuccess(staged, "git diff --cached --name-status");
      assertGitSuccess(unstaged, "git diff --name-status");
      assertGitSuccess(untracked, "git ls-files --others");

      const stagedItems = parseNameStatus(staged.stdout);
      const unstagedItems = parseNameStatus(unstaged.stdout);
      const untrackedItems = parsePathList(untracked.stdout).map((path): GitChangedItem => ({
        path,
        status: "untracked",
        code: "??",
      }));
      const status = {
        branch: branch.current,
        detached: branch.detached,
        head: branch.head,
        clean: stagedItems.length === 0 && unstagedItems.length === 0 && untrackedItems.length === 0,
        staged: stagedItems,
        unstaged: unstagedItems,
        untracked: untrackedItems,
        paths: input.paths ?? [],
      };

      return {
        title: "git status",
        output: JSON.stringify(status, null, 2),
        metadata: {
          ...status,
          durationMs: Math.max(staged.durationMs, unstaged.durationMs, untracked.durationMs),
          truncated: staged.stdoutTruncated || unstaged.stdoutTruncated || untracked.stdoutTruncated,
        },
      };
    },
  };
}

export function createGitStageTool(): ChiliToolDefinition<GitStageInput> {
  return {
    name: "git_stage",
    searchHint: "Stage selected files or all workspace changes with git add.",
    description: "Stage workspace changes in the git index.",
    risk: "write",
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean" },
        path: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
    },
    validate(input): ValidationResult<GitStageInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknownKey = firstUnknownKey(input, ["all", "path", "paths"]);
      if (unknownKey) return { ok: false, message: `unsupported git_stage parameter: ${unknownKey}` };

      const value: GitStageInput = {};
      if (input.all !== undefined) {
        if (typeof input.all !== "boolean") return { ok: false, message: "all must be boolean" };
        value.all = input.all;
      }
      const paths = normalizePathInput(input.path, input.paths, "paths");
      if (!paths.ok) return paths;
      if (paths.value) value.paths = paths.value;
      if (!value.all && !value.paths?.length) {
        return { ok: false, message: "git_stage requires paths or all=true" };
      }
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "git_stage",
        patterns: input.paths?.length ? input.paths : ["*"],
        metadata: {
          all: input.all ?? false,
          paths: input.paths ?? [],
        },
      };
    },
    async execute(input, context) {
      await assertGitRepository(context.cwd, context.signal);
      const args = ["add"];
      if (input.all) args.push("-A");
      args.push("--", ...(input.paths?.length ? input.paths : ["."]));

      const result = await runGit(args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 30_000,
        maxOutputBytes: 256_000,
      });
      assertGitSuccess(result, "git add");

      const staged = await runGit(["diff", "--no-ext-diff", "--name-status", "-z", "--cached"], {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 15_000,
        maxOutputBytes: 256_000,
      });
      assertGitSuccess(staged, "git diff --cached --name-status");
      const stagedItems = parseNameStatus(staged.stdout);
      const output = {
        staged: stagedItems,
        paths: input.paths ?? [],
        all: input.all ?? false,
      };

      return {
        title: "git stage",
        output: JSON.stringify(output, null, 2),
        metadata: {
          ...output,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

export function createGitCommitTool(): ChiliToolDefinition<GitCommitInput> {
  return {
    name: "git_commit",
    searchHint: "Create a local git commit from currently staged changes.",
    description: "Commit staged changes in the current workspace.",
    risk: "write",
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        allowEmpty: { type: "boolean" },
        allow_empty: { type: "boolean" },
      },
    },
    validate(input): ValidationResult<GitCommitInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknownKey = firstUnknownKey(input, ["message", "allowEmpty", "allow_empty"]);
      if (unknownKey) return { ok: false, message: `unsupported git_commit parameter: ${unknownKey}` };

      if (typeof input.message !== "string" || input.message.trim().length === 0) {
        return { ok: false, message: "message must be a non-empty string" };
      }
      if (input.message.includes("\0")) return { ok: false, message: "message must not contain NUL bytes" };

      const allowEmpty = input.allowEmpty ?? input.allow_empty;
      if (allowEmpty !== undefined && typeof allowEmpty !== "boolean") {
        return { ok: false, message: "allowEmpty must be boolean" };
      }

      const value: GitCommitInput = { message: input.message };
      if (allowEmpty !== undefined) value.allowEmpty = allowEmpty;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "git_commit",
        patterns: ["*"],
        metadata: {
          subject: commitSubject(input.message),
          allowEmpty: input.allowEmpty ?? false,
        },
      };
    },
    async execute(input, context) {
      await assertGitRepository(context.cwd, context.signal);
      if (!input.allowEmpty) {
        const staged = await runGit(["diff", "--cached", "--quiet", "--exit-code"], {
          cwd: context.cwd,
          signal: context.signal,
          timeoutMs: 15_000,
          maxOutputBytes: 256_000,
        });
        if (staged.exitCode === 0) {
          throw new Error("No staged changes to commit. Stage files first or set allowEmpty=true.");
        }
        if (staged.exitCode !== 1) {
          throw new Error(staged.stderr || `git diff --cached --quiet exited with code ${staged.exitCode}`);
        }
      }

      const args = ["commit", "--no-gpg-sign"];
      if (input.allowEmpty) args.push("--allow-empty");
            // Add "Co-Authored-By: chili🌶️" attribution as trailer to commit message
      const attribution = `Co-Authored-By: chili🌶️ <noreply@chili.ai>`;
      const commitMessage = `${input.message}\n\n${attribution}`;
      args.push("-m", commitMessage);
      const result = await runGit(args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 30_000,
        maxOutputBytes: 256_000,
      });
      assertGitSuccess(result, "git commit");

      const info = await readCommitInfo(context.cwd, context.signal);
      const output = {
        hash: info.hash,
        subject: info.subject,
      };

      return {
        title: `git commit ${info.hash.slice(0, 12)}`,
        output: JSON.stringify(output, null, 2),
        metadata: {
          ...output,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

export function createGitBranchTool(): ChiliToolDefinition<GitBranchInput> {
  return {
    name: "git_branch",
    searchHint: "Read the current branch, list local branches, or safely create/switch branches.",
    description: "Inspect or update local git branches without destructive checkout flags.",
    risk: "write",
    isReadOnly: (input) => branchAction(input) === "current" || branchAction(input) === "list",
    isConcurrencySafe: (input) => branchAction(input) === "current" || branchAction(input) === "list",
    isDestructive: false,
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["current", "list", "create", "switch", "create_and_switch"] },
        name: { type: "string" },
        startPoint: { type: "string" },
        start_point: { type: "string" },
      },
    },
    validate(input): ValidationResult<GitBranchInput> {
      if (input === undefined) return { ok: true, value: { action: "current" } };
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknownKey = firstUnknownKey(input, ["action", "name", "startPoint", "start_point"]);
      if (unknownKey) return { ok: false, message: `unsupported git_branch parameter: ${unknownKey}` };

      const rawAction = input.action ?? "current";
      if (
        rawAction !== "current" &&
        rawAction !== "list" &&
        rawAction !== "create" &&
        rawAction !== "switch" &&
        rawAction !== "create_and_switch"
      ) {
        return { ok: false, message: "action must be current, list, create, switch, or create_and_switch" };
      }

      const action = rawAction;
      const value: GitBranchInput = { action };
      if (input.name !== undefined) {
        if (typeof input.name !== "string" || input.name.trim().length === 0) {
          return { ok: false, message: "name must be a non-empty string" };
        }
        if (!isSafeBranchName(input.name)) {
          return { ok: false, message: "name must be a safe local branch name" };
        }
        value.name = input.name;
      }

      const startPoint = input.startPoint ?? input.start_point;
      if (startPoint !== undefined) {
        if (typeof startPoint !== "string" || startPoint.trim().length === 0) {
          return { ok: false, message: "startPoint must be a non-empty string" };
        }
        if (!isSafeGitRefish(startPoint)) {
          return { ok: false, message: "startPoint must be a safe git revision or ref" };
        }
        value.startPoint = startPoint;
      }

      if ((action === "create" || action === "switch" || action === "create_and_switch") && !value.name) {
        return { ok: false, message: `git_branch action ${action} requires name` };
      }
      if ((action === "current" || action === "list" || action === "switch") && value.startPoint) {
        return { ok: false, message: "startPoint is only supported for create and create_and_switch" };
      }
      if ((action === "current" || action === "list") && value.name) {
        return { ok: false, message: `name is not supported for git_branch action ${action}` };
      }
      return { ok: true, value };
    },
    approval(input) {
      const action = branchAction(input);
      if (action === "current" || action === "list") return false;
      return {
        permission: "git_branch",
        patterns: input.name ? [input.name] : ["*"],
        metadata: {
          action,
          name: input.name,
          startPoint: input.startPoint,
        },
      };
    },
    async execute(input, context) {
      await assertGitRepository(context.cwd, context.signal);
      const action = branchAction(input);
      const before = await readCurrentBranch(context.cwd, context.signal);

      if (action === "current" || action === "list") {
        const branches = action === "list" ? await listBranches(context.cwd, context.signal) : undefined;
        const output = {
          current: before.current,
          detached: before.detached,
          head: before.head,
          branches,
        };
        return {
          title: action === "list" ? "git branch --list" : "git branch",
          output: JSON.stringify(output, null, 2),
          metadata: output,
        };
      }

      if (!input.name) throw new Error(`git_branch action ${action} requires name`);
      await assertValidBranchName(input.name, context.cwd, context.signal);

      const args =
        action === "create"
          ? ["branch", input.name, ...(input.startPoint ? [input.startPoint] : [])]
          : action === "switch"
            ? ["switch", input.name]
            : ["switch", "-c", input.name, ...(input.startPoint ? [input.startPoint] : [])];
      const result = await runGit(args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 30_000,
        maxOutputBytes: 256_000,
      });
      assertGitSuccess(result, `git ${args[0]}`);

      const after = await readCurrentBranch(context.cwd, context.signal);
      const output = {
        action,
        name: input.name,
        startPoint: input.startPoint,
        before,
        after,
      };
      return {
        title: `git branch ${action}`,
        output: JSON.stringify(output, null, 2),
        metadata: {
          ...output,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

async function assertGitRepository(cwd: string, signal: AbortSignal): Promise<void> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
  });
  if (result.timedOut) {
    throw new Error("git repository check timed out after 10000ms");
  }
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("Not a git repository. Run this tool from inside a git worktree.");
  }
}

async function runGit(
  args: readonly string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) {
  const processOptions: RunProcessOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    env: {
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  if (options.signal) processOptions.signal = options.signal;
  return runProcess("git", [...GIT_BASE_ARGS, ...args], processOptions);
}

function assertGitSuccess(result: Awaited<ReturnType<typeof runGit>>, command: string): void {
  if (result.timedOut) {
    throw new Error(`${command} timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `${command} exited with code ${result.exitCode}`);
  }
}

async function readCurrentBranch(cwd: string, signal: AbortSignal): Promise<GitBranchState> {
  const branch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
  });
  const head = await runGit(["rev-parse", "--short", "HEAD"], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
  });
  const state: GitBranchState = {
    detached: branch.exitCode !== 0,
  };
  if (branch.exitCode === 0 && branch.stdout.trim()) state.current = branch.stdout.trim();
  if (head.exitCode === 0 && head.stdout.trim()) state.head = head.stdout.trim();
  return state;
}

async function readCommitInfo(cwd: string, signal: AbortSignal): Promise<{ hash: string; subject: string }> {
  const result = await runGit(["show", "-s", "--format=%H%x00%s", "HEAD"], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
  });
  assertGitSuccess(result, "git show HEAD");
  const [hash, subject] = result.stdout.split("\0");
  return {
    hash: hash?.trim() ?? "",
    subject: subject?.trim() ?? "",
  };
}

async function listBranches(cwd: string, signal: AbortSignal): Promise<string[]> {
  const result = await runGit(["branch", "--format=%(refname:short)"], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 256_000,
  });
  assertGitSuccess(result, "git branch --format");
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function assertValidBranchName(name: string, cwd: string, signal: AbortSignal): Promise<void> {
  const result = await runGit(["check-ref-format", "--branch", name], {
    cwd,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Invalid branch name: ${name}`);
  }
}

function parseNameStatus(output: string): GitChangedItem[] {
  const tokens = parsePathList(output);
  const items: GitChangedItem[] = [];
  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index++];
    const firstPath = tokens[index++];
    if (!code || !firstPath) break;

    if (code.startsWith("R") || code.startsWith("C")) {
      const nextPath = tokens[index++];
      if (!nextPath) break;
      items.push({
        path: nextPath,
        oldPath: firstPath,
        status: statusFromCode(code),
        code,
      });
    } else {
      items.push({
        path: firstPath,
        status: statusFromCode(code),
        code,
      });
    }
  }
  return items;
}

function parsePathList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function statusFromCode(code: string): string {
  const prefix = code[0];
  if (prefix === "A") return "added";
  if (prefix === "D") return "deleted";
  if (prefix === "M") return "modified";
  if (prefix === "R") return "renamed";
  if (prefix === "C") return "copied";
  if (prefix === "T") return "type_changed";
  if (prefix === "U") return "unmerged";
  return "modified";
}

function normalizePathInput(
  path: unknown,
  paths: unknown,
  label: string,
): ValidationResult<string[] | undefined> {
  const items: unknown[] = [];
  if (path !== undefined) items.push(path);
  if (paths !== undefined) {
    if (!Array.isArray(paths)) return { ok: false, message: `${label} must be an array` };
    items.push(...paths);
  }
  if (items.length === 0) return { ok: true, value: undefined };

  const normalized: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { ok: false, message: `${label} must contain non-empty strings` };
    }
    if (!isSafeWorkspacePath(item)) {
      return { ok: false, message: `${label} must stay inside the workspace` };
    }
    normalized.push(item);
  }
  return { ok: true, value: [...new Set(normalized)] };
}

function isSafeWorkspacePath(path: string): boolean {
  const normalized = path.trim().replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.includes("\0") &&
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..")
  );
}

function isSafeGitRefish(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized.length <= 255 &&
    !normalized.startsWith("-") &&
    !normalized.includes("\0") &&
    !/[\s;|&<>]/.test(normalized)
  );
}

function isSafeBranchName(value: string): boolean {
  const name = value.trim();
  if (!isSafeGitRefish(name)) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.includes("\\") || /[~^:?*[`]/.test(name)) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function firstUnknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(record).find((key) => !allowedSet.has(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function branchAction(input: GitBranchInput): GitBranchAction {
  return input.action ?? "current";
}

function commitSubject(message: string): string {
  return message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
