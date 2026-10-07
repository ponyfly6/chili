import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, TurnId } from "@chili/protocol";
import { createPresentFileTool, DEFAULT_CODING_TOOLS } from "./index.js";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { ToolExecutor } from "./executor.js";
import { withFileOperationLocks } from "./file-operation-lock.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolDefinition, ToolExecutorOptions, ToolReviewRequest } from "./types.js";

async function workspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "chili-present-file-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function harness(options: Partial<ToolExecutorOptions> = {}, tool: ChiliToolDefinition = createPresentFileTool()): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  registry.register(createToolSearchTool(registry));
  return new ToolExecutor({ registry, events: { publish: async () => {} }, gate: { review: async () => ({ decision: "allow" }) }, ...options });
}

function call(executor: ToolExecutor, cwd: string, input: unknown, toolName = "present_file") {
  return executor.execute({ cwd, sessionId: "present_file_session" as SessionId, turnId: "turn" as TurnId, toolName, input });
}

test("present_file returns a canonical deliverable without changing or creating workspace files", async () => workspace(async (cwd) => {
  await mkdir(join(cwd, "output"));
  const path = join(cwd, "output", "report.pdf");
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff]);
  await writeFile(path, bytes);
  const before = await stat(path);
  const files = await readdir(cwd, { recursive: true });
  const result = await call(harness(), cwd, { filePath: "output/report.pdf", title: "  Report  ", description: "  Final report  " });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  const expected = { type: "presented_file", path: await realpath(path), title: "Report", description: "Final report" };
  expect(JSON.parse(result.result.output)).toEqual(expected);
  expect(result.result.structuredData).toEqual(expected);
  expect(result.result.title).toBe("Presented file: Report");
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect(await readdir(cwd, { recursive: true })).toEqual(files);
}));

test("present_file resolves permitted aliases and defaults its title to the canonical file name", async () => workspace(async (cwd) => {
  await mkdir(join(cwd, "output"));
  const path = join(cwd, "output", "report.txt");
  await writeFile(path, "");
  await symlink(path, join(cwd, "report-alias"));
  await symlink(join(cwd, "output"), join(cwd, "output-alias"));
  const executor = harness();
  for (const filePath of [path, "report-alias", "output-alias/report.txt"]) {
    const result = await call(executor, cwd, { filePath });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(JSON.parse(result.result.output)).toEqual({ type: "presented_file", path: await realpath(path), title: "report.txt" });
  }
}));

test("present_file supports a symlinked workspace while returning its physical path", async () => workspace(async (cwd) => {
  const actual = join(cwd, "actual");
  const alias = join(cwd, "workspace-alias");
  await mkdir(actual);
  await symlink(actual, alias);
  await writeFile(join(actual, "report.txt"), "report");
  const result = await call(harness(), alias, { filePath: "report.txt" });
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(JSON.parse(result.result.output).path).toBe(await realpath(join(actual, "report.txt")));
}));

test("present_file rejects traversal, outside paths, and escaping symlinks", async () => workspace(async (cwd) => {
  const inside = join(cwd, "workspace");
  const outside = join(cwd, "outside");
  await mkdir(inside);
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "private content");
  await symlink(join(outside, "private.txt"), join(inside, "file-alias"));
  await symlink(outside, join(inside, "directory-alias"));
  const executor = harness();
  for (const filePath of ["../outside/private.txt", join(outside, "private.txt"), "file-alias", "directory-alias/private.txt"]) {
    const result = await call(executor, inside, { filePath });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("inside the workspace");
    expect(JSON.stringify(result)).not.toContain("presented_file");
  }
}));

test("present_file rejects missing files, directories, and broken symlinks without creating anything", async () => workspace(async (cwd) => {
  await mkdir(join(cwd, "directory"));
  await symlink(join(cwd, "missing.txt"), join(cwd, "broken"));
  const files = await readdir(cwd, { recursive: true });
  for (const filePath of ["missing.txt", "missing-parent/file.txt", "directory", ".", "broken"]) {
    expect((await call(harness(), cwd, { filePath })).status).toBe("failed");
  }
  expect(await readdir(cwd, { recursive: true })).toEqual(files);
}));

test("present_file rejects hard-linked targets that cannot be uniquely authorized", async () => workspace(async (cwd) => {
  await writeFile(join(cwd, "report.txt"), "report");
  await link(join(cwd, "report.txt"), join(cwd, "alias.txt"));
  const result = await call(harness(), cwd, { filePath: "alias.txt" });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("multi-link");
}));

