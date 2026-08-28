import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChiliEvent } from "@chili/protocol";
import type { RuntimeClient } from "@chili/sdk";
import type { DiffScope } from "../shared/contracts.js";
import { DetachedProcessGroupRegistry } from "./detached-process-group-registry.js";

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKED_REFS_BYTES = 2 * 1024 * 1024;
const MAX_GIT_LIST_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_PATHS = 20_000;
const MAX_UNTRACKED_FILES = 40;
const GIT_TIMEOUT_MS = 10_000;
const DIFF_TIME_BUDGET_MS = 8_000;
const TRUNCATION_MARKER = "# diff output truncated by the safety limit";
const EXPLICIT_READ_ONLY_TOOLS = new Set([
  "activate_skill",
  "delegation_status",
  "get_goal",
  "git_diff",
  "git_status",
  "glob",
  "grep",
  "mcp_resource_read",
  "mcp_resources_list",
  "read",
  "read_image",
  "request_user_input",
  "tool_search",
]);

interface DiffResult<Scope extends DiffScope> {
  scope: Scope;
  text: string;
  truncated: boolean;
}

interface HeadTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  oid: string;
  size?: number;
}

interface IndexEntry {
  path: string;
  mode: string;
  oid: string;
}

interface IndexScan {
  entries: Map<string, IndexEntry>;
  unmergedPaths: Set<string>;
}

interface GitObjectMetadata {
  type: "blob" | "commit";
  size: number;
}

type FileState =
  | { kind: "missing" }
  | { kind: "file" | "symlink"; mode: string; content?: Buffer; size: number; unavailable?: string }
  | { kind: "submodule"; mode: "160000"; oid?: string; unavailable?: string }
  | { kind: "other"; mode: string; description: string };

interface SnapshotManifest {
  version: 2;
  id: string;
  cwd: string;
  entries: SnapshotManifestEntry[];
}

interface SnapshotManifestEntry {
  relativePath: string;
  kind: "regular" | "missing";
  existed: boolean;
  mode?: 0o100644 | 0o100755;
  backupName?: string;
}

interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

interface GitMetadata {
  gitDirectory: string;
  commonDirectory: string;
}

interface GitCommandContext {
  processGroups: DetachedProcessGroupRegistry;
  signal?: AbortSignal;
}

class GitCommandError extends Error {
  override readonly name = "GitCommandError";

  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

class UnsafePathError extends Error {
  override readonly name = "UnsafePathError";
}

class DiffBudget {
  private readonly deadline = Date.now() + DIFF_TIME_BUDGET_MS;
  private readonly parts: string[] = [];
  private outputBytes = 0;
  private readBytes = 0;
  private outputFull = false;
  private incomplete = false;
  private readLimitReported = false;
  private timeLimitReported = false;

  reserveRead(bytes: number): boolean {
    if (!this.canContinue()) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.readBytes + bytes > MAX_TOTAL_READ_BYTES) {
      if (!this.readLimitReported) {
        this.readLimitReported = true;
        this.addWarning(`# content scan truncated at ${MAX_TOTAL_READ_BYTES} bytes`);
      }
      this.incomplete = true;
      return false;
    }
    this.readBytes += bytes;
    return true;
  }

  canContinue(): boolean {
    if (this.outputFull) return false;
    if (Date.now() <= this.deadline) return true;
    if (!this.timeLimitReported) {
      this.timeLimitReported = true;
      this.addWarning(`# diff scan truncated after ${DIFF_TIME_BUDGET_MS} ms`);
    }
    this.incomplete = true;
    return false;
  }

  remainingTimeMs(): number {
    return Math.max(1, Math.min(GIT_TIMEOUT_MS, this.deadline - Date.now()));
  }

  addPatch(patch: string): void {
    this.add(patch);
  }

  addWarning(warning: string): void {
    this.incomplete = true;
    this.add(warning);
  }

  result<Scope extends DiffScope>(scope: Scope, emptyText: string): DiffResult<Scope> {
    if (this.outputFull) this.appendMarker();
    const text = this.parts.join("");
    return { scope, text: text || emptyText, truncated: this.incomplete || this.outputFull };
  }

  private add(block: string): void {
    if (this.outputFull || block.length === 0) return;
    const separator = this.parts.length > 0 ? "\n\n" : "";
    const markerBytes = Buffer.byteLength(`\n\n${TRUNCATION_MARKER}`, "utf8");
    const available = MAX_DIFF_BYTES - markerBytes - this.outputBytes;
    const value = `${separator}${block}`;
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= available) {
      this.parts.push(value);
      this.outputBytes += bytes.length;
      return;
    }
    if (available > 0) {
      let prefix = bytes.subarray(0, available).toString("utf8");
      while (Buffer.byteLength(prefix, "utf8") > available) prefix = prefix.slice(0, -1);
      this.parts.push(prefix);
      this.outputBytes += Buffer.byteLength(prefix, "utf8");
    }
    this.outputFull = true;
    this.incomplete = true;
  }

  private appendMarker(): void {
    if (this.parts.at(-1)?.endsWith(TRUNCATION_MARKER)) return;
    const marker = `${this.parts.length > 0 ? "\n\n" : ""}${TRUNCATION_MARKER}`;
    this.parts.push(marker);
  }
}

