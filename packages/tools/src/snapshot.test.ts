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

test("creates a version 2 manifest and reverts regular and missing files with normalized modes", async () => {
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
    version: 2,
    id: "snapshot_normal",
    cwd: await realpath(workspace),
    entries: [
      { relativePath: "src/executable.sh", kind: "regular", existed: true, backupName: "0.blob", mode: 0o100755 },
      { relativePath: "src/missing.txt", kind: "missing", existed: false },
      { relativePath: "src/regular.txt", kind: "regular", existed: true, backupName: "2.blob", mode: 0o100644 },
    ],
  });
  expect(manifest.entries[1].mode).toBeUndefined();

  await writeFile(join(workspace, "src", "regular.txt"), "after\n");
  await writeFile(join(workspace, "src", "executable.sh"), "changed\n");
  await chmod(join(workspace, "src", "executable.sh"), 0o600);
  await writeFile(join(workspace, "src", "missing.txt"), "created later\n");
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
  await writeFile(target, "changed");
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
