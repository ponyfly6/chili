import { expect, test } from "bun:test";
import type { SessionId, ToolCallId } from "@chili/protocol";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnsandboxedBashRunner, type BashRunResult, type BashRunner } from "./builtins/bash.js";
import { ManagedProcessManager, type ManagedProcessManagerOptions, type ManagedProcessOwner } from "./managed-process.js";
import { ProcessOutputAccumulator } from "./process-output-accumulator.js";

test("managed process returns while running and exposes later output across reads", async () => {
  const fixture = await createFixture();
  try {
    const processId = fixture.start(nodeCommand(`console.log("ready"); setInterval(() => console.log("still working"), 30);`));
    expect(processId).toStartWith("process_");
    expect(processId).not.toMatch(/^\d+$/);
    const ready = await waitForOutput(fixture, processId, "ready");
    expect(ready.status).toBe("running");
    const later = await waitForOutput(fixture, processId, "still working", ready.output.totalBytes + 1);
    expect(later.output.totalBytes).toBeGreaterThan(ready.output.totalBytes);
    expect(later.result).toBeUndefined();
    const stopped = await fixture.manager.stop(fixture.owner, processId);
    expect(stopped.status).toBe("stopped");
    expect(stopped.finishedAt).toBeGreaterThanOrEqual(stopped.startedAt);
    expect((await fixture.manager.stop(fixture.owner, processId)).output).toEqual(stopped.output);
  } finally {
    await fixture.cleanup();
  }
});