export async function desktopDiff(input: {
  scope: DiffScope;
  workspace: string;
  sessionId: string;
  turnId?: string;
  client: RuntimeClient;
  signal?: AbortSignal;
  processGroups?: DetachedProcessGroupRegistry;
}): Promise<DiffResult<DiffScope>> {
  const processGroups = input.processGroups ?? new DetachedProcessGroupRegistry();
  const ownsProcessGroups = input.processGroups === undefined;
  try {
    throwIfAborted(input.signal, processGroups.signal);
    if (input.scope === "turn") return await turnDiff(input);
    return await workspaceDiff(input.workspace, {
      processGroups,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    if (ownsProcessGroups) await processGroups.close();
  }
}

async function turnDiff(input: {
  workspace: string;
  sessionId: string;
  turnId?: string;
  client: RuntimeClient;
  signal?: AbortSignal;
}): Promise<DiffResult<"turn">> {
  const budget = new DiffBudget();
  throwIfAborted(input.signal);
  const workspace = await canonicalWorkspace(input.workspace);
  throwIfAborted(input.signal);
  const events = await input.client.sessionEvents({
    sessionId: input.sessionId as never,
    limit: 5_000,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  throwIfAborted(input.signal);
  const sessionEvents = events.filter((event) => event.sessionId === input.sessionId);
  if (events.length >= 5_000) budget.addWarning("# turn diff incomplete: session event history reached its safety limit");
  const turnId = input.turnId ?? latestTurnId(sessionEvents);
  if (!turnId) return { scope: "turn", text: "No turn activity yet.", truncated: false };

  const toolCalls = new Map(sessionEvents.flatMap((event) => {
    if (event.type !== "tool.call_started" || event.payload.turnId !== turnId) return [];
    return [[event.payload.callId as string, { toolName: event.payload.toolName, input: event.payload.input }] as const];
  }));
  const callIds = new Set(toolCalls.keys());
  if (callIds.size === 0) {
    return { scope: "turn", text: "No file-changing tool activity in this turn.", truncated: false };
  }

  const baselines = new Map<string, FileState>();
  const snapshotCallIds = new Set<string>();
  for (const event of sessionEvents) {
    if (!budget.canContinue()) break;
    if (event.type !== "snapshot.created" || !event.payload.callId || !callIds.has(event.payload.callId)) continue;
    const requestedPaths = event.payload.paths;
    if (requestedPaths.length === 0) continue;
    try {
      const entries = await readSnapshotBaselines(workspace, event.payload.snapshotId, requestedPaths, budget);
      if (entries.size > 0) snapshotCallIds.add(event.payload.callId);
      for (const [path, baseline] of entries) {
        if (!baselines.has(path)) baselines.set(path, baseline);
      }
    } catch (error) {
      budget.addWarning(`# snapshot ${safeLabel(event.payload.snapshotId)} omitted: ${safeErrorMessage(error)}`);
    }
  }

  const callsWithoutSnapshots = [...toolCalls]
    .filter(([callId, toolCall]) => !snapshotCallIds.has(callId) && mayWriteWorkspace(toolCall))
    .length;
  if (callsWithoutSnapshots > 0) {
    budget.addWarning(`# turn diff incomplete: ${callsWithoutSnapshots} tool call(s) had no snapshot baseline`);
  }

  if (baselines.size === 0) {
    if (callsWithoutSnapshots > 0) {
      budget.addWarning("No readable file snapshot was created by this turn.");
      return budget.result("turn", "No readable file snapshot was created by this turn.");
    }
    return budget.result("turn", "No snapshot-backed file changes were recorded for this turn.");
  }

  for (const [path, baseline] of [...baselines].sort(([left], [right]) => left.localeCompare(right))) {
    if (!budget.canContinue()) break;
    try {
      const current = await readCurrentState(workspace, path, baseline.kind === "submodule", budget);
      const rendered = renderFilePatch(path, baseline, current);
      if (rendered.patch) budget.addPatch(rendered.patch);
      if (rendered.warning) budget.addWarning(rendered.warning);
    } catch (error) {
      budget.addWarning(`# ${safeLabel(path)} omitted: ${safeErrorMessage(error)}`);
    }
  }

  return budget.result("turn", "No changes remain from this turn.");
}

async function workspaceDiff(
  inputWorkspace: string,
  gitContext: GitCommandContext,
): Promise<DiffResult<"workspace">> {
  const budget = new DiffBudget();
  throwIfAborted(gitContext.signal, gitContext.processGroups.signal);
  const workspace = await canonicalWorkspace(inputWorkspace);
  throwIfAborted(gitContext.signal, gitContext.processGroups.signal);
  try {
    await resolveGitMetadata(workspace);
  } catch {
    return {
      scope: "workspace",
      text: "Workspace is not a top-level Git working tree with local metadata.",
      truncated: false,
    };
  }
  try {
    return await workspaceDiffInside(workspace, budget, gitContext);
  } catch (error) {
    if (!isBoundedGitFailure(error)) throw error;
    budget.addWarning(`# workspace diff incomplete: ${safeErrorMessage(error)}`);
    return budget.result("workspace", "Workspace diff was truncated by a safety limit.");
  }
}

async function workspaceDiffInside(
  workspace: string,
  budget: DiffBudget,
  gitContext: GitCommandContext,
): Promise<DiffResult<"workspace">> {
  let indexScan: IndexScan;
  let untrackedPaths: string[];
  try {
    const index = await runGit(
      workspace,
      ["ls-files", "--cached", "--stage", "-z"],
      gitContext,
      [0],
      undefined,
      MAX_GIT_LIST_BYTES,
      budget.remainingTimeMs(),
    );
    indexScan = parseIndexEntries(index.stdout);
    const untracked = await runGit(
      workspace,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      gitContext,
      [0],
      undefined,
      MAX_GIT_LIST_BYTES,
      budget.remainingTimeMs(),
    );
    untrackedPaths = parseNulPaths(untracked.stdout);
  } catch (error) {
    if (isNotGitRepository(error)) {
      return { scope: "workspace", text: "Workspace is not a Git repository.", truncated: false };
    }
    throw error;
  }
  const indexEntries = indexScan.entries;

  const headCheck = await runGit(
    workspace,
    ["cat-file", "-e", "HEAD^{tree}"],
    gitContext,
    [0, 1, 128],
    undefined,
    MAX_GIT_LIST_BYTES,
    budget.remainingTimeMs(),
  );
  let headEntries = new Map<string, HeadTreeEntry>();
  if (headCheck.code === 0) {
    const tree = await runGit(
      workspace,
      ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"],
      gitContext,
      [0],
      undefined,
      MAX_GIT_LIST_BYTES,
      budget.remainingTimeMs(),
    );
    headEntries = parseHeadTree(tree.stdout);
  }

  const indexObjectMetadata = await readIndexObjectMetadata(workspace, indexEntries, budget, gitContext);

  const allUntracked = [...new Set(untrackedPaths)].sort();
  const includedUntracked = allUntracked.slice(0, MAX_UNTRACKED_FILES);
  const paths = [...new Set([
    ...headEntries.keys(),
    ...indexEntries.keys(),
    ...indexScan.unmergedPaths,
    ...includedUntracked,
  ])].sort();
  const includedPaths = paths.slice(0, MAX_WORKSPACE_PATHS);
  if (paths.length > includedPaths.length) {
    budget.addWarning(`# ${paths.length - includedPaths.length} workspace path(s) omitted by the safety limit`);
  }
  if (allUntracked.length > includedUntracked.length) {
    budget.addWarning(`# ${allUntracked.length - includedUntracked.length} additional untracked file(s) omitted`);
  }

  const eligibleGitBlobs = [
    ...[...headEntries.values()].flatMap((entry) => (
      entry.type === "blob" && entry.size !== undefined && entry.size <= MAX_FILE_BYTES
        ? [{ oid: entry.oid, size: entry.size }]
        : []
    )),
    ...[...indexEntries.values()].flatMap((entry) => {
      const metadata = indexObjectMetadata.get(entry.oid);
      return metadata?.type === "blob" && metadata.size <= MAX_FILE_BYTES
        ? [{ oid: entry.oid, size: metadata.size }]
        : [];
    }),
  ];
  const rawObjects = await readGitObjects(workspace, eligibleGitBlobs, budget, gitContext);
  if (rawObjects.omitted > 0) {
    budget.addWarning(`# ${rawObjects.omitted} Git blob object(s) omitted by the content scan limit`);
  }

  for (const path of includedPaths) {
    if (!budget.canContinue()) break;
    if (indexScan.unmergedPaths.has(path)) {
      budget.addWarning(`# ${safeLabel(path)} omitted: index contains unresolved merge stages`);
      continue;
    }
    const head = headEntries.get(path);
    const index = indexEntries.get(path);
    try {
      const headBaseline = headState(head, rawObjects.objects);
      const indexBaseline = indexState(index, indexObjectMetadata, rawObjects.objects);
      const staged = renderFilePatch(path, headBaseline, indexBaseline);
      if (staged.patch) budget.addPatch(`# staged changes (HEAD -> index)\n${staged.patch}`);
      if (staged.warning) budget.addWarning(staged.warning);

      const expectsSubmodule = head?.type === "commit" || index?.mode === "160000";
      const current = await readCurrentState(workspace, path, expectsSubmodule, budget);
      const unstaged = renderFilePatch(path, indexBaseline, current);
      if (unstaged.patch) budget.addPatch(`# unstaged changes (index -> working tree)\n${unstaged.patch}`);
      if (unstaged.warning) budget.addWarning(unstaged.warning);
    } catch (error) {
      budget.addWarning(`# ${safeLabel(path)} omitted: ${safeErrorMessage(error)}`);
    }
  }

  return budget.result("workspace", "Workspace is clean.");
}

function headState(entry: HeadTreeEntry | undefined, objects: ReadonlyMap<string, Buffer>): FileState {
  if (!entry) return { kind: "missing" };
  if (entry.type === "commit") return { kind: "submodule", mode: "160000", oid: entry.oid };
  const content = objects.get(entry.oid);
  const kind = entry.mode === "120000" ? "symlink" : "file";
  if (content !== undefined) return { kind, mode: entry.mode, content, size: entry.size ?? content.length };
  return {
    kind,
    mode: entry.mode,
    size: entry.size ?? 0,
    unavailable: entry.size !== undefined && entry.size > MAX_FILE_BYTES
      ? `HEAD content exceeds ${MAX_FILE_BYTES} bytes`
      : "HEAD content was outside the bounded object scan",
  };
}

async function readIndexObjectMetadata(
  workspace: string,
  entries: ReadonlyMap<string, IndexEntry>,
  budget: DiffBudget,
  gitContext: GitCommandContext,
): Promise<Map<string, GitObjectMetadata>> {
  const objectIds = [...new Set([...entries.values()].map((entry) => entry.oid))];
  if (objectIds.length === 0) return new Map();
  const input = Buffer.from(`${objectIds.join("\n")}\n`, "ascii");
  const result = await runGit(
    workspace,
    ["cat-file", "--batch-check"],
    gitContext,
    [0],
    input,
    objectIds.length * 160 + 1024,
    budget.remainingTimeMs(),
  );
  return parseBatchObjectMetadata(result.stdout, objectIds);
}

function parseBatchObjectMetadata(
  output: Buffer,
  objectIds: readonly string[],
): Map<string, GitObjectMetadata> {
  const text = decodeUtf8Strict(output, "Git object metadata batch");
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new Error("Git object metadata batch was unterminated");
  lines.pop();
  if (lines.length !== objectIds.length) throw new Error("Git object metadata batch had an unexpected length");
  const metadata = new Map<string, GitObjectMetadata>();
  for (let index = 0; index < objectIds.length; index += 1) {
    const requestedOid = objectIds[index];
    const line = lines[index];
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit) ([0-9]+)$/u.exec(line ?? "");
    if (!requestedOid || !match || match[1] !== requestedOid) {
      throw new Error("Git returned unexpected index object metadata");
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid index object size");
    metadata.set(requestedOid, { type: match[2] as "blob" | "commit", size });
  }
  return metadata;
}

function indexState(
  entry: IndexEntry | undefined,
  metadataByOid: ReadonlyMap<string, GitObjectMetadata>,
  objects: ReadonlyMap<string, Buffer>,
): FileState {
  if (!entry) return { kind: "missing" };
  const metadata = metadataByOid.get(entry.oid);
  if (!metadata) {
    return indexUnavailableState(entry, 0, "index object metadata was unavailable");
  }
  if (entry.mode === "160000") {
    return metadata.type === "commit"
      ? { kind: "submodule", mode: "160000", oid: entry.oid }
      : { kind: "submodule", mode: "160000", unavailable: "index submodule entry does not reference a commit" };
  }
  if (metadata.type !== "blob") {
    return indexUnavailableState(entry, metadata.size, "index file entry does not reference a blob");
  }
  const content = objects.get(entry.oid);
  const kind = entry.mode === "120000" ? "symlink" : "file";
  if (content !== undefined) return { kind, mode: entry.mode, content, size: metadata.size };
  return {
    kind,
    mode: entry.mode,
    size: metadata.size,
    unavailable: metadata.size > MAX_FILE_BYTES
      ? `index content exceeds ${MAX_FILE_BYTES} bytes`
      : "index content was outside the bounded object scan",
  };
}

function indexUnavailableState(entry: IndexEntry, size: number, unavailable: string): FileState {
  if (entry.mode === "160000") return { kind: "submodule", mode: "160000", unavailable };
  return {
    kind: entry.mode === "120000" ? "symlink" : "file",
    mode: entry.mode,
    size,
    unavailable,
  };
}

async function readGitObjects(
  workspace: string,
  entries: readonly { oid: string; size: number }[],
  budget: DiffBudget,
  gitContext: GitCommandContext,
): Promise<{ objects: Map<string, Buffer>; omitted: number }> {
  const selected = new Map<string, number>();
  let totalBytes = 0;
  let omitted = 0;
  for (const entry of entries) {
    if (selected.has(entry.oid)) continue;
    const size = entry.size ?? 0;
    if (totalBytes + size > MAX_GIT_OBJECT_BYTES || !budget.reserveRead(size)) {
      omitted += 1;
      continue;
    }
    selected.set(entry.oid, size);
    totalBytes += size;
  }
  if (selected.size === 0) return { objects: new Map(), omitted };

  const objectIds = [...selected.keys()];
  const input = Buffer.from(`${objectIds.join("\n")}\n`, "ascii");
  const result = await runGit(
    workspace,
    ["cat-file", "--batch"],
    gitContext,
    [0],
    input,
    totalBytes + objectIds.length * 160 + 1024,
    budget.remainingTimeMs(),
  );
  return { objects: parseBatchObjects(result.stdout, objectIds, selected), omitted };
}

function parseBatchObjects(
  output: Buffer,
  objectIds: readonly string[],
  expectedSizes: ReadonlyMap<string, number>,
): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let offset = 0;
  for (const requestedOid of objectIds) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Git object batch ended before its header");
    const header = output.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== requestedOid) throw new Error("Git returned an unexpected object batch header");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size !== expectedSizes.get(requestedOid)) {
      throw new Error("Git returned an unexpected object size");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) throw new Error("Git object batch was truncated");
    objects.set(requestedOid, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("Git object batch contained trailing data");
  return objects;
}

async function readSnapshotBaselines(
  workspace: string,
  snapshotId: string,
  requestedPaths: readonly string[],
  budget: DiffBudget,
): Promise<Map<string, FileState>> {
  if (!/^snapshot_[A-Za-z0-9_-]{1,120}$/u.test(snapshotId)) throw new UnsafePathError("invalid snapshot id");
  const root = resolve(workspace, ".chili", "snapshots");
  const snapshotDir = resolve(root, snapshotId);
  assertContained(workspace, root, "snapshot root");
  assertContained(root, snapshotDir, "snapshot directory");
  await assertDirectoryChain(workspace, relative(workspace, snapshotDir));

  const manifestPath = join(snapshotDir, "manifest.json");
  const manifestText = (await readRegularFileStrict(manifestPath, snapshotDir, MAX_MANIFEST_BYTES, budget)).toString("utf8");
  const manifest = parseSnapshotManifest(JSON.parse(manifestText) as unknown);
  if (manifest.id !== snapshotId) throw new UnsafePathError("snapshot manifest id mismatch");
  if (resolve(manifest.cwd) !== workspace || await realpath(manifest.cwd) !== workspace) {
    throw new UnsafePathError("snapshot manifest cwd mismatch");
  }

  const byPath = new Map<string, SnapshotManifestEntry>();
  for (const entry of manifest.entries) {
    const safeEntryPath = requireSafeRelativePath(workspace, entry.relativePath);
    if (byPath.has(safeEntryPath)) throw new UnsafePathError("snapshot manifest contains duplicate paths");
    byPath.set(safeEntryPath, entry);
  }
  const result = new Map<string, FileState>();
  for (const path of requestedPaths) {
    const safePath = requireSafeRelativePath(workspace, path);
    await assertTurnPathHasNoSymlink(workspace, safePath);
    const entry = byPath.get(safePath);
    if (!entry) throw new UnsafePathError(`snapshot manifest is missing ${safeLabel(safePath)}`);
    if (entry.kind === "missing") {
      result.set(safePath, { kind: "missing" });
      continue;
    }
    if (!entry.backupName || !/^[0-9]+\.blob$/u.test(entry.backupName)) {
      throw new UnsafePathError(`snapshot backup name is invalid for ${safeLabel(safePath)}`);
    }
    const backupPath = resolve(snapshotDir, entry.backupName);
    assertContained(snapshotDir, backupPath, "snapshot backup");
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new UnsafePathError("snapshot backup is not a regular file");
    if (info.size > MAX_FILE_BYTES) {
      result.set(safePath, {
        kind: "file",
        mode: entry.mode?.toString(8) ?? "",
        size: info.size,
        unavailable: `snapshot backup exceeds ${MAX_FILE_BYTES} bytes`,
      });
      continue;
    }
    const content = await readRegularFileStrict(backupPath, snapshotDir, MAX_FILE_BYTES, budget);
    result.set(safePath, { kind: "file", mode: entry.mode?.toString(8) ?? "", content, size: content.length });
  }
  return result;
}

function parseSnapshotManifest(value: unknown): SnapshotManifest {
  if (
    !isRecord(value)
    || value.version !== 2
    || typeof value.id !== "string"
    || typeof value.cwd !== "string"
    || !Array.isArray(value.entries)
  ) {
    throw new TypeError("invalid snapshot manifest");
  }
  if (value.entries.length > MAX_WORKSPACE_PATHS) throw new TypeError("snapshot manifest has too many entries");
  const entries = value.entries.map((candidate): SnapshotManifestEntry => {
    if (
      !isRecord(candidate)
      || typeof candidate.relativePath !== "string"
      || (candidate.kind !== "regular" && candidate.kind !== "missing")
      || typeof candidate.existed !== "boolean"
    ) {
      throw new TypeError("invalid snapshot manifest entry");
    }
    if (candidate.backupName !== undefined && typeof candidate.backupName !== "string") {
      throw new TypeError("invalid snapshot backup name");
    }
    if (
      candidate.kind === "regular"
      && (
        candidate.existed !== true
        || candidate.backupName === undefined
        || (candidate.mode !== 0o100644 && candidate.mode !== 0o100755)
      )
    ) {
      throw new TypeError("regular snapshot entry is inconsistent");
    }
    if (
      candidate.kind === "missing"
      && (candidate.existed !== false || candidate.backupName !== undefined || candidate.mode !== undefined)
    ) {
      throw new TypeError("missing snapshot entry is inconsistent");
    }
    return {
      relativePath: candidate.relativePath,
      kind: candidate.kind,
      existed: candidate.existed,
      ...(candidate.mode !== undefined ? { mode: candidate.mode as 0o100644 | 0o100755 } : {}),
      ...(candidate.backupName !== undefined ? { backupName: candidate.backupName } : {}),
    };
  });
  return { version: 2, id: value.id, cwd: value.cwd, entries };
}

async function readCurrentState(
  workspace: string,
  path: string,
  expectsSubmodule: boolean,
  budget: DiffBudget,
): Promise<FileState> {
  const safePath = requireSafeRelativePath(workspace, path);
  const absolute = resolve(workspace, safePath);
  const ancestorsExist = await assertSafeCurrentAncestors(workspace, safePath);
  if (!ancestorsExist) return { kind: "missing" };
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info) return { kind: "missing" };
  if (info.isSymbolicLink()) {
    const target = await readlink(absolute, "buffer");
    const after = await lstat(absolute);
    if (!after.isSymbolicLink()) throw new UnsafePathError("file changed while reading its symlink target");
    return { kind: "symlink", mode: "120000", content: Buffer.from(target), size: target.length };
  }
  if (info.isDirectory()) {
    if (expectsSubmodule) {
      const oid = await readSubmoduleHead(workspace, absolute, budget);
      return oid
        ? { kind: "submodule", mode: "160000", oid }
        : { kind: "submodule", mode: "160000", unavailable: "submodule HEAD could not be read safely" };
    }
    return { kind: "other", mode: "040000", description: "directory" };
  }
  if (!info.isFile()) return { kind: "other", mode: fileMode(info.mode), description: "special file" };
  const mode = fileMode(info.mode);
  if (info.size > MAX_FILE_BYTES) {
    return { kind: "file", mode, size: info.size, unavailable: `working file exceeds ${MAX_FILE_BYTES} bytes` };
  }
  const content = await readRegularFileStrict(absolute, workspace, MAX_FILE_BYTES, budget);
  return { kind: "file", mode, content, size: content.length };
}

async function readSubmoduleHead(workspace: string, submodule: string, budget: DiffBudget): Promise<string | undefined> {
  const dotGit = join(submodule, ".git");
  const info = await lstat(dotGit).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info || info.isSymbolicLink()) return undefined;
  let gitDir: string;
  if (info.isDirectory()) {
    gitDir = await realpath(dotGit);
  } else if (info.isFile()) {
    const descriptor = (await readRegularFileStrict(dotGit, submodule, 4 * 1024, budget)).toString("utf8").trim();
    const match = /^gitdir: (.+)$/u.exec(descriptor);
    const matchedGitDir = match?.[1];
    if (!matchedGitDir) return undefined;
    gitDir = await realpath(resolve(submodule, matchedGitDir));
  } else {
    return undefined;
  }
  assertContained(workspace, gitDir, "submodule git directory");
  const head = (await readRegularFileStrict(join(gitDir, "HEAD"), gitDir, 4 * 1024, budget)).toString("ascii").trim();
  if (isObjectId(head)) return head;
  const symbolic = /^ref: (refs\/[A-Za-z0-9._/-]+)$/u.exec(head);
  const refName = symbolic?.[1];
  if (!refName || refName.split("/").includes("..")) return undefined;
  const loosePath = resolve(gitDir, refName);
  assertContained(gitDir, loosePath, "submodule reference");
  const loose = await readRegularFileStrict(loosePath, gitDir, 4 * 1024, budget).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (loose) {
    const oid = loose.toString("ascii").trim();
    if (isObjectId(oid)) return oid;
  }
  const packed = await readRegularFileStrict(join(gitDir, "packed-refs"), gitDir, MAX_PACKED_REFS_BYTES, budget).catch(
    (error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    },
  );
  if (!packed) return undefined;
  for (const line of packed.toString("ascii").split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0 || line.slice(separator + 1) !== refName) continue;
    const oid = line.slice(0, separator);
    return isObjectId(oid) ? oid : undefined;
  }
  return undefined;
}

