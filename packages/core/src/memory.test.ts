import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { addChiliMemoryEntry, listChiliMemoryEntries, memoryProjectDirectoryName, resolveChiliMemoryDirectories } from "./memory/index.js";
import { DEFAULT_MAX_MEMORY_ENTRY_CHARS } from "./memory/constants.js";
import { writeNewMemoryMarkdown } from "./memory/files.js";

test("Memory directory discovery is read-only and binds the selected profile and project", async () => {
  const fixture = await memoryFixture();
  try {
    const directories = await resolveChiliMemoryDirectories(fixture.options);
    expect(directories).toEqual({
      root: join(fixture.options.chiliHome, "memory"), personal: join(fixture.options.chiliHome, "memory", "personal"),
      project: join(fixture.options.chiliHome, "memory", "projects", fixture.options.projectId), projectId: fixture.options.projectId,
    });
    expect(await listChiliMemoryEntries(fixture.options)).toEqual([]);
    expect(await exists(fixture.options.chiliHome)).toBe(false);
    const selected = await resolveChiliMemoryDirectories({ ...fixture.options, homeDir: join(fixture.root, "ignored-home") });
    expect(selected).toEqual(directories);
    const defaultProfile = await resolveChiliMemoryDirectories({ cwd: fixture.options.cwd, homeDir: fixture.root, projectId: fixture.options.projectId });
    expect(defaultProfile.root).toBe(join(fixture.root, ".chili", "memory"));
  } finally { await fixture.cleanup(); }
});

test("Memory project directory names cannot introduce path traversal", () => {
  const native = "project_" + "a".repeat(32);
  expect(memoryProjectDirectoryName(native)).toBe(native);
  for (const id of ["..", "../../outside", "/absolute/project", "project-name", "", "a\\b"]) {
    const name = memoryProjectDirectoryName(id);
    expect(name).toBe(`project_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`);
    expect(basename(name)).toBe(name);
  }
});

test("Memory inferred project identity matches Host identity and shares Git worktrees", async () => {
  const fixture = await memoryFixture();
  try {
    const cwd = fixture.options.cwd;
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]);
    const worktree = join(fixture.root, "worktree");
    execFileSync("git", ["-C", cwd, "worktree", "add", "--detach", "-q", worktree]);
    const common = await realpath(execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
    const hostProjectId = `project_${createHash("sha256").update(common).digest("hex").slice(0, 32)}`;
    const inferred = await resolveChiliMemoryDirectories({ cwd, chiliHome: fixture.options.chiliHome });
    const explicit = await resolveChiliMemoryDirectories({ cwd, chiliHome: fixture.options.chiliHome, projectId: hostProjectId });
    expect(inferred).toEqual(explicit);
    expect(await resolveChiliMemoryDirectories({ cwd: worktree, chiliHome: fixture.options.chiliHome })).toEqual(explicit);
  } finally { await fixture.cleanup(); }
});

test("CLI Memory add preserves exact UTF-8 Markdown in independent ordinary files", async () => {
  const fixture = await memoryFixture();
  try {
    const text = "\ufeff  # Preference\r\n<T>\n\n- Keep 😀 and NUL\u0000\n  trailing spaces  \n";
    const added = await addChiliMemoryEntry({ ...fixture.options, text });
    expect(added).toEqual({ scope: "project", path: added.path, text });
    expect(added.path.endsWith(".md")).toBe(true);
    expect(await readFile(added.path, "utf8")).toBe(text);
    const second = await addChiliMemoryEntry({ ...fixture.options, text });
    expect(second.path).not.toBe(added.path);
    expect((await listChiliMemoryEntries(fixture.options)).map((file) => file.text)).toEqual([text, text]);
    expect(await exists(join(fixture.options.chiliHome, "memory.sqlite"))).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("CLI Memory add rejects invalid or oversized text before creating directories", async () => {
  const fixture = await memoryFixture();
  try {
    for (const text of ["\n  ", "a\ud800b", "a\udfffb", "x".repeat(DEFAULT_MAX_MEMORY_ENTRY_CHARS + 1)]) {
      await expect(addChiliMemoryEntry({ ...fixture.options, text })).rejects.toThrow();
    }
    for (const maxEntryChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(addChiliMemoryEntry({ ...fixture.options, text: "fact", maxEntryChars })).rejects.toThrow("positive integer");
    }
    expect(await exists(fixture.options.chiliHome)).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("new Memory files publish without clobbering existing files and clean temporary paths", async () => {
  const fixture = await memoryFixture();
  try {
    const directories = await resolveChiliMemoryDirectories(fixture.options);
    const path = join(directories.project, "chosen-by-user.md");
    writeNewMemoryMarkdown(directories.root, path, "original");
    expect(() => writeNewMemoryMarkdown(directories.root, path, "must not replace")).toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(directories.project)).toEqual(["chosen-by-user.md"]);
    const added = await Promise.all(Array.from({ length: 8 }, (_, index) => addChiliMemoryEntry({ ...fixture.options, text: `parallel ${index}` })));
    expect(new Set(added.map((file) => file.path)).size).toBe(8);
    expect(await readdir(directories.project)).toHaveLength(9);
  } finally { await fixture.cleanup(); }
});

test("Memory scope directories reject symlink redirection before creating files", async () => {
  const fixture = await memoryFixture();
  try {
    const directories = await resolveChiliMemoryDirectories(fixture.options);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await mkdir(directories.root, { recursive: true });
    await symlink(outside, directories.personal);
    await expect(addChiliMemoryEntry({ ...fixture.options, scope: "user", text: "do not escape" })).rejects.toThrow("ordinary directory");
    await expect(listChiliMemoryEntries({ ...fixture.options, scope: "user" })).rejects.toThrow("ordinary directory");
    expect(await readdir(outside)).toEqual([]);
  } finally { await fixture.cleanup(); }
});

async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }

async function memoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-memory-files-")));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  return {
    root, options: { cwd, chiliHome: join(root, "profile"), projectRoot: cwd, projectId: "project_" + "a".repeat(32) },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