test("managed process waiting observes completion, including a nonzero exit", async () => {
  const fixture = await createFixture();
  try {
    const processId = fixture.start("printf output; printf error >&2; exit 7");
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 });
    expect(snapshot.status).toBe("exited");
    expect(snapshot.result?.exitCode).toBe(7);
    expect(snapshot.output.preview).toContain("output");
    expect(snapshot.output.preview).toContain("error");
    expect(snapshot.output.preview).toContain("[stderr]");
    expect(snapshot.result?.sandbox).toBe("none");
    const info = fixture.manager.list(fixture.owner);
    expect(info).toHaveLength(1);
    expect(info[0]).not.toHaveProperty("output");
    expect(info[0]).not.toHaveProperty("result");
    snapshot.result!.stdout = "changed by caller";
    expect((await fixture.manager.read(fixture.owner, processId)).result?.stdout).toBe("output");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process captures the latest UTF-8 output after the preview limit", async () => {
  const fixture = await createFixture();
  try {
    const processId = fixture.start(nodeCommand(`
      const bytes = Buffer.from("开始🙂");
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(2));
        process.stdout.write("x".repeat(4096));
        setTimeout(() => {
          const ending = Buffer.from("最终错误🙂\\n");
          process.stderr.write(ending.subarray(0, 2));
          setTimeout(() => process.stderr.write(ending.subarray(2)), 20);
        }, 20);
      }, 20);
    `), { maxBytes: 80 });
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 });
    expect(snapshot.status).toBe("exited");
    expect(snapshot.output.truncated).toBe(true);
    expect(snapshot.output.previewBytes).toBeLessThanOrEqual(80);
    expect(snapshot.output.preview).toContain("最终错误🙂");
    expect(snapshot.output.preview).not.toContain("�");
    expect(snapshot.output.preview).toContain("[stderr]");
    expect(snapshot.output.totalBytes).toBeGreaterThan(4096);
    expect(snapshot.output.outputPath).toBeUndefined();
    expect(snapshot.output.persistedOutput).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test("managed process read cancellation leaves the command running", async () => {
  const fixture = await createFixture();
  try {
    const processId = fixture.start(nodeCommand(`console.log("ready"); setInterval(() => {}, 1000);`));
    await waitForOutput(fixture, processId, "ready");
    const controller = new AbortController();
    const read = fixture.manager.read(fixture.owner, processId, { waitMs: 30_000, signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toThrow("aborted");
    expect((await fixture.manager.read(fixture.owner, processId)).status).toBe("running");
    await expect(fixture.manager.read(fixture.owner, processId, { signal: controller.signal })).rejects.toThrow("aborted");
    expect((await fixture.manager.read(fixture.owner, processId, { waitMs: 5 })).status).toBe("running");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process stop kills descendants that ignore TERM before reporting stopped", async () => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  try {
    const processId = fixture.start("trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & child=$!; printf 'child=%s\\n' \"$child\"; wait");
    const ready = await waitForOutput(fixture, processId, "child=");
    const childPid = Number(/child=(\d+)/.exec(ready.output.preview)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(processExists(childPid)).toBe(true);
    const stopped = await fixture.manager.stop(fixture.owner, processId);
    expect(stopped.status).toBe("stopped");
    expect(processExists(childPid)).toBe(false);
  } finally {
    await fixture.cleanup();
  }
}, 10_000);

test("managed process reports timeout separately from explicit stop", async () => {
  const fixture = await createFixture();
  try {
    const processId = fixture.start("printf ready; sleep 10", { timeoutMs: 100 });
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 3_000 });
    expect(snapshot.status).toBe("exited");
    expect(snapshot.result?.timedOut).toBe(true);
    expect(snapshot.output.preview).toContain("ready");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process catches synchronous runner errors and allows reading its failed record", async () => {
  const fixture = await createFixture();
  try {
    const runner: BashRunner = { run() { throw new Error("Cannot spawn executable"); } };
    const processId = fixture.start("ignored", { runner });
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 });
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toBe("Cannot spawn executable");
    expect(snapshot.output.totalBytes).toBe(0);
    expect(snapshot.result).toBeUndefined();
    expect((await fixture.manager.stop(fixture.owner, processId)).status).toBe("failed");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process preserves captured output when its runner rejects", async () => {
  const fixture = await createFixture();
  try {
    const runner: BashRunner = {
      async run(request) {
        expect(request.onOutput).toBeUndefined();
        await request.onRawOutput?.({ stream: "stderr", chunk: Buffer.from("startup failed\n") });
        throw new Error("Process launch failed");
      },
    };
    const processId = fixture.start("ignored", { runner });
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 });
    expect(snapshot.status).toBe("failed");
    expect(snapshot.output.preview).toContain("startup failed");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process IDs are isolated by both session and canonical workspace", async () => {
  const fixture = await createFixture();
  const otherWorkspace = await mkdtemp(join(tmpdir(), "chili-managed-other-"));
  const alias = `${fixture.workspace}-alias`;
  try {
    const processId = fixture.start("printf owned");
    await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 });
    const otherSession = { ...fixture.owner, sessionId: "session_other" as SessionId };
    const otherRoot = { ...fixture.owner, workspaceRoot: otherWorkspace };
    for (const wrongOwner of [otherSession, otherRoot]) {
      expect(fixture.manager.list(wrongOwner)).toEqual([]);
      await expect(fixture.manager.read(wrongOwner, processId)).rejects.toThrow("not available");
      await expect(fixture.manager.stop(wrongOwner, processId)).rejects.toThrow("not available");
    }
    await expect(fixture.manager.read(fixture.owner, "process_missing")).rejects.toThrow("not available");
    await symlink(fixture.workspace, alias, "dir");
    const aliasedOwner = { ...fixture.owner, workspaceRoot: alias };
    expect((await fixture.manager.read(aliasedOwner, processId)).output.preview).toBe("owned");
    expect(() => fixture.start("ignored", { cwd: otherWorkspace })).toThrow("inside its workspace");
    expect(() => fixture.start("ignored", { requestWorkspaceRoot: otherWorkspace })).toThrow("does not match");
  } finally {
    await fixture.cleanup();
    await rm(otherWorkspace, { recursive: true, force: true });
    await rm(alias, { force: true });
  }
});