function renderFilePatch(path: string, before: FileState, after: FileState): { patch?: string; warning?: string } {
  const bothSubmodules = before.kind === "submodule" && after.kind === "submodule";
  if (statesEqual(before, after) && !bothSubmodules) return {};
  const unavailable = stateUnavailable(before) ?? stateUnavailable(after);
  if (unavailable) {
    const beforeMode = stateMode(before);
    const afterMode = stateMode(after);
    const definitelyChanged = before.kind !== after.kind
      || (beforeMode !== undefined && afterMode !== undefined && beforeMode !== afterMode)
      || stateSize(before) !== stateSize(after);
    const warning = `# ${safeLabel(path)} ${definitelyChanged ? "changed but its patch was" : "comparison"} omitted: ${unavailable}`;
    return definitelyChanged ? { patch: renderMetadataPatch(path, before, after, unavailable), warning } : { warning };
  }
  if (before.kind === "submodule" || after.kind === "submodule") {
    const otherKind = before.kind === "submodule" ? after.kind : before.kind;
    if (otherKind !== "submodule" && otherKind !== "missing") {
      return {
        patch: renderMetadataPatch(path, before, after, "file type changed to or from a submodule"),
        warning: `# ${safeLabel(path)} submodule content comparison omitted`,
      };
    }
    const patch = statesEqual(before, after) ? undefined : renderSubmodulePatch(path, before, after);
    if (after.kind === "submodule") {
      return {
        ...(patch ? { patch } : {}),
        warning: `# ${safeLabel(path)} nested submodule working-tree changes were not inspected`,
      };
    }
    return patch ? { patch } : {};
  }
  if (before.kind === "other" || after.kind === "other") {
    return { patch: renderMetadataPatch(path, before, after, "file type changed") };
  }
  const beforeContent = before.kind === "missing" ? undefined : before.content;
  const afterContent = after.kind === "missing" ? undefined : after.content;
  if (beforeContent === undefined && before.kind !== "missing") return { warning: `# ${safeLabel(path)} comparison omitted` };
  if (afterContent === undefined && after.kind !== "missing") return { warning: `# ${safeLabel(path)} comparison omitted` };

  const lines = [renderDiffHeader(path)];
  const modeLines = renderModeLines(before, after);
  if (modeLines.length > 0) lines.push(...modeLines);
  if (buffersEqual(beforeContent, afterContent)) return { patch: lines.join("\n") };
  if (isBinary(beforeContent) || isBinary(afterContent)) {
    lines.push(`Binary files ${before.kind === "missing" ? "/dev/null" : quotePatchPath(`a/${path}`)} and ${after.kind === "missing" ? "/dev/null" : quotePatchPath(`b/${path}`)} differ`);
    return { patch: lines.join("\n") };
  }
  const oldText = decodeText(beforeContent);
  const newText = decodeText(afterContent);
  if (oldText === undefined || newText === undefined) {
    lines.push(`Binary files ${before.kind === "missing" ? "/dev/null" : quotePatchPath(`a/${path}`)} and ${after.kind === "missing" ? "/dev/null" : quotePatchPath(`b/${path}`)} differ`);
    return { patch: lines.join("\n") };
  }
  lines.push(before.kind === "missing" ? "--- /dev/null" : `--- ${quotePatchPath(`a/${path}`)}`);
  lines.push(after.kind === "missing" ? "+++ /dev/null" : `+++ ${quotePatchPath(`b/${path}`)}`);
  lines.push(renderUnifiedReplacement(oldText, newText));
  return { patch: lines.join("\n") };
}

