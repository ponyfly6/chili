import { fileURLToPath } from "node:url";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import type { SessionId, TurnId } from "@chili/protocol";
import { createHash } from "node:crypto";
import { withFileOperationLocks, recordOwnedFileVersion } from "./file-operation-lock.js";
import { writeFileTextIfUnchanged } from "./file-mutation.js";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotId } from "@chili/protocol";
import { afterEach, expect, test } from "bun:test";
import { FileSystemSnapshotProvider } from "./snapshot.js";
import type { SnapshotCreateRequest } from "./types.js";

const cleanupPaths: string[] = [];
const MAX_TEST_FILE_BYTES = 16 * 1024 * 1024;

afterEach(async () => {
  await Promise.allSettled(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("creates a version 3 manifest and reverts regular and missing files with normalized modes", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-normal-");
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "regular.txt"), "before\n");
  await writeFile(join(workspace, "src", "executable.sh"), "#!/bin/sh\n");
  await chmod(join(workspace, "src", "executable.sh"), 0o751);
  const provider = providerFor("snapshot_normal");

  const snapshot = await provider.create(request(workspace, ["src/regular.txt", "src/executable.sh", "src/missing.txt"]));
  expect(snapshot?.paths).toEqual(["src/executable.sh", "src/missing.txt", "src/regular.txt"]);
  const manifest = JSON.parse(await readFile(join(workspace, ".chili", "snapshots", "snapshot_normal", "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({
    version: 3,
    id: "snapshot_normal",
    cwd: await realpath(workspace),
    entries: [
      { relativePath: "src/executable.sh", kind: "regular", existed: true, backupName: "0.blob", mode: 0o100755 },
      { relativePath: "src/missing.txt", kind: "missing", existed: false },
      { relativePath: "src/regular.txt", kind: "regular", existed: true, backupName: "2.blob", mode: 0o100644 },
    ],
  });
  expect(manifest.entries[1].mode).toBeUndefined();

  await trackedWrite(join(workspace, "src", "regular.txt"), "after\n");
  await trackedWrite(join(workspace, "src", "executable.sh"), "changed\n", "session_snapshot", 0o600);
  await trackedWrite(join(workspace, "src", "missing.txt"), "created later\n");
  await expect(provider.revert(snapshot!.id, { cwd: workspace })).resolves.toMatchObject({
    restored: ["src/executable.sh", "src/regular.txt"],
    removed: ["src/missing.txt"],
  });
  expect(await readFile(join(workspace, "src", "regular.txt"), "utf8")).toBe("before\n");
  expect(await readFile(join(workspace, "src", "executable.sh"), "utf8")).toBe("#!/bin/sh\n");
  expect((await lstat(join(workspace, "src", "executable.sh"))).mode & 0o777).toBe(0o755);
  await expect(lstat(join(workspace, "src", "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("fails closed when a requested snapshot source is a symlink and never copies its secret", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-source-link-");
  const outside = await temporaryDirectory("chili-snapshot-secret-");
  const secret = "TOP_SECRET_DO_NOT_COPY_7cbb5c";
  await writeFile(join(outside, "secret.txt"), secret);
  await symlink(join(outside, "secret.txt"), join(workspace, "victim.txt"));
  const provider = providerFor("snapshot_link_source");

  await expect(provider.create(request(workspace, ["victim.txt"]))).rejects.toThrow("not a regular file");
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(secret);
  expect((await collectRegularFileContents(workspace)).join("\n")).not.toContain(secret);
  await expect(lstat(join(workspace, ".chili", "snapshots"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects a symlink in the requested source ancestor", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-source-parent-");
  const outside = await temporaryDirectory("chili-snapshot-parent-secret-");
  await writeFile(join(outside, "secret.txt"), "ancestor secret");
  await symlink(outside, join(workspace, "linked"));
  await expect(providerFor("snapshot_link_parent").create(request(workspace, ["linked/secret.txt"])))
    .rejects.toThrow("ancestor is unsafe");
});

test("rejects unsafe snapshot ids and paths before creating snapshot storage", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-invalid-input-");
  await writeFile(join(workspace, "victim.txt"), "safe\n");
  await expect(providerFor("../snapshot_escape").create(request(workspace, ["victim.txt"]))).rejects.toThrow("Invalid snapshot id");
  await expect(providerFor("snapshot_unsafe_path").create(request(workspace, ["../outside.txt"]))).rejects.toThrow("Unsafe snapshot pattern");
  await expect(lstat(join(workspace, ".chili"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("removes a partial snapshot directory when creation fails", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-partial-");
  await writeFile(join(workspace, "victim.txt"), "safe\n");
  const provider = new FileSystemSnapshotProvider({
    createId: () => "snapshot_partial",
    now: () => { throw new Error("clock failed"); },
  });
  await expect(provider.create(request(workspace, ["victim.txt"]))).rejects.toThrow("clock failed");
  await expect(lstat(join(workspace, ".chili", "snapshots", "snapshot_partial"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects oversized and aggregate-oversized sparse sources without leaving snapshot artifacts", async () => {
  const oversizedWorkspace = await temporaryDirectory("chili-snapshot-oversized-");
  await writeFile(join(oversizedWorkspace, "huge.bin"), "x");
  await truncate(join(oversizedWorkspace, "huge.bin"), MAX_TEST_FILE_BYTES + 1);
  await expect(providerFor("snapshot_oversized").create(request(oversizedWorkspace, ["huge.bin"])))
    .rejects.toThrow("exceeds");
  await expect(lstat(join(oversizedWorkspace, ".chili"))).rejects.toMatchObject({ code: "ENOENT" });

  const aggregateWorkspace = await temporaryDirectory("chili-snapshot-aggregate-");
  const aggregatePaths: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const relativePath = `sparse-${index}.bin`;
    aggregatePaths.push(relativePath);
    await writeFile(join(aggregateWorkspace, relativePath), "x");
    await truncate(join(aggregateWorkspace, relativePath), MAX_TEST_FILE_BYTES);
  }
  await expect(providerFor("snapshot_aggregate").create(request(aggregateWorkspace, aggregatePaths)))
    .rejects.toThrow("total bytes");
  await expect(lstat(join(aggregateWorkspace, ".chili"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects too many patterns or entries without opening snapshot storage", async () => {
  const patternWorkspace = await temporaryDirectory("chili-snapshot-many-patterns-");
  await expect(providerFor("snapshot_many_patterns").create(request(patternWorkspace, Array.from({ length: 2_049 }, () => "*"))))
    .rejects.toThrow("too many patterns");
  await expect(lstat(join(patternWorkspace, ".chili"))).rejects.toMatchObject({ code: "ENOENT" });

  const entryWorkspace = await temporaryDirectory("chili-snapshot-many-entries-");
  const entries = Array.from({ length: 1_025 }, (_, index) => `missing-${index}.txt`);
  await expect(providerFor("snapshot_many_entries").create(request(entryWorkspace, entries)))
    .rejects.toThrow("too many entries");
  await expect(lstat(join(entryWorkspace, ".chili"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("roundtrips a multi-megabyte file through bounded streaming", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-streaming-");
  const target = join(workspace, "large.bin");
  const baseline = Buffer.alloc(4 * 1024 * 1024 + 31);
  for (let index = 0; index < baseline.length; index += 1) baseline[index] = index % 251;
  await writeFile(target, baseline);
  const provider = providerFor("snapshot_streaming");
  const snapshot = await provider.create(request(workspace, ["large.bin"]));
  await trackedWrite(target, "changed");
  await provider.revert(snapshot!.id, { cwd: workspace });
  expect(await readFile(target)).toEqual(baseline);
});

test("rejects an oversized backup before touching the target and leaves no restore temporary", async () => {
  const fixture = await snapshotFixture("chili-snapshot-oversized-backup-");
  const backup = join(fixture.snapshotDir, "0.blob");
  await truncate(backup, MAX_TEST_FILE_BYTES + 1);
  await writeFile(fixture.target, "target must survive\n");
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("exceeds");
  expect(await readFile(fixture.target, "utf8")).toBe("target must survive\n");
  expect((await readdir(fixture.workspace)).filter((name) => name.startsWith(".chili-snapshot-restore-"))).toEqual([]);
});

for (const tamper of [
  { name: "version", change: (manifest: any) => { manifest.version = 1; } },
  { name: "id", change: (manifest: any) => { manifest.id = "snapshot_other"; } },
  { name: "cwd", change: (manifest: any) => { manifest.cwd = "/"; } },
  { name: "relative path", change: (manifest: any) => { manifest.entries[0].relativePath = "../outside.txt"; } },
  { name: "backup name", change: (manifest: any) => { manifest.entries[0].backupName = "../secret.txt"; } },
  { name: "mode", change: (manifest: any) => { manifest.entries[0].mode = 0o100777; } },
  { name: "missing mode", change: (manifest: any) => {
    manifest.entries[0] = { relativePath: "victim.txt", kind: "missing", existed: false, mode: 0o100644 };
  } },
  { name: "duplicate path", change: (manifest: any) => { manifest.entries.push({ ...manifest.entries[0] }); } },
] as const) {
  test(`rejects a manifest with tampered ${tamper.name}`, async () => {
    const fixture = await snapshotFixture(`chili-snapshot-tamper-${tamper.name.replaceAll(" ", "-")}-`);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    tamper.change(manifest);
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
    await writeFile(fixture.target, "do not overwrite\n");
    await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow();
    expect(await readFile(fixture.target, "utf8")).toBe("do not overwrite\n");
  });
}

test("rejects symlinked manifest, backup, snapshot directory, and snapshot root", async () => {
  const manifestFixture = await snapshotFixture("chili-snapshot-manifest-link-");
  const outsideManifest = join(await temporaryDirectory("chili-snapshot-outside-manifest-"), "manifest.json");
  await writeFile(outsideManifest, await readFile(manifestFixture.manifestPath));
  await rm(manifestFixture.manifestPath);
  await symlink(outsideManifest, manifestFixture.manifestPath);
  await expect(manifestFixture.provider.revert(manifestFixture.id, { cwd: manifestFixture.workspace })).rejects.toThrow("not a regular file");

  const backupFixture = await snapshotFixture("chili-snapshot-backup-link-");
  const backup = join(backupFixture.snapshotDir, "0.blob");
  const outsideSecret = join(await temporaryDirectory("chili-snapshot-outside-backup-"), "secret.txt");
  await writeFile(outsideSecret, "outside backup secret");
  await rm(backup);
  await symlink(outsideSecret, backup);
  await writeFile(backupFixture.target, "keep this\n");
  await expect(backupFixture.provider.revert(backupFixture.id, { cwd: backupFixture.workspace })).rejects.toThrow("not a regular file");
  expect(await readFile(backupFixture.target, "utf8")).toBe("keep this\n");

  const directoryFixture = await snapshotFixture("chili-snapshot-directory-link-");
  const moved = `${directoryFixture.snapshotDir}-moved`;
  await rename(directoryFixture.snapshotDir, moved);
  await symlink(moved, directoryFixture.snapshotDir);
  await expect(directoryFixture.provider.revert(directoryFixture.id, { cwd: directoryFixture.workspace })).rejects.toThrow("snapshot directory");

  const rootWorkspace = await temporaryDirectory("chili-snapshot-root-link-");
  const externalRoot = await temporaryDirectory("chili-snapshot-external-root-");
  await writeFile(join(rootWorkspace, "victim.txt"), "safe\n");
  await symlink(externalRoot, join(rootWorkspace, ".chili"));
  await expect(providerFor("snapshot_root_link").create(request(rootWorkspace, ["victim.txt"]))).rejects.toThrow("symbolic link");
  expect(await readdir(externalRoot)).toEqual([]);
});

test("revert rejects symlinked target ancestors and final targets without modifying outside files", async () => {
  const ancestorFixture = await snapshotFixture("chili-snapshot-target-parent-", "nested/victim.txt");
  const outsideParent = await temporaryDirectory("chili-snapshot-target-outside-parent-");
  const outsideVictim = join(outsideParent, "victim.txt");
  await writeFile(outsideVictim, "outside parent secret\n");
  await rm(join(ancestorFixture.workspace, "nested"), { recursive: true });
  await symlink(outsideParent, join(ancestorFixture.workspace, "nested"));
  await expect(ancestorFixture.provider.revert(ancestorFixture.id, { cwd: ancestorFixture.workspace })).rejects.toThrow("symbolic link");
  expect(await readFile(outsideVictim, "utf8")).toBe("outside parent secret\n");

  const finalFixture = await snapshotFixture("chili-snapshot-target-final-");
  const outsideFinal = join(await temporaryDirectory("chili-snapshot-target-outside-final-"), "secret.txt");
  await writeFile(outsideFinal, "outside final secret\n");
  await rm(finalFixture.target);
  await symlink(outsideFinal, finalFixture.target);
  await expect(finalFixture.provider.revert(finalFixture.id, { cwd: finalFixture.workspace })).rejects.toThrow("not a regular file");
  expect(await readFile(outsideFinal, "utf8")).toBe("outside final secret\n");
});

function providerFor(id: string): FileSystemSnapshotProvider {
  return new FileSystemSnapshotProvider({ createId: () => id });
}

function request(cwd: string, patterns: string[]): SnapshotCreateRequest {
  return {
    cwd,
    sessionId: "session_snapshot" as SnapshotCreateRequest["sessionId"],
    callId: "call_snapshot" as SnapshotCreateRequest["callId"],
    toolName: "write",
    patterns,
    reason: "before write",
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

async function snapshotFixture(prefix: string, relativePath = "victim.txt") {
  const workspace = await temporaryDirectory(prefix);
  const target = join(workspace, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "snapshot baseline\n");
  const id = "snapshot_fixture" as SnapshotId;
  const provider = providerFor(id);
  await provider.create(request(workspace, [relativePath]));
  const snapshotDir = join(workspace, ".chili", "snapshots", id);
  return {
    workspace,
    target,
    id,
    provider,
    snapshotDir,
    manifestPath: join(snapshotDir, "manifest.json"),
  };
}

async function collectRegularFileContents(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await collectRegularFileContents(path));
    else if (entry.isFile()) result.push(await readFile(path, "utf8"));
  }
  return result;
}

async function trackedWrite(path: string, content: string, sessionId = "session_snapshot", mode?: number): Promise<void> {
  await withFileOperationLocks([path], new AbortController().signal, async () => {
    const before = await readFile(path, "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    await writeFileTextIfUnchanged(path, content, before);
    if (mode !== undefined) {
      await chmod(path, mode);
      await recordOwnedFileVersion(path, createHash("sha256").update(content).digest("hex"));
    }
  }, { sessionId });
}

test("snapshot restore takes the same locks as file tools and cancelled waits preserve current contents", async () => {
  const fixture = await snapshotFixture("chili-snapshot-resource-lock-");
  await trackedWrite(fixture.target, "owned change");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([fixture.target], new AbortController().signal, async () => { entered(); await gate; });
  await ready;
  const controller = new AbortController();
  let settled = false;
  const revert = fixture.provider.revert(fixture.id, { cwd: fixture.workspace, signal: controller.signal })
    .finally(() => { settled = true; });
  // Attach the rejection handler before aborting the operation.
  const outcome = revert.catch((error: unknown) => error);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(await readFile(fixture.target, "utf8")).toBe("owned change");
    controller.abort(new Error("cancelled restore wait"));
    expect(await outcome).toMatchObject({ message: "cancelled restore wait" });
  } finally {
    release();
    await holder;
  }
  await fixture.provider.revert(fixture.id, { cwd: fixture.workspace });
  expect(await readFile(fixture.target, "utf8")).toBe("snapshot baseline\n");
});

test("snapshot restore rejects another session's later write before restoring any file", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-other-session-");
  await writeFile(join(workspace, "a.txt"), "before A");
  await writeFile(join(workspace, "b.txt"), "before B");
  const provider = providerFor("snapshot_sessions");
  const snapshot = await provider.create(request(workspace, ["a.txt", "b.txt"]));
  const tools = fileTools();
  await observedWrite(tools, workspace, "session_snapshot", "a.txt", "owned A");
  await observedWrite(tools, workspace, "other_session", "b.txt", "other B");
  await expect(provider.revert(snapshot!.id, { cwd: workspace })).rejects.toThrow("another session changed");
  expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("owned A");
  expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("other B");
});

test("snapshot restore cannot erase a competing builtin writer and invalidates older reads after restore", async () => {
  const fixture = await snapshotFixture("chili-snapshot-writer-race-");
  const tools = fileTools();
  await observedWrite(tools, fixture.workspace, "session_snapshot", "victim.txt", "owned change");
  const base = { cwd: fixture.workspace, sessionId: "other_session" as SessionId, turnId: "turn" as TurnId };
  expect((await tools.execute({ ...base, toolName: "read", input: { filePath: "victim.txt" } })).status).toBe("completed");
  const [restore, write] = await Promise.allSettled([
    fixture.provider.revert(fixture.id, { cwd: fixture.workspace }),
    tools.execute({ ...base, toolName: "write", input: { filePath: "victim.txt", content: "other change" } }),
  ]);
  expect(write.status).toBe("fulfilled");
  if (write.status !== "fulfilled") return;
  if (write.value.status === "completed") {
    expect(restore.status).toBe("rejected");
    expect(await readFile(fixture.target, "utf8")).toBe("other change");
  } else {
    expect(restore.status).toBe("fulfilled");
    expect(await readFile(fixture.target, "utf8")).toBe("snapshot baseline\n");
    expect(write.value.error.message).toContain("File changed since it was read");
  }
});

test("snapshot restore rejects untracked external modifications and same-size backup tampering", async () => {
  const fixture = await snapshotFixture("chili-snapshot-untracked-");
  await writeFile(fixture.target, "untracked editor change");
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("not recorded for this session");
  expect(await readFile(fixture.target, "utf8")).toBe("untracked editor change");
  await writeFile(join(fixture.snapshotDir, "0.blob"), "tampered baseline\n");
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("backup content changed");
  expect(await readFile(fixture.target, "utf8")).toBe("untracked editor change");
});

test("legacy snapshots allow an unchanged no-op but do not infer missing mutation ownership", async () => {
  const fixture = await snapshotFixture("chili-snapshot-legacy-");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.version = 2;
  delete manifest.ownership;
  for (const entry of manifest.entries) delete entry.beforeVersion;
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const before = await lstat(fixture.target);
  await fixture.provider.revert(fixture.id, { cwd: fixture.workspace });
  expect((await lstat(fixture.target)).ino).toBe(before.ino);
  await writeFile(fixture.target, "later change");
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("older snapshot has no record");
  expect(await readFile(fixture.target, "utf8")).toBe("later change");
});

test("the executor creates a restorable snapshot and restored versions invalidate its previous observation", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-executor-");
  await writeFile(join(workspace, "victim.txt"), "before");
  let snapshotSequence = 0;
  const provider = new FileSystemSnapshotProvider({ createId: () => `snapshot_executor_${++snapshotSequence}` });
  const tools = fileTools(provider);
  await observedWrite(tools, workspace, "session_snapshot", "victim.txt", "after");
  // A fresh provider instance can verify durable ownership from the shared journal.
  await new FileSystemSnapshotProvider().revert("snapshot_executor_1" as SnapshotId, { cwd: workspace });
  expect(await readFile(join(workspace, "victim.txt"), "utf8")).toBe("before");
  const stale = await tools.execute({
    cwd: workspace, sessionId: "session_snapshot" as SessionId, turnId: "next_turn" as TurnId,
    toolName: "write", input: { filePath: "victim.txt", content: "stale" },
  });
  expect(stale.status).toBe("failed");
  if (stale.status === "failed") expect(stale.error.message).toContain("File changed since it was read");
});

function fileTools(snapshotProvider?: FileSystemSnapshotProvider): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  return new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    gate: { review: async () => ({ decision: "allow" }) },
    ...(snapshotProvider ? { snapshotProvider } : {}),
  });
}

async function observedWrite(tools: ToolExecutor, cwd: string, sessionId: string, filePath: string, content: string): Promise<void> {
  const base = { cwd, sessionId: sessionId as SessionId, turnId: "turn" as TurnId };
  expect((await tools.execute({ ...base, toolName: "read", input: { filePath } })).status).toBe("completed");
  expect((await tools.execute({ ...base, toolName: "write", input: { filePath, content } })).status).toBe("completed");
}

test("snapshot creation waits for an active file mutation and backs up the committed version", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-create-lock-");
  const path = join(workspace, "victim.txt");
  await writeFile(path, "initial");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([path], new AbortController().signal, async () => {
    entered();
    await gate;
    await writeFileTextIfUnchanged(path, "committed", "initial");
  }, { sessionId: "writer" });
  await ready;
  const provider = providerFor("snapshot_wait_create");
  let settled = false;
  const creating = provider.create(request(workspace, ["victim.txt"])).finally(() => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  } finally {
    release();
    await holder;
  }
  await creating;
  expect(await readFile(join(workspace, ".chili", "snapshots", "snapshot_wait_create", "0.blob"), "utf8")).toBe("committed");
});

test("mutation ownership survives the actual writer process exiting", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-process-owner-");
  await writeFile(join(workspace, "a.txt"), "baseline");
  const provider = providerFor("snapshot_process");
  const snapshot = await provider.create(request(workspace, ["a.txt"]));
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/file-observation-worker.ts", import.meta.url)), "write", workspace, "session_snapshot"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    child.stdin.write("go\n");
    child.stdin.end();
    let output = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output.trim()).toBe("completed");
    expect(await child.exited).toBe(0);
    await new FileSystemSnapshotProvider().revert(snapshot!.id, { cwd: workspace });
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("baseline");
  } finally {
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("a later same-session write does not hide an intervening other-session change", async () => {
  const fixture = await snapshotFixture("chili-snapshot-intervening-owner-");
  await trackedWrite(fixture.target, "other", "other_session");
  await trackedWrite(fixture.target, "latest owned");
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("another session changed");
  expect(await readFile(fixture.target, "utf8")).toBe("latest owned");
});

test("a final untracked image cannot be claimed as the session's completed mutation", async () => {
  const fixture = await snapshotFixture("chili-snapshot-unowned-postimage-");
  await withFileOperationLocks([fixture.target], new AbortController().signal, async () => {
    await writeFileTextIfUnchanged(fixture.target, "known own output", "snapshot baseline\n");
    await writeFile(fixture.target, "untracked output arrived later");
  }, { sessionId: "session_snapshot" });
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("not recorded for this session");
  expect(await readFile(fixture.target, "utf8")).toBe("untracked output arrived later");
});

test("a missing journal epoch cannot authorize restoration of changed content", async () => {
  const fixture = await snapshotFixture("chili-snapshot-journal-epoch-");
  await trackedWrite(fixture.target, "owned content");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  manifest.ownership.epoch = "a-journal-that-no-longer-exists";
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  await expect(fixture.provider.revert(fixture.id, { cwd: fixture.workspace })).rejects.toThrow("history is no longer available");
  expect(await readFile(fixture.target, "utf8")).toBe("owned content");
});

test("snapshot creation rechecks revoked authorization after waiting for its file locks", async () => {
  const workspace = await temporaryDirectory("chili-snapshot-policy-wait-");
  const path = join(workspace, "victim.txt");
  await writeFile(path, "private");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([path], new AbortController().signal, async () => { entered(); await gate; });
  await ready;
  let allowed = true;
  const creating = providerFor("snapshot_revoked").create({
    ...request(workspace, ["victim.txt"]),
    assertCurrentAuthorization: async () => { if (!allowed) throw new Error("permission revoked"); },
  });
  const outcome = creating.catch((error: unknown) => error);
  allowed = false;
  release();
  await holder;
  expect(await outcome).toMatchObject({ message: "permission revoked" });
  await expect(lstat(join(workspace, ".chili", "snapshots"))).rejects.toMatchObject({ code: "ENOENT" });
});
