import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGitResourceAccess } from "../file-resource-access.js";
import { withFileOperationLocks } from "../file-operation-lock.js";
import type { ChiliToolDefinition, ChiliToolExecutionContext } from "../types.js";
import { assertDirectWritablePathInsideWorkspace, resolveWorkspacePath } from "../workspace-path.js";
import { assertGitRepositoryRoot, assertGitSuccess, resolveGitCommit, runGit } from "./git-utils.js";

const MAX_PATCH_BYTES = 5_000_000;

export interface GitApplyPatchInput {
  patchText: string;
  expectedHead: string;
  checkOnly?: boolean;
}

export function createGitApplyPatchTool(): ChiliToolDefinition<GitApplyPatchInput> {
  return {
    name: "git_apply_patch", codeMode: true, risk: "write", resourcePolicy: "filesystem",
    isReadOnly: (input) => input.checkOnly === true, isConcurrencySafe: false,
    isDestructive: (input) => !input.checkOnly && /^deleted file mode /m.test(input.patchText),
    description: "Check or apply an explicit Git text patch against expectedHead. Refuses local changes in affected files. Supports regular-file edits, additions, deletions and executable modes; refuses binary, rename, copy, symlink, submodule and quoted/whitespace paths. Does not stage or commit.",
    searchHint: "Safely apply a supplied git diff to clean affected files, or check whether it applies.",
    inputSchema: {
      type: "object", required: ["patchText", "expectedHead"], additionalProperties: false,
      properties: { patchText: { type: "string" }, expectedHead: { type: "string" }, checkOnly: { type: "boolean" } },
    },
    outputSchema: {
      type: "object", required: ["patchHash", "paths", "head", "applicable", "applied"],
      properties: {
        patchHash: { type: "string" }, paths: { type: "array", items: { type: "string" } },
        head: { type: "string" }, applicable: { type: "boolean" }, applied: { type: "boolean" },
      },
    },
    validate(input) {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const unknown = Object.keys(input).find((key) => !["patchText", "expectedHead", "checkOnly"].includes(key));
      if (unknown) return { ok: false, message: `unsupported git_apply_patch parameter: ${unknown}` };
      if (typeof input.patchText !== "string" || Buffer.byteLength(input.patchText) > MAX_PATCH_BYTES) return { ok: false, message: `patchText must be a string of at most ${MAX_PATCH_BYTES} bytes` };
      if (typeof input.expectedHead !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.expectedHead)) return { ok: false, message: "expectedHead must be a complete commit ID" };
      if (input.checkOnly !== undefined && typeof input.checkOnly !== "boolean") return { ok: false, message: "checkOnly must be boolean" };
      try { patchPaths(input.patchText); } catch (error) { return { ok: false, message: (error as Error).message }; }
      return { ok: true, value: { patchText: input.patchText, expectedHead: input.expectedHead.toLowerCase(), ...(input.checkOnly !== undefined ? { checkOnly: input.checkOnly } : {}) } };
    },
    approval(input) {
      return { permission: input.checkOnly ? "git_diff" : "edit", patterns: patchPaths(input.patchText), metadata: { expectedHead: input.expectedHead, checkOnly: input.checkOnly ?? false, patchHash: fingerprint(input.patchText) } };
    },
    async execute(input, context) {
      await assertGitResourceAccess(context, !input.checkOnly);
      const root = await assertGitRepositoryRoot(context);
      const paths = patchPaths(input.patchText);
      const absolutePaths = paths.map((path) => resolveWorkspacePath(root, path).absolutePath);
      // Git is an external writer: use the shared locks, but do not attribute
      // arbitrary observed postimages to this session's mutation journal.
      return withFileOperationLocks(absolutePaths, context.signal, async () => {
        await assertPaths(context, root, paths);
        await assertCleanTarget(context, input.expectedHead, paths);
        const directory = await mkdtemp(join(tmpdir(), "chili-git-patch-"));
        try {
          const patchFile = join(directory, "input.patch");
          await writeFile(patchFile, input.patchText, { encoding: "utf8", mode: 0o600 });
          const statistics = await runGit(context, ["apply", "--numstat", "-z", patchFile]);
          assertGitSuccess(statistics, "git apply --numstat");
          const actualPaths = statistics.stdout.split("\0").filter(Boolean).map((item) => {
            const match = /^\d+\t\d+\t(.+)$/.exec(item);
            if (!match) throw new Error("Unsupported Git patch statistics; no files were changed.");
            return match[1]!;
          }).sort();
          if (JSON.stringify(actualPaths) !== JSON.stringify([...paths].sort())) throw new Error("Git patch paths do not match its declared file headers; no files were changed.");
          const checked = await runGit(context, ["apply", "--check", "--whitespace=nowarn", patchFile]);
          assertGitSuccess(checked, "git apply --check");
          if (!input.checkOnly) {
            await assertPaths(context, root, paths);
            await assertCleanTarget(context, input.expectedHead, paths);
            await context.assertCurrentAuthorization?.();
            const applied = await runGit(context, ["apply", "--whitespace=nowarn", patchFile], { mutates: true });
            assertGitSuccess(applied, "git apply");
            for (const path of absolutePaths) await context.fileReads?.forget(root, path);
          }
          await assertGitResourceAccess(context, !input.checkOnly);
          const result = { patchHash: fingerprint(input.patchText), paths, head: input.expectedHead, applicable: true, applied: !input.checkOnly };
          return { title: input.checkOnly ? "Git patch checked" : "Git patch applied", output: JSON.stringify(result), structuredData: result, metadata: { files: paths } };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  };
}

/** Deliberately narrow syntax; Git also parses the patch and must agree on every path. */
function patchPaths(patch: string): string[] {
  if (!patch || patch.includes("\0") || !patch.endsWith("\n")) throw new Error("Expected a complete newline-terminated Git text patch.");
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    if (/^(?:GIT binary patch|Binary files |rename |copy |similarity index |dissimilarity index )/.test(line)) throw new Error("Binary, rename and copy patches are not supported.");
    if (/^(?:old mode|new mode|new file mode|deleted file mode) /.test(line) && !/^(?:old mode|new mode|new file mode|deleted file mode) 100(?:644|755)$/.test(line)) throw new Error("Only regular-file patch modes are supported.");
    if (line.startsWith("index ") && !/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?$/.test(line)) throw new Error("Unsupported patch object or file mode.");
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/([^\s"\\]+) b\/([^\s"\\]+)$/.exec(line);
    if (!match || match[1] !== match[2]) throw new Error("Patch paths must be unquoted, contain no whitespace, and must not rename files.");
    const path = match[1]!;
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || [".git", ".chili"].includes(part.toLowerCase()))) throw new Error("Patch path escapes the workspace or targets protected metadata.");
    if (paths.includes(path)) throw new Error("A patch may describe each file only once.");
    paths.push(path);
  }
  if (paths.length === 0 || !patch.startsWith("diff --git ")) throw new Error("Expected Git diff --git file headers.");
  return paths;
}