function renderSubmodulePatch(path: string, before: FileState, after: FileState): string {
  const oldOid = before.kind === "submodule" ? before.oid : undefined;
  const newOid = after.kind === "submodule" ? after.oid : undefined;
  const lines = [renderDiffHeader(path), ...renderModeLines(before, after)];
  lines.push(before.kind === "missing" ? "--- /dev/null" : `--- ${quotePatchPath(`a/${path}`)}`);
  lines.push(after.kind === "missing" ? "+++ /dev/null" : `+++ ${quotePatchPath(`b/${path}`)}`);
  if (oldOid && newOid) lines.push("@@ -1 +1 @@");
  else lines.push(oldOid ? "@@ -1 +0,0 @@" : "@@ -0,0 +1 @@");
  if (oldOid) lines.push(`-Subproject commit ${oldOid}`);
  if (newOid) lines.push(`+Subproject commit ${newOid}`);
  if (!oldOid && !newOid) lines.push("+# submodule commit unavailable");
  return lines.join("\n");
}

function renderMetadataPatch(path: string, before: FileState, after: FileState, detail: string): string {
  return [renderDiffHeader(path), ...renderModeLines(before, after), `# ${detail}`].join("\n");
}

function renderDiffHeader(path: string): string {
  return `diff --git ${quotePatchPath(`a/${path}`)} ${quotePatchPath(`b/${path}`)}`;
}

