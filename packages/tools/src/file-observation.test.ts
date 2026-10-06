import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionId, TurnId } from "@chili/protocol";
import { createApplyPatchTool } from "./builtins/apply-patch.js";
import { createEditTool } from "./builtins/edit.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { ToolExecutor } from "./executor.js";
import { writeFileTextIfUnchanged } from "./file-mutation.js";
import { withFileOperationLocks } from "./file-operation-lock.js";
import { FileReadStateStore, readFileContentVersion } from "./file-read-state.js";
import { InMemoryToolRegistry } from "./registry.js";

function executor(): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of [createReadFileTool(), createWriteFileTool(), createEditTool(), createApplyPatchTool()]) registry.register(tool);
  return new ToolExecutor({ registry, events: { publish: async () => undefined }, approvals: { decide: async () => ({ action: "allow_once" }) } });
}

function call(execution: ToolExecutor, cwd: string, session: string, toolName: string, input: unknown) {
  return execution.execute({ cwd, sessionId: session as SessionId, turnId: "turn" as TurnId, toolName, input });
}

async function workspaceTest(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "chili-file-observation-"));
  try {
    await writeFile(join(workspace, "a.txt"), "original");
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("one session's read and write cannot authorize another session or refresh its stale observation", async () => {
  await workspaceTest(async (cwd) => {
    const execution = executor();
    expect((await call(execution, cwd, "A", "read", { filePath: "a.txt" })).status).toBe("completed");
    const unread = await call(execution, cwd, "B", "write", { filePath: "a.txt", content: "B" });
    expect(unread.status).toBe("failed");
    if (unread.status === "failed") expect(unread.error.message).toContain("Read a.txt before modifying");
    expect((await call(execution, cwd, "B", "read", { filePath: "a.txt" })).status).toBe("completed");
    expect((await call(execution, cwd, "B", "write", { filePath: "a.txt", content: "B" })).status).toBe("completed");
    const stale = await call(execution, cwd, "A", "write", { filePath: "a.txt", content: "A" });
    expect(stale.status).toBe("failed");
    if (stale.status === "failed") expect(stale.error.message).toContain("File changed since it was read");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("B");
  });
});

test("canonical aliases share observations inside one workspace and session only", async () => {
  await workspaceTest(async (cwd) => {
    const execution = executor();
    await symlink(join(cwd, "a.txt"), join(cwd, "alias.txt"));
    await call(execution, cwd, "A", "read", { filePath: "./alias.txt" });
    expect((await call(execution, cwd, "A", "edit", { filePath: join(cwd, "a.txt"), oldString: "original", newString: "updated" })).status).toBe("completed");
    expect((await call(execution, cwd, "B", "edit", { filePath: "alias.txt", oldString: "updated", newString: "overwritten" })).status).toBe("failed");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("updated");
  });
});

test("observations are separated by workspace identity and scoped clear preserves other sessions", async () => {
  await workspaceTest(async (cwd) => {
    await workspaceTest(async (other) => {
      const state = new FileReadStateStore();
      const a = state.forSession("A");
      const b = state.forSession("B");
      await a.recordTextRead(cwd, join(cwd, "a.txt"), "original");
      await b.recordTextRead(cwd, join(cwd, "a.txt"), "original");
      await expect(a.assertFresh(other, join(cwd, "a.txt"))).rejects.toThrow("before modifying");
      a.clear();
      await expect(a.assertFresh(cwd, join(cwd, "a.txt"))).rejects.toThrow("before modifying");
      expect((await b.assertFresh(cwd, join(cwd, "a.txt"))).sessionId).toBe("B");
    });
  });
});

test("full and range observations reject content changes even when size and mtime are preserved", async () => {
  await workspaceTest(async (cwd) => {
    const path = join(cwd, "a.txt");
    const execution = executor();
    await call(execution, cwd, "full", "read", { filePath: "a.txt" });
    await call(execution, cwd, "range", "read", { filePath: "a.txt", offset: 1, limit: 1 });
    const before = await stat(path);
    await writeFile(path, "replaced");
    await utimes(path, before.atime, before.mtime);
    expect((await call(execution, cwd, "full", "write", { filePath: "a.txt", content: "bad" })).status).toBe("failed");
    expect((await call(execution, cwd, "range", "edit", { filePath: "a.txt", oldString: "original", newString: "bad" })).status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("replaced");
  });
});

test("a read interrupted by mutation cannot record old contents as a current observation", async () => {
  await workspaceTest(async (cwd) => {
    const path = join(cwd, "a.txt");
    const state = new FileReadStateStore().forSession("A");
    const before = await readFileContentVersion(path);
    await writeFile(path, "changed");
    await expect(state.recordTextRead(cwd, path, "original", before)).rejects.toThrow("changed while");
    await expect(state.recordTextRangeRead(cwd, path, "original", {}, before)).rejects.toThrow("changed while");
    await expect(state.assertFresh(cwd, path)).rejects.toThrow("before modifying");
  });
});

test("a newly created file and a changed preimage cannot be overwritten during commit", async () => {
  await workspaceTest(async (cwd) => {
    const path = join(cwd, "a.txt");
    await expect(writeFileTextIfUnchanged(path, "unseen", undefined)).rejects.toThrow();
    await expect(writeFileTextIfUnchanged(path, "stale", "old version")).rejects.toThrow("File changed before modification");
    expect(await readFile(path, "utf8")).toBe("original");
  });
});

test("a partial reread at a new version invalidates an older full observation", async () => {
  await workspaceTest(async (cwd) => {
    const execution = executor();
    const path = join(cwd, "a.txt");
    await call(execution, cwd, "A", "read", { filePath: "a.txt" });
    await writeFile(path, "changed\nsecond line");
    expect((await call(execution, cwd, "A", "read", { filePath: "a.txt", offset: 1, limit: 1 })).status).toBe("completed");
    expect((await call(execution, cwd, "A", "write", { filePath: "a.txt", content: "overwritten" })).status).toBe("failed");
    expect((await call(execution, cwd, "A", "edit", { filePath: "a.txt", oldString: "changed", newString: "updated" })).status).toBe("completed");
    expect(await readFile(path, "utf8")).toBe("updated\nsecond line");
  });
});

test("two executors cannot both overwrite a file from the same old version", async () => {
  await workspaceTest(async (cwd) => {
    const a = executor();
    const b = executor();
    await Promise.all([call(a, cwd, "A", "read", { filePath: "a.txt" }), call(b, cwd, "B", "read", { filePath: "a.txt" })]);
    const results = await Promise.all([
      call(a, cwd, "A", "write", { filePath: "a.txt", content: "A" }),
      call(b, cwd, "B", "apply_patch", { operations: [{ type: "create", path: "a.txt", content: "B", overwrite: true }] }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "failed"]);
    expect(["A", "B"]).toContain(await readFile(join(cwd, "a.txt"), "utf8"));
  });
});

test("two processes share version-check/write serialization", async () => {
  await workspaceTest(async (cwd) => {
    const a = worker("write", cwd, "A");
    const b = worker("write", cwd, "B");
    try {
      await Promise.all([ready(a), ready(b)]);
      a.stdin.write("go\n");
      a.stdin.end();
      b.stdin.write("go\n");
      b.stdin.end();
      const results = await Promise.all([readRemaining(a.stdout), readRemaining(b.stdout)]);
      expect(results.map((result) => result.trim()).sort()).toEqual(["completed", "failed"]);
      expect(await a.exited).toBe(0);
      expect(await b.exited).toBe(0);
      expect(["A", "B"]).toContain(await readFile(join(cwd, "a.txt"), "utf8"));
    } finally {
      a.kill("SIGKILL");
      b.kill("SIGKILL");
      await Promise.all([a.exited, b.exited]);
    }
  });
});

test("file lock waits cancel without mutation and a killed process releases ownership", async () => {
  await workspaceTest(async (cwd) => {
    const child = worker("hold", cwd, "owner");
    try {
      await ready(child);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("cancelled file wait")), 40);
      const signal = controller.signal;
      let entered = false;
      await expect(withFileOperationLocks([join(cwd, "a.txt")], signal, async () => { entered = true; })).rejects.toThrow("cancelled file wait");
      clearTimeout(timer);
      expect(entered).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      await withFileOperationLocks([join(cwd, "a.txt")], new AbortController().signal, async () => { entered = true; });
      expect(entered).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});

function worker(mode: string, cwd: string, session: string) {
  return Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/file-observation-worker.ts", import.meta.url)), mode, cwd, session], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
}

async function ready(child: ReturnType<typeof worker>): Promise<void> {
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    if (!first.value) throw new Error(`Worker did not become ready: ${await new Response(child.stderr).text()}`);
    expect(new TextDecoder().decode(first.value)).toBe("ready\n");
  } finally {
    reader.releaseLock();
  }
}

async function readRemaining(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return output;
      output += new TextDecoder().decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}