test.skipIf(process.platform === "win32")("present_file rejects a special file without opening it as a deliverable", async () => workspace(async (cwd) => {
  const path = join(cwd, "pipe");
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  const result = await call(harness(), cwd, { filePath: "pipe" });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("regular file");
}));

test.skipIf(process.getuid?.() === 0)("present_file requires OS read permission", async () => workspace(async (cwd) => {
  const path = join(cwd, "unreadable.txt");
  await writeFile(path, "unreadable");
  await chmod(path, 0o000);
  try { expect((await call(harness(), cwd, { filePath: "unreadable.txt" })).status).toBe("failed"); }
  finally { await chmod(path, 0o600); }
}));

test("present_file reviews the canonical read resource and honors denial", async () => workspace(async (cwd) => {
  await writeFile(join(cwd, "report.txt"), "report");
  await symlink(join(cwd, "report.txt"), join(cwd, "alias"));
  const reviewed: ToolReviewRequest[] = [];
  const executor = harness({ gate: { review: async (request) => {
    reviewed.push(request);
    return { decision: "deny", reason: "Not a requested deliverable." };
  } } });
  const result = await call(executor, cwd, { filePath: "alias" });
  expect(result.status).toBe("failed");
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0]?.input).toEqual({ filePath: "report.txt" });
  expect(reviewed[0]?.resources).toMatchObject({ permission: "read", patterns: ["report.txt"] });
  expect(JSON.stringify(result)).not.toContain("presented_file");
}));

test("present_file refuses an alias redirected after its review", async () => workspace(async (cwd) => {
  await mkdir(join(cwd, "workspace"));
  const inside = join(cwd, "workspace");
  await writeFile(join(inside, "report.txt"), "report");
  await writeFile(join(cwd, "outside.txt"), "outside");
  const alias = join(inside, "alias");
  await symlink(join(inside, "report.txt"), alias);
  const executor = harness({ gate: { review: async () => {
    await unlink(alias);
    await symlink(join(cwd, "outside.txt"), alias);
    return { decision: "allow" };
  } } });
  expect((await call(executor, inside, { filePath: "alias" })).status).toBe("failed");
}));

test("present_file rechecks permission after waiting on an active file operation", async () => workspace(async (cwd) => {
  const path = join(cwd, "report.txt");
  await writeFile(path, "report");
  let valid = true;
  let release!: () => void;
  let locked!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { locked = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const unlock = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([path], new AbortController().signal, async () => { locked(); await unlock; });
  await held;
  const tool = createPresentFileTool();
  const executor = harness({ gate: { review: async () => ({
    decision: "allow", assertCurrent: async () => { if (!valid) throw new Error("Permission revoked."); },
  }) } }, { ...tool, execute: async (input, context) => { entered(); return tool.execute(input, context); } });
  const pending = call(executor, cwd, { filePath: "report.txt" });
  try { await entry; valid = false; } finally { release(); await holder; }
  const result = await pending;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Permission revoked");
}));

test("present_file is available for discovery and safe simultaneous presentations", async () => workspace(async (cwd) => {
  await writeFile(join(cwd, "report.txt"), "report");
  const executor = harness();
  expect(DEFAULT_CODING_TOOLS).toContain("present_file");
  expect(await executor.canRunConcurrently("present_file", { filePath: "report.txt" })).toBe(true);
  const search = await call(executor, cwd, { query: "select:present_file" }, "tool_search");
  expect(search.status).toBe("completed");
  if (search.status === "completed") expect(search.result.output).toContain("present_file");
  const results = await Promise.all(Array.from({ length: 6 }, () => call(executor, cwd, { filePath: "report.txt" })));
  expect(results.every((result) => result.status === "completed")).toBe(true);
  expect(await readFile(join(cwd, "report.txt"), "utf8")).toBe("report");
}));

test("present_file rejects malformed or overlong input", async () => workspace(async (cwd) => {
  const executor = harness();
  for (const input of [null, [], {}, { filePath: " " }, { filePath: "bad\0path" }, { filePath: "report.txt", title: 1 },
    { filePath: "report.txt", title: " " }, { filePath: "report.txt", title: "a".repeat(201) },
    { filePath: "report.txt", description: false }, { filePath: "report.txt", description: "a".repeat(2_001) },
    { filePath: "report.txt", content: "do not write" }]) {
    expect((await call(executor, cwd, input)).status).toBe("failed");
  }
  expect(await readdir(cwd)).toEqual([]);
}));