function renderModeLines(before: FileState, after: FileState): string[] {
  const beforeMode = stateMode(before);
  const afterMode = stateMode(after);
  if (before.kind === "missing" && afterMode) return [`new file mode ${afterMode}`];
  if (after.kind === "missing" && beforeMode) return [`deleted file mode ${beforeMode}`];
  if (beforeMode && afterMode && beforeMode !== afterMode) return [`old mode ${beforeMode}`, `new mode ${afterMode}`];
  return [];
}

function renderUnifiedReplacement(oldText: string, newText: string): string {
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  const oldRange = oldLines.lines.length === 0 ? "-0,0" : `-1,${oldLines.lines.length}`;
  const newRange = newLines.lines.length === 0 ? "+0,0" : `+1,${newLines.lines.length}`;
  const output = [`@@ ${oldRange} ${newRange} @@`];
  for (const line of oldLines.lines) output.push(`-${line}`);
  if (!oldLines.trailingNewline && oldLines.lines.length > 0) output.push("\\ No newline at end of file");
  for (const line of newLines.lines) output.push(`+${line}`);
  if (!newLines.trailingNewline && newLines.lines.length > 0) output.push("\\ No newline at end of file");
  return output.join("\n");
}

function textLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function statesEqual(left: FileState, right: FileState): boolean {
  if (left.kind !== right.kind) return false;
  const leftMode = stateMode(left);
  const rightMode = stateMode(right);
  if (leftMode !== undefined && rightMode !== undefined && leftMode !== rightMode) return false;
  if (left.kind === "missing" && right.kind === "missing") return true;
  if (left.kind === "submodule" && right.kind === "submodule") return left.oid !== undefined && left.oid === right.oid;
  if (left.kind === "other" && right.kind === "other") return left.description === right.description;
  if ((left.kind === "file" || left.kind === "symlink") && (right.kind === "file" || right.kind === "symlink")) {
    if (left.content === undefined || right.content === undefined) return false;
    return left.content.equals(right.content);
  }
  return false;
}