test("managed process limits running commands and only evicts completed records", async () => {
  const fixture = await createFixture({ maxRunning: 2, maxCompleted: 1 });
  try {
    const running = fixture.start("sleep 10");
    const first = fixture.start("printf first");
    expect(() => fixture.start("printf rejected")).toThrow("Cannot start more than 2");
    await fixture.manager.read(fixture.owner, first, { waitMs: 2_000 });
    const second = fixture.start("printf second");
    await fixture.manager.read(fixture.owner, second, { waitMs: 2_000 });
    expect(fixture.manager.list(fixture.owner).map((info) => info.processId)).toEqual([running, second]);
    await expect(fixture.manager.read(fixture.owner, first)).rejects.toThrow("not available");
    expect((await fixture.manager.read(fixture.owner, running)).status).toBe("running");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process close wins before a deferred launch and is idempotent", async () => {
  const fixture = await createFixture();
  let launches = 0;
  try {
    const runner: BashRunner = { async run() { launches += 1; return fakeResult(); } };
    const processId = fixture.start("never launched", { runner });
    const close = fixture.manager.close();
    expect(fixture.manager.close()).toBe(close);
    expect(() => fixture.start("rejected after close")).toThrow("is closed");
    await close;
    expect(launches).toBe(0);
    expect((await fixture.manager.read(fixture.owner, processId)).status).toBe("stopped");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process stopSession cancels only that session and works after its workspace is removed", async () => {
  const fixture = await createFixture();
  const otherSession = "session_other" as SessionId;
  const aborted: string[] = [];
  try {
    const runner: BashRunner = {
      run(request) {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted.push(request.command);
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    };
    fixture.start("first", { runner });
    fixture.start("second", { runner, owner: { ...fixture.owner, sessionId: otherSession } });
    await Promise.resolve();
    await rm(fixture.workspace, { recursive: true, force: true });
    expect(await fixture.manager.stopSession(fixture.owner.sessionId, "cancelled by user")).toBe(true);
    expect(aborted).toEqual(["first"]);
    expect(await fixture.manager.stopSession(fixture.owner.sessionId)).toBe(false);
    await fixture.manager.close();
    expect(aborted).toEqual(["first", "second"]);
  } finally {
    await fixture.cleanup();
  }
});

test("managed process publishes one close promise before synchronous abort listeners can reenter", async () => {
  const fixture = await createFixture();
  let reentrantClose: Promise<void> | undefined;
  try {
    const runner: BashRunner = {
      run(request) {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reentrantClose = fixture.manager.close();
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    };
    const processId = fixture.start("reentrant", { runner });
    await Promise.resolve();
    const close = fixture.manager.close();
    expect(reentrantClose).toBe(close);
    await close;
    expect((await fixture.manager.read(fixture.owner, processId)).status).toBe("stopped");
  } finally {
    await fixture.cleanup();
  }
});

test("managed process startup snapshots mutable request configuration", async () => {
  const fixture = await createFixture();
  try {
    const env = { EXAMPLE: "before" };
    const runner: BashRunner = {
      async run(request) {
        expect(request.env).toEqual({ EXAMPLE: "before" });
        return fakeResult();
      },
    };
    const processId = fixture.start("ignored", { runner, env });
    env.EXAMPLE = "after";
    expect((await fixture.manager.read(fixture.owner, processId, { waitMs: 2_000 })).status).toBe("exited");
  } finally {
    await fixture.cleanup();
  }
});

interface StartOptions {
  runner?: BashRunner;
  owner?: ManagedProcessOwner;
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  requestWorkspaceRoot?: string;
  env?: Record<string, string>;
}

async function createFixture(options: ManagedProcessManagerOptions = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "chili-managed-process-"));
  const owner = { sessionId: "session_managed" as SessionId, workspaceRoot: workspace };
  const manager = new ManagedProcessManager(options);
  return {
    manager,
    workspace,
    owner,
    start(command: string, startOptions: StartOptions = {}): string {
      return manager.start({
        owner: startOptions.owner ?? owner,
        runner: startOptions.runner ?? createUnsandboxedBashRunner(),
        request: {
          command,
          workspaceRoot: startOptions.requestWorkspaceRoot ?? workspace,
          cwd: startOptions.cwd ?? workspace,
          timeoutMs: startOptions.timeoutMs ?? 0,
          maxOutputBytes: 32,
          sandboxPermissions: "use_default",
          ...(startOptions.env ? { env: startOptions.env } : {}),
        },
        capture: new ProcessOutputAccumulator({
          cwd: workspace,
          callId: "toolcall_managed" as ToolCallId,
          maxBytes: startOptions.maxBytes ?? 4096,
          persistOutput: false,
        }),
      });
    },
    async cleanup(): Promise<void> {
      await manager.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function waitForOutput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  processId: string,
  expected: string,
  minimumBytes = 0,
) {
  const deadline = Date.now() + 3_000;
  while (true) {
    const snapshot = await fixture.manager.read(fixture.owner, processId, { waitMs: 5 });
    if (snapshot.output.preview.includes(expected) && snapshot.output.totalBytes >= minimumBytes) return snapshot;
    if (snapshot.status !== "running" || Date.now() >= deadline) {
      throw new Error(`Expected process output ${expected}: ${JSON.stringify(snapshot)}`);
    }
  }
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakeResult(): BashRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputLimitBytes: 32,
    durationMs: 1,
    timedOut: false,
    aborted: false,
  };
}
