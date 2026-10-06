import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliToolExecutionContext } from "../types.js";
import { FileReadStateStore } from "../file-read-state.js";
import { InMemoryToolRegistry } from "../registry.js";
import { ManagedProcessManager } from "../managed-process.js";
import { runProcess } from "../process.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createGitDiffTool, createGitStageTool, createGitStatusTool } from "./git-diff.js";
import { createProcessTool } from "./process.js";
import { createReadFileTool } from "./read-file.js";
import { createReadImageTool } from "./read-image.js";
import { createToolSearchTool } from "./tool-search.js";
import { createWriteFileTool } from "./write-file.js";

test("read exposes selected text without truncation notices and identifies the requested range", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-read-"));
  try {
    await writeFile(join(cwd, "notes.txt"), "first\nsecond\nthird\n");
    const tool = createReadFileTool();
    const prefix = await tool.execute({ filePath: "notes.txt", maxBytes: 4 }, context(cwd));
    expect(prefix.output).toContain("[truncated");
    expect(prefix.structuredData).toEqual({ path: "notes.txt", content: "firs", bytes: 19, truncated: true, offset: 1, limit: null });
    const range = await tool.execute({ filePath: "notes.txt", offset: 2, limit: 1 }, context(cwd));
    expect(range.structuredData).toEqual({ path: "notes.txt", content: "second", bytes: 19, truncated: false, offset: 2, limit: 1 });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob preserves complete unusual filenames while grep reports text lines and truncation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-search-"));
  try {
    const filename = "name:with\nnewline.txt";
    await writeFile(join(cwd, filename), "needle one\nneedle two\n");
    const glob = await createGlobTool().execute({ pattern: "*.txt" }, context(cwd));
    expect(glob.structuredData).toEqual({ paths: [filename], truncated: false });
    await writeFile(join(cwd, "plain.txt"), "needle one\nneedle two\n");
    const grep = await createGrepTool().execute({ pattern: "needle", path: "plain.txt", headLimit: 1 }, context(cwd));
    expect(grep.structuredData).toEqual({ lines: ["1:needle one"], outputMode: "content", truncated: true, maxColumns: 500 });
    expect(grep.output).toContain("[truncated after 1 line(s)]");
    const none = await createGrepTool().execute({ pattern: "missing", path: "plain.txt" }, context(cwd));
    expect(none.structuredData).toMatchObject({ lines: [], truncated: false });
    expect(none.output).toBe("(no matches)");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bash returns separate unformatted streams, nonzero status, and capture truncation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-bash-"));
  try {
    const result = await createBashTool().execute({ command: "printf abcdef; printf error >&2; exit 7", maxOutputBytes: 4 }, context(cwd));
    expect(result.structuredData).toMatchObject({
      background: false, stdout: "abcd", stderr: "erro", exitCode: 7, signal: null,
      timedOut: false, stdoutTruncated: true, stderrTruncated: true, stdoutBytes: 6, stderrBytes: 5,
    });
    expect(result.title).toBe("exit 7");
    expect(result.output).toContain("[stderr]");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write, edit and patch return their actual mutations and images keep pixels separate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-mutation-"));
  try {
    const ctx = context(cwd);
    const written = await createWriteFileTool().execute({ filePath: "a.txt", content: "old old" }, ctx);
    expect(written.structuredData).toEqual({ path: "a.txt", created: true, bytes: 7 });
    const edited = await createEditTool().execute({ filePath: "a.txt", oldString: "old", newString: "new", replaceAll: true }, ctx);
    expect(edited.structuredData).toEqual({ path: "a.txt", created: false, occurrences: 2 });
    const patched = await createApplyPatchTool().execute({ operations: [{ type: "create", path: "b.txt", content: "b" }] }, ctx);
    expect(patched.structuredData).toMatchObject({ changedCount: 1, operations: [{ type: "create", path: "b.txt", changed: true }] });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(cwd, "pixel.png"), png);
    const image = await createReadImageTool().execute({ filePath: "pixel.png" }, ctx);
    expect(image.structuredData).toEqual({ path: "pixel.png", bytes: png.byteLength, mimeType: "image/png" });
    expect(image.content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool discovery respects visibility and preserves canonical JavaScript names and schemas", async () => {
  const registry = new InMemoryToolRegistry();
  const dashed = { ...createReadFileTool(), name: "a-b", aliases: [] };
  const underscored = { ...createReadFileTool(), name: "a_b", aliases: [] };
  const hidden = { ...createReadFileTool(), name: "hidden", aliases: [] };
  for (const tool of [dashed, underscored, hidden]) registry.register(tool);
  const search = createToolSearchTool(registry);
  const ctx = { ...context("/tmp"), visibleTools: () => [dashed, underscored] };
  const result = await search.execute({ query: "select:a-b,a_b,hidden" }, ctx);
  expect(result.structuredData).toEqual({ tools: [dashed, underscored].map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    codeMode: true, call: `tools[${JSON.stringify(tool.name)}]`,
  })), truncated: false });
  expect(result.output).not.toContain("hidden");
  expect(result.output).toContain(".structuredData schema");
  expect((await search.execute({ query: "select:a-b,a_b", maxResults: 1 }, ctx)).structuredData).toMatchObject({ truncated: true });
});