function stateMode(state: FileState): string | undefined {
  return state.kind === "missing" || state.mode.length === 0 ? undefined : state.mode;
}

function stateSize(state: FileState): number | undefined {
  return state.kind === "file" || state.kind === "symlink" ? state.size : undefined;
}

function stateUnavailable(state: FileState): string | undefined {
  return state.kind === "file" || state.kind === "symlink" || state.kind === "submodule"
    ? state.unavailable
    : undefined;
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function isBinary(content: Buffer | undefined): boolean {
  if (!content) return false;
  return content.subarray(0, Math.min(content.length, 8_000)).includes(0);
}

function decodeText(content: Buffer | undefined): string | undefined {
  if (!content) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function parseHeadTree(output: Buffer): Map<string, HeadTreeEntry> {
  const entries = new Map<string, HeadTreeEntry>();
  for (const recordBuffer of splitNulRecords(output)) {
    const record = decodeUtf8Strict(recordBuffer, "Git tree entry");
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|[0-9]+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Git returned an invalid tree entry");
    const [, mode, type, oid, sizeText, path] = match;
    if (!mode || !type || !oid || !path) throw new Error("Git returned an incomplete tree entry");
    const safePath = requireSafeRelativePathWithoutRoot(path);
    const entry: HeadTreeEntry = { path: safePath, mode, type: type as "blob" | "commit", oid };
    if (sizeText !== "-") {
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid blob size");
      entry.size = size;
    }
    entries.set(safePath, entry);
  }
  return entries;
}

function parseIndexEntries(output: Buffer): IndexScan {
  const entries = new Map<string, IndexEntry>();
  const unmergedPaths = new Set<string>();
  for (const recordBuffer of splitNulRecords(output)) {
    const record = decodeUtf8Strict(recordBuffer, "Git index entry");
    const match = /^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Git returned an invalid index entry");
    const [, mode, oid, stage, path] = match;
    if (!mode || !oid || !stage || !path) throw new Error("Git returned an incomplete index entry");
    const safePath = requireSafeRelativePathWithoutRoot(path);
    if (stage !== "0") {
      unmergedPaths.add(safePath);
      entries.delete(safePath);
      continue;
    }
    if (unmergedPaths.has(safePath)) continue;
    if (entries.has(safePath)) throw new Error("Git returned duplicate stage-zero index entries");
    entries.set(safePath, { path: safePath, mode, oid });
  }
  return { entries, unmergedPaths };
}

function parseNulPaths(output: Buffer): string[] {
  return splitNulRecords(output)
    .map((record) => decodeUtf8Strict(record, "Git path"))
    .map(requireSafeRelativePathWithoutRoot);
}

function splitNulRecords(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let offset = 0;
  while (offset < output.length) {
    const separator = output.indexOf(0, offset);
    if (separator < 0) throw new Error("Git returned an unterminated path record");
    if (separator === offset) throw new Error("Git returned an empty path record");
    records.push(output.subarray(offset, separator));
    offset = separator + 1;
  }
  return records;
}

function decodeUtf8Strict(value: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new UnsafePathError(`${label} is not valid UTF-8`);
  }
}

function latestTurnId(events: readonly ChiliEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || (event.type !== "turn.started" && event.type !== "turn.completed")) continue;
    return event.payload.turnId;
  }
  return undefined;
}

function mayWriteWorkspace(toolCall: { toolName: string; input: unknown }): boolean {
  if (EXPLICIT_READ_ONLY_TOOLS.has(toolCall.toolName)) return false;
  if (toolCall.toolName !== "git_branch") return true;
  if (!isRecord(toolCall.input) || toolCall.input.action === undefined) return false;
  return toolCall.input.action !== "current" && toolCall.input.action !== "list";
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const absolute = resolve(workspace);
  const canonical = await realpath(absolute);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafePathError("workspace is not a real directory");
  return canonical;
}