async function assertPaths(context: ChiliToolExecutionContext, root: string, paths: readonly string[]): Promise<void> {
  await context.assertCurrentAuthorization?.();
  const absolutePaths: string[] = [];
  for (const path of paths) {
    const target = resolveWorkspacePath(root, path);
    await assertDirectWritablePathInsideWorkspace(root, target);
    let current = root;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("Git patch paths may not traverse symbolic links.");
        if (current === target.absolutePath && !info.isFile()) throw new Error("Git patch targets must be regular files.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    absolutePaths.push(target.absolutePath);
  }
  await context.assertFileResourceAccess?.(absolutePaths, "read");
  await context.assertFileResourceAccess?.(absolutePaths, "write");
}

async function assertCleanTarget(context: ChiliToolExecutionContext, expectedHead: string, paths: readonly string[]): Promise<void> {
  if (await resolveGitCommit(context) !== expectedHead) throw new Error("Workspace HEAD changed; obtain the current HEAD and inspect the patch before retrying.");
  const status = await runGit(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--", ...paths.map((path) => `:(literal)${path}`)]);
  assertGitSuccess(status, "git status");
  if (status.stdout.length > 0) throw new Error("Patch affects files with local, staged, untracked or ignored changes; no files were changed.");
  // Status can hide edits under assume-unchanged, skip-worktree or a stale stat
  // cache. Compare actual bytes and executable modes to the expected tree too.
  const tree = await runGit(context, ["ls-tree", "-z", expectedHead, "--", ...paths.map((path) => `:(literal)${path}`)]);
  assertGitSuccess(tree, "git ls-tree");
  const entries = new Map<string, { mode: string; hash: string }>();
  for (const record of tree.stdout.split("\0").filter(Boolean)) {
    const match = /^(100(?:644|755)) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(record);
    if (!match || !paths.includes(match[3]!)) throw new Error("Patch base contains an unsupported file type.");
    entries.set(match[3]!, { mode: match[1]!, hash: match[2]! });
  }
  const tracked: string[] = [];
  for (const path of paths) {
    const info = await lstat(resolveWorkspacePath(context.cwd, path).absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const entry = entries.get(path);
    if (!entry) {
      if (info !== null) throw new Error("Patch destination already exists outside the expected tree; no files were changed.");
      continue;
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || ((info.mode & 0o111) !== 0) !== (entry.mode === "100755")) {
      throw new Error("Patch target no longer matches its expected regular-file mode; no files were changed.");
    }
    tracked.push(path);
  }
  if (tracked.length > 0) {
    const hashed = await runGit(context, ["hash-object", "--no-filters", "--", ...tracked]);
    assertGitSuccess(hashed, "git hash-object");
    const hashes = hashed.stdout.trim().split("\n");
    if (hashes.length !== tracked.length || tracked.some((path, index) => entries.get(path)!.hash !== hashes[index])) {
      throw new Error("Patch target bytes differ from the expected commit; no files were changed.");
    }
  }
}

function fingerprint(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