test("managed process machine results retain the owned handle across calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-process-"));
  const processes = new ManagedProcessManager();
  try {
    const ctx = context(cwd);
    const launched = await createBashTool({ processes }).execute({ command: "printf ready", background: true }, ctx);
    const machine = launched.structuredData as { processId: string };
    expect(machine.processId).toBeString();
    const tool = createProcessTool(processes);
    const read = await tool.execute({ action: "read", processId: machine.processId, waitMs: 2_000 }, ctx);
    expect(read.structuredData).toMatchObject({ processId: machine.processId, status: "exited", outputTail: "ready", truncated: false, exitCode: 0 });
    const listed = await tool.execute({ action: "list" }, ctx);
    expect(listed.structuredData).toMatchObject({ processes: [{ processId: machine.processId }] });
    await expect(tool.execute({ action: "read", processId: machine.processId }, { ...ctx, sessionId: "other" as never })).rejects.toThrow("not available");
  } finally {
    await processes.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("git machine results preserve NUL-delimited paths and discard cut filenames", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-structured-git-"));
  try {
    expect((await runProcess("git", ["init", "-q"], { cwd })).exitCode).toBe(0);
    const filename = "long:name\nwith-newline.txt";
    await writeFile(join(cwd, filename), "content\n");
    const ctx = context(cwd);
    const full = await createGitStatusTool().execute({}, ctx);
    expect(full.structuredData).toMatchObject({ head: null, untracked: [{ path: filename, status: "untracked", code: "??" }], truncated: false });
    const limited = await createGitStatusTool().execute({ maxOutputBytes: 5 }, ctx);
    expect(limited.structuredData).toMatchObject({ untracked: [], truncated: true });
    const staged = await createGitStageTool().execute({ paths: [filename] }, ctx);
    expect(staged.structuredData).toMatchObject({ staged: [{ path: filename, status: "added", code: "A" }], truncated: false });
    const diff = await createGitDiffTool().execute({ staged: true }, ctx);
    expect(diff.structuredData).toMatchObject({ diff: expect.stringContaining("+content"), truncated: false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function context(cwd: string): ChiliToolExecutionContext {
  return {
    sessionId: "session_structured" as never, turnId: "turn_structured" as never, callId: "call_structured" as never,
    outputArtifactId: "output_structured" as never, cwd, signal: new AbortController().signal,
    fileReads: new FileReadStateStore(), registerPersistedOutput: async () => {}, metadata: async () => {}, streamOutput: async () => {},
    requestApproval: async () => ({ action: "allow_once" }),
  };
}