async function resolveGitMetadata(workspace: string): Promise<GitMetadata> {
  const dotGit = join(workspace, ".git");
  const dotGitInfo = await lstat(dotGit);
  if (dotGitInfo.isSymbolicLink()) throw new UnsafePathError("Git metadata cannot be a symlink");
  if (dotGitInfo.isDirectory()) {
    const gitDirectory = await canonicalDirectoryWithoutSymlinks(dotGit, "Git metadata");
    await validateCommonGitMetadata(gitDirectory);
    await validateWorktreeGitMetadata(gitDirectory, gitDirectory);
    return { gitDirectory, commonDirectory: gitDirectory };
  }
  if (!dotGitInfo.isFile()) throw new UnsafePathError("Git metadata is neither a directory nor a gitfile");

  const gitfile = decodeUtf8Strict(
    await readRegularFileStrict(dotGit, workspace, 16 * 1024),
    "Git metadata file",
  );
  const gitdirValue = parseGitdirFile(gitfile);
  const gitDirectory = await canonicalDirectoryWithoutSymlinks(
    resolve(dirname(dotGit), gitdirValue),
    "linked worktree Git directory",
  );
  const commondirText = decodeUtf8Strict(
    await readRegularFileStrict(join(gitDirectory, "commondir"), gitDirectory, 16 * 1024),
    "Git commondir file",
  );
  const commonDirectory = await canonicalDirectoryWithoutSymlinks(
    resolve(gitDirectory, parseSinglePathFile(commondirText, "Git commondir")),
    "Git common directory",
  );
  const worktreesDirectory = dirname(gitDirectory);
  if (
    basename(worktreesDirectory) !== "worktrees"
    || dirname(worktreesDirectory) !== commonDirectory
    || basename(commonDirectory) !== ".git"
  ) {
    throw new UnsafePathError("linked worktree metadata is outside a standard common Git directory");
  }

  const reciprocalText = decodeUtf8Strict(
    await readRegularFileStrict(join(gitDirectory, "gitdir"), gitDirectory, 16 * 1024),
    "linked worktree registration",
  );
  const reciprocal = resolve(gitDirectory, parseSinglePathFile(reciprocalText, "linked worktree registration"));
  if (reciprocal !== dotGit || await realpath(reciprocal) !== dotGit) {
    throw new UnsafePathError("linked worktree registration does not point back to the selected workspace");
  }

  await validateCommonGitMetadata(commonDirectory);
  await validateWorktreeGitMetadata(gitDirectory, commonDirectory);
  return { gitDirectory, commonDirectory };
}

async function validateCommonGitMetadata(commonDirectory: string): Promise<void> {
  const objectsDirectory = await requiredLocalDirectory(join(commonDirectory, "objects"), commonDirectory, "Git objects");
  await optionalLocalDirectory(join(objectsDirectory, "info"), objectsDirectory, "Git object info");
  await optionalLocalDirectory(join(objectsDirectory, "pack"), objectsDirectory, "Git object pack directory");
  await optionalLocalDirectory(join(commonDirectory, "refs"), commonDirectory, "Git refs");
  await optionalLocalDirectory(join(commonDirectory, "hooks"), commonDirectory, "Git hooks");
  await optionalLocalDirectory(join(commonDirectory, "info"), commonDirectory, "Git info");
  for (const path of [
    join(commonDirectory, "commondir"),
    join(objectsDirectory, "info", "alternates"),
    join(objectsDirectory, "info", "http-alternates"),
  ]) {
    if (await pathExists(path)) throw new UnsafePathError("Git object redirection is not supported by desktop diff");
  }
  await optionalLocalRegularFile(join(commonDirectory, "config"), commonDirectory, "Git config");
  await optionalLocalRegularFile(join(commonDirectory, "packed-refs"), commonDirectory, "Git packed refs");
  await optionalLocalRegularFile(join(commonDirectory, "info", "exclude"), commonDirectory, "Git excludes");
}

async function validateWorktreeGitMetadata(gitDirectory: string, commonDirectory: string): Promise<void> {
  const headPath = join(gitDirectory, "HEAD");
  const head = decodeUtf8Strict(await readRegularFileStrict(headPath, gitDirectory, 64 * 1024), "Git HEAD").trimEnd();
  if (!isObjectId(head)) {
    const match = /^ref: (refs\/[A-Za-z0-9._/-]+)$/u.exec(head);
    const refName = match?.[1];
    if (!refName || refName.split("/").some((component) => component === "." || component === "..")) {
      throw new UnsafePathError("Git HEAD contains an unsafe reference");
    }
    await optionalLocalRegularFile(resolve(commonDirectory, refName), commonDirectory, "Git HEAD reference");
  }
  await optionalLocalRegularFile(join(gitDirectory, "index"), gitDirectory, "Git index");
  await optionalLocalRegularFile(join(gitDirectory, "config.worktree"), gitDirectory, "Git worktree config");
}

async function canonicalDirectoryWithoutSymlinks(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new UnsafePathError(`${label} contains a symlink`);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafePathError(`${label} is not a real directory`);
  return canonical;
}

async function requiredLocalDirectory(path: string, root: string, label: string): Promise<string> {
  assertContained(root, path, label);
  return canonicalDirectoryWithoutSymlinks(path, label);
}

async function optionalLocalDirectory(path: string, root: string, label: string): Promise<void> {
  if (!await pathExists(path)) return;
  await requiredLocalDirectory(path, root, label);
}

async function optionalLocalRegularFile(path: string, root: string, label: string): Promise<void> {
  assertContained(root, path, label);
  const info = await lstat(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new UnsafePathError(`${label} is not a local regular file`);
  }
}

function parseGitdirFile(text: string): string {
  const match = /^gitdir: ([^\r\n]+)\n?$/u.exec(text);
  const value = match?.[1];
  if (!value || value.trim() !== value) throw new UnsafePathError("invalid Git metadata file");
  return value;
}

function parseSinglePathFile(text: string, label: string): string {
  const match = /^([^\r\n]+)\n?$/u.exec(text);
  const value = match?.[1];
  if (!value || value.trim() !== value) throw new UnsafePathError(`invalid ${label}`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => {
    if (isNotFound(error)) return false;
    throw error;
  });
}

function requireSafeRelativePath(workspace: string, path: string): string {
  const safe = requireSafeRelativePathWithoutRoot(path);
  assertContained(workspace, resolve(workspace, safe), "workspace path");
  return safe;
}

function requireSafeRelativePathWithoutRoot(path: string): string {
  const components = path.split(/[\\/]/u);
  if (
    path.length === 0
    || isAbsolute(path)
    || path.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || components.some((component) => component.length === 0 || component === "." || component === "..")
  ) {
    throw new UnsafePathError("unsafe relative path");
  }
  return path;
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) return;
  throw new UnsafePathError(`${label} escaped its root`);
}

