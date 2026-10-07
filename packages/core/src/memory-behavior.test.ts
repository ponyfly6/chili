import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createReadFileTool, InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import { addChiliMemoryEntry, listChiliMemoryEntries, resolveChiliMemoryDirectories } from "./memory/index.js";
import { compactionGroups, ContextWindowBuilder } from "./context/window.js";

test("ordinary nested Markdown files are current Memory without a schema or cache", async () => {
  const fixture = await memoryFixture();
  try {
    const path = join(fixture.directories.project, "decisions", "architecture.md");
    await mkdir(join(fixture.directories.project, "decisions"), { recursive: true });
    const text = "---\nowner: human\n---\n# Decisions\n\n<T> plain Markdown 😀\n";
    await writeFile(path, text);
    expect(await listChiliMemoryEntries(fixture.options)).toEqual([{ scope: "project", path, text }]);
    await writeFile(path, "updated by an ordinary editor\n");
    expect((await listChiliMemoryEntries(fixture.options))[0]?.text).toBe("updated by an ordinary editor\n");
    await rm(path);
    expect(await listChiliMemoryEntries(fixture.options)).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("personal files share across projects while project and profile files stay isolated", async () => {
  const fixture = await memoryFixture();
  try {
    const user = await addChiliMemoryEntry({ ...fixture.options, scope: "user", text: "personal preference" });
    const project = await addChiliMemoryEntry({ ...fixture.options, text: "alpha project fact" });
    expect((await listChiliMemoryEntries(fixture.options)).map((file) => file.path)).toEqual([user.path, project.path]);
    const beta = { ...fixture.options, projectId: "project_" + "b".repeat(32) };
    expect(await listChiliMemoryEntries(beta)).toEqual([user]);
    expect(await listChiliMemoryEntries({ ...fixture.options, scope: "user" })).toEqual([user]);
    expect(await listChiliMemoryEntries({ ...fixture.options, scope: "project" })).toEqual([project]);
    expect(await listChiliMemoryEntries({ ...fixture.options, chiliHome: join(fixture.root, "other-profile") })).toEqual([]);
  } finally { await fixture.cleanup(); }
});

test("Memory discovery ignores symlinked files and subdirectories and other file types", async () => {
  const fixture = await memoryFixture();
  try {
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await mkdir(fixture.directories.project, { recursive: true });
    await writeFile(join(outside, "secret.md"), "must not escape current scope");
    await symlink(join(outside, "secret.md"), join(fixture.directories.project, "linked.md"));
    await symlink(outside, join(fixture.directories.project, "linked-directory"));
    await writeFile(join(fixture.directories.project, "notes.txt"), "not Markdown");
    const file = join(fixture.directories.project, "NOTES.MD");
    await writeFile(file, "ordinary Markdown");
    expect(await listChiliMemoryEntries(fixture.options)).toEqual([{ scope: "project", path: file, text: "ordinary Markdown" }]);
  } finally { await fixture.cleanup(); }
});

test("Memory never reads or imports obsolete SQLite or old memory.md files", async () => {
  const fixture = await memoryFixture();
  try {
    await mkdir(fixture.options.chiliHome, { recursive: true });
    await mkdir(join(fixture.options.cwd, ".chili"));
    const oldPaths = [join(fixture.options.chiliHome, "memory.sqlite"), join(fixture.options.chiliHome, "memory.md"), join(fixture.options.cwd, ".chili", "memory.md")];
    for (const path of oldPaths) await writeFile(path, "obsolete bytes that must never be consumed");
    expect(await listChiliMemoryEntries(fixture.options)).toEqual([]);
    await addChiliMemoryEntry({ ...fixture.options, text: "new ordinary file" });
    expect((await listChiliMemoryEntries(fixture.options)).map((file) => file.text)).toEqual(["new ordinary file"]);
    for (const path of oldPaths) expect(await readFile(path, "utf8")).toBe("obsolete bytes that must never be consumed");
  } finally { await fixture.cleanup(); }
});

test("Memory file discovery rejects invalid UTF-8 rather than changing source bytes", async () => {
  const fixture = await memoryFixture();
  try {
    await mkdir(fixture.directories.project, { recursive: true });
    await writeFile(join(fixture.directories.project, "malformed.md"), Buffer.from([0xff, 0xfe, 0x61]));
    await expect(listChiliMemoryEntries(fixture.options)).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

test("ordinary read tools preserve Memory source while Context budgets only its displayed result", async () => {
  const fixture = await memoryFixture();
  try {
    const source = "# Durable fact\n" + "x".repeat(30_000) + "\nDO_NOT_CHANGE_PUBLIC_API\n";
    const file = await addChiliMemoryEntry({ ...fixture.options, text: source });
    const registry = new InMemoryToolRegistry();
    registry.register(createReadFileTool());
    let sequence = 0;
    const executor = new ToolExecutor({
      registry, createId: (prefix) => `${prefix}_${++sequence}`,
      gate: { review: async () => ({ decision: "allow" }) }, events: { publish: async () => undefined },
    });
    const sessionId = "session_memory_file" as SessionId;
    const outcome = await executor.execute({
      sessionId, turnId: "turn_memory_file" as TurnId, toolName: "read", input: { filePath: file.path }, cwd: fixture.root,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("ordinary file read failed");
    expect(outcome.result.output).toBe(source);
    const messageId = "message_memory_file" as MessageId;
    const callId = outcome.callId as ToolCallId;
    const message: Message = {
      id: messageId, sessionId, role: "assistant", createdAt: 1 as TimestampMs,
      parts: [
        { id: "part_memory_call" as PartId, messageId, sessionId, type: "tool_call", callId, toolName: "read", input: { filePath: file.path }, status: "completed" },
        { id: "part_memory_result" as PartId, messageId, sessionId, type: "tool_result", callId, output: outcome.result.output },
      ],
    };
    const displayed = new ContextWindowBuilder({ maxToolResultChars: 1_000 }).build([message]);
    const result = displayed.messages[0]?.parts.find((part) => part.type === "tool_result");
    expect(result?.type).toBe("tool_result");
    if (result?.type !== "tool_result") throw new Error("missing displayed tool result");
    expect(result.output.length).toBeLessThanOrEqual(1_000);
    expect(compactionGroups([message])).toEqual([[message]]);
    expect(await readFile(file.path, "utf8")).toBe(source);
    expect((await listChiliMemoryEntries(fixture.options))[0]?.text).toBe(source);
  } finally { await fixture.cleanup(); }
});

async function memoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-memory-behavior-")));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const options = { cwd, chiliHome: join(root, "profile"), projectRoot: cwd, projectId: "project_" + "a".repeat(32) };
  return { root, options, directories: await resolveChiliMemoryDirectories(options), cleanup: () => rm(root, { recursive: true, force: true }) };
}
