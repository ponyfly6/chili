import { expect, test } from "bun:test";
import type { ToolCallId } from "@chili/protocol";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamingToolOutputFile, validatePersistedToolOutput } from "./tool-output-storage.js";

test("persisted tool output registration validates path existence and size", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-registration-"));
  try {
    const callId = "toolcall_registration" as ToolCallId;
    const writer = await StreamingToolOutputFile.open(workspace, callId);
    await writer.append("registered output");
    const persisted = await writer.close();
    expect(await validatePersistedToolOutput(workspace, callId, persisted)).toMatchObject({
      relativePath: persisted.relativePath,
      absolutePath: persisted.absolutePath,
      bytes: persisted.bytes,
    });
    await expect(validatePersistedToolOutput(workspace, callId, {
      ...persisted,
      relativePath: "../../outside.txt",
    })).rejects.toThrow("was not created by Chili storage");

    await writeFile(persisted.absolutePath, "changed size", "utf8");
    await expect(validatePersistedToolOutput(workspace, callId, persisted)).rejects.toThrow("size mismatch");
    await unlink(persisted.absolutePath);
    await expect(validatePersistedToolOutput(workspace, callId, persisted)).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output publishes one complete writer for duplicate call ids", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-duplicate-call-"));
  try {
    const callId = "toolcall_duplicate" as ToolCallId;
    const first = await StreamingToolOutputFile.open(workspace, callId);
    await first.append("AAAA");
    const second = await StreamingToolOutputFile.open(workspace, callId);
    await second.append("BBBBBBBB");
    await first.append("CCCC");

    await first.close();
    const published = await second.close();

    expect(await readFile(published.absolutePath, "utf8")).toBe("BBBBBBBB");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output refuses a final-path symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-output-final-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  try {
    await mkdir(join(workspace, ".chili", "tool-results"), { recursive: true });
    await writeFile(outside, "outside-secret", "utf8");
    await symlink(outside, join(workspace, ".chili", "tool-results", "toolcall_symlink.txt"));

    await expect(
      StreamingToolOutputFile.open(workspace, "toolcall_symlink" as ToolCallId),
    ).rejects.toThrow("inside the workspace");
    expect(await readFile(outside, "utf8")).toBe("outside-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming tool output serializes processes and recovers after the lock owner dies", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-process-lock-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const initializer = await StreamingToolOutputFile.open(
      workspace,
      "toolcall_lock_initializer" as ToolCallId,
      { maxBytes: 1, maxDirectoryBytes: 1024 },
    );
    await initializer.close();
    const lockPath = join(workspace, ".chili", "tool-results", ".sidecar.lock");
    child = Bun.spawn([
      process.execPath,
      "-e",
      `import { dlopen, FFIType } from "bun:ffi";
import { open } from "node:fs/promises";
const handle = await open(process.env.CHILI_TEST_LOCK_PATH, "r+");
let result = -1;
if (process.platform === "win32") {
  const library = dlopen("msvcrt.dll", {
    _locking: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  result = library.symbols._locking(handle.fd, 2, 1);
} else {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", "libc.so", "/lib/libc.musl-" + arch + ".so.1", "/lib/ld-musl-" + arch + ".so.1"];
  for (const path of candidates) {
    try {
      const library = dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      result = library.symbols.flock(handle.fd, 2);
      break;
    } catch {}
  }
}
if (result !== 0) throw new Error("failed to acquire test lock");
process.stdout.write("locked\\n");
setInterval(() => { void handle.fd; }, 1_000);
await new Promise(() => {});`,
    ], {
      env: { ...process.env, CHILI_TEST_LOCK_PATH: lockPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Expected child stdout pipe");
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");

    await expect(
      StreamingToolOutputFile.open(
        workspace,
        "toolcall_while_locked" as ToolCallId,
        { maxBytes: 1, maxDirectoryBytes: 1024 },
      ),
    ).rejects.toThrow("Timed out waiting for tool output directory lock");

    child.kill();
    await child.exited;
    child = undefined;
    const recovered = await StreamingToolOutputFile.open(
      workspace,
      "toolcall_after_kill" as ToolCallId,
      { maxBytes: 9, maxDirectoryBytes: 1024 },
    );
    await recovered.append("recovered");
    const published = await recovered.close();
    expect(await readFile(published.absolutePath, "utf8")).toBe("recovered");
  } finally {
    child?.kill();
    await child?.exited.catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output counts abandoned temporary files against the directory budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-stale-temp-"));
  try {
    const directory = join(workspace, ".chili", "tool-results");
    await mkdir(directory, { recursive: true });
    const staleName = ".toolcall_crashed.txt.2147483647.00000000-0000-4000-8000-000000000000.tmp";
    const stalePath = join(directory, staleName);
    await writeFile(stalePath, "12345678", { mode: 0o600 });

    await expect(
      StreamingToolOutputFile.open(workspace, "toolcall_after_crash" as ToolCallId, {
        maxBytes: 8,
        maxDirectoryBytes: 8,
      }),
    ).rejects.toThrow("directory byte budget exhausted");

    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([staleName]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output refuses hard-linked entries that bypass safe budget accounting", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-hardlink-budget-"));
  try {
    const directory = join(workspace, ".chili", "tool-results");
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      ".toolcall_linked.txt.2147483647.00000000-0000-4000-8000-000000000000.tmp",
    );
    await writeFile(temporaryPath, "linked", { mode: 0o600 });
    await link(temporaryPath, join(workspace, "linked-alias"));

    await expect(
      StreamingToolOutputFile.open(workspace, "toolcall_after_hardlink" as ToolCallId, {
        maxBytes: 1,
        maxDirectoryBytes: 8,
      }),
    ).rejects.toThrow("Cannot safely account for tool output directory entry");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output reserves directory capacity for live writers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-live-temp-"));
  try {
    const first = await StreamingToolOutputFile.open(workspace, "toolcall_active" as ToolCallId, {
      maxBytes: 8,
      maxDirectoryBytes: 8,
    });
    await expect(
      StreamingToolOutputFile.open(workspace, "toolcall_while_active" as ToolCallId, {
        maxBytes: 8,
        maxDirectoryBytes: 8,
      }),
    ).rejects.toThrow("directory byte budget exhausted");

    await first.append("ok");
    await first.close();
    const next = await StreamingToolOutputFile.open(workspace, "toolcall_after_active" as ToolCallId, {
      maxBytes: 6,
      maxDirectoryBytes: 8,
    });
    await next.append("next");
    await next.close();

    expect(await readFile(join(workspace, ".chili", "tool-results", "toolcall_after_active.txt"), "utf8")).toBe("next");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