async function assertDirectoryChain(root: string, relativeDirectory: string): Promise<void> {
  let cursor = root;
  for (const component of relativeDirectory.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafePathError("snapshot path contains a symlink");
  }
  if (await realpath(cursor) !== cursor) throw new UnsafePathError("snapshot directory realpath mismatch");
}

async function assertSafeCurrentAncestors(workspace: string, path: string): Promise<boolean> {
  const components = path.split(sep);
  let cursor = workspace;
  for (const component of components.slice(0, -1)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!info) return false;
    if (info.isSymbolicLink()) throw new UnsafePathError("workspace path traverses a symlink");
    if (!info.isDirectory()) return false;
  }
  return true;
}

async function assertTurnPathHasNoSymlink(workspace: string, path: string): Promise<void> {
  if (!await assertSafeCurrentAncestors(workspace, path)) return;
  const absolute = resolve(workspace, path);
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink()) throw new UnsafePathError("turn snapshot path is a symlink");
  assertContained(workspace, await realpath(absolute), "turn snapshot path realpath");
}

async function readRegularFileStrict(
  path: string,
  root: string,
  limit: number,
  budget?: DiffBudget,
): Promise<Buffer> {
  assertContained(root, path, "file");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new UnsafePathError("expected a regular file");
  if (before.size > limit) throw new UnsafePathError(`file exceeds ${limit} bytes`);
  if (budget && !budget.reserveRead(before.size)) throw new UnsafePathError("content scan budget exhausted");
  const canonical = await realpath(path);
  assertContained(root, canonical, "file realpath");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new UnsafePathError("file changed while opening");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new UnsafePathError(`file exceeds ${limit} bytes`);
    const openedAfterRead = await handle.stat();
    if (
      openedAfterRead.size !== opened.size
      || openedAfterRead.mtimeMs !== opened.mtimeMs
      || openedAfterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new UnsafePathError("file changed while reading");
    }
    const after = await lstat(path);
    const afterCanonical = await realpath(path);
    assertContained(root, afterCanonical, "file realpath");
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new UnsafePathError("file changed while reading");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function fileMode(mode: number): string {
  return (mode & 0o111) !== 0 ? "100755" : "100644";
}

function quotePatchPath(path: string): string {
  return /^[A-Za-z0-9._/@+\-]+$/u.test(path) ? path : JSON.stringify(path);
}

function safeLabel(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/gu, " ").slice(0, 500);
  return String(error).replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isNotGitRepository(error: unknown): boolean {
  return error instanceof GitCommandError && error.stderr.includes("not a git repository");
}

function isBoundedGitFailure(error: unknown): boolean {
  return error instanceof GitCommandError
    && (error.message.includes("timed out") || error.message.includes("exceeded its output limit"));
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

let gitExecutablePromise: Promise<string> | undefined;

async function systemGitExecutable(): Promise<string> {
  gitExecutablePromise ??= findSystemGitExecutable();
  return gitExecutablePromise;
}

async function findSystemGitExecutable(): Promise<string> {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
    : ["/usr/bin/git"];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next absolute, system-owned location.
    }
  }
  throw new Error("A trusted system Git executable was not found");
}

async function runGit(
  cwd: string,
  args: readonly string[],
  context: GitCommandContext,
  acceptedExitCodes: readonly number[] = [0],
  input?: Buffer,
  maxOutputBytes = MAX_GIT_LIST_BYTES,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  throwIfAborted(context.signal, context.processGroups.signal);
  const metadata = await resolveGitMetadata(cwd);
  throwIfAborted(context.signal, context.processGroups.signal);
  const executable = await systemGitExecutable();
  throwIfAborted(context.signal, context.processGroups.signal);
  const commandArgs = [
    "--no-pager",
    "--no-replace-objects",
    `--git-dir=${metadata.gitDirectory}`,
    `--work-tree=${cwd}`,
    "-c",
    "core.fsmonitor=false",
    ...args,
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      env: gitEnvironment(),
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const leaderPid = child.pid;
    if (!leaderPid) {
      child.once("error", () => undefined);
      reject(new Error("Git process did not receive a PID"));
      return;
    }
    let releaseProcessGroup: () => void;
    try {
      // This registration must remain the first operation after spawn. It
      // closes the only orphan window before listeners, timers, or promises
      // can expose the child to another owner.
      releaseProcessGroup = context.processGroups.register(leaderPid);
    } catch (error) {
      child.once("error", () => undefined);
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let aborted: Error | undefined;
    let spawnError: Error | undefined;
    let containment: Promise<void> | undefined;
    let settled = false;
    const abortSignals = [...new Set([
      context.signal,
      context.processGroups.signal,
    ].filter((signal): signal is AbortSignal => signal !== undefined))];
    const startContainment = (): Promise<void> => {
      containment ??= context.processGroups.contain(leaderPid);
      return containment;
    };
    const onAbort = (): void => {
      aborted ??= abortError(...abortSignals);
      void startContainment().catch(() => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void startContainment().catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();
    for (const signal of abortSignals) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        outputExceeded = true;
        void startContainment().catch(() => undefined);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 32 * 1024) return;
      const remaining = 32 * 1024 - stderrBytes;
      const included = chunk.subarray(0, remaining);
      stderr.push(included);
      stderrBytes += included.length;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of abortSignals) signal.removeEventListener("abort", onAbort);
      void (async () => {
        try {
          if (containment) await containment;
          releaseProcessGroup();
          const errorText = Buffer.concat(stderr).toString("utf8");
          if (spawnError) throw spawnError;
          if (aborted) throw aborted;
          if (timedOut) {
            throw new GitCommandError(`Git ${args[0] ?? "command"} timed out`, code, errorText);
          }
          if (outputExceeded) {
            throw new GitCommandError(`Git ${args[0] ?? "command"} exceeded its output limit`, code, errorText);
          }
          if (!acceptedExitCodes.includes(code ?? -1)) {
            throw new GitCommandError(
              errorText.trim() || `Git ${args[0] ?? "command"} failed with exit code ${code ?? "unknown"}`,
              code,
              errorText,
            );
          }
          resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: errorText });
        } catch (error) {
          releaseProcessGroup();
          reject(error);
        }
      })();
    });
    if (input && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>): void {
  const abortedSignals = signals.filter((signal): signal is AbortSignal => signal?.aborted === true);
  if (abortedSignals.length > 0) throw abortError(...abortedSignals);
}

function abortError(...signals: AbortSignal[]): Error {
  const reason = signals.find((signal) => signal.aborted)?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Git operation was aborted");
  error.name = "AbortError";
  return error;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    HOME: process.platform === "win32" ? "C:\\Windows\\Temp" : "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin",
    TMPDIR: process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (process.platform === "win32") {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  }
  return env;
}
