import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRouter, SingleAgentRuntimeOptions } from "../packages/core/src/index.js";
import { SingleAgentRuntime } from "../packages/core/src/index.js";
import { SqliteEventStore } from "../packages/store/src/index.js";
import {
  FileSystemSnapshotProvider,
  InMemoryToolRegistry,
  ToolExecutor,
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGitDiffTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createToolSearchTool,
  createWriteFileTool,
} from "../packages/tools/src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keepWorkspaces = process.env.CHILI_SMOKE_KEEP_WORKSPACE === "1";

type SmokeCase = {
  name: string;
  run(): Promise<void>;
};

type RuntimeOverrides = Omit<
  Partial<SingleAgentRuntimeOptions>,
  "store" | "model" | "toolRegistry" | "toolExecutor"
>;

type EventLike = {
  type: string;
  payload: unknown;
};

const cases: SmokeCase[] = [
  {
    name: "cli fake model turn and resume",
    run: smokeCliFakeTurnAndResume,
  },
  {
    name: "runtime read/glob/grep/edit/apply_patch/bash tools",
    run: smokeRuntimeToolSurface,
  },
  {
    name: "runtime context compaction request",
    run: smokeRuntimeCompaction,
  },
];

await main();

async function main(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; durationMs: number; error?: Error }> = [];
  console.log(`Running ${cases.length} smoke case(s)`);

  for (const smokeCase of cases) {
    const started = performance.now();
    try {
      await smokeCase.run();
      const durationMs = Math.round(performance.now() - started);
      results.push({ name: smokeCase.name, ok: true, durationMs });
      console.log(`[pass] ${smokeCase.name} (${durationMs}ms)`);
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const err = toError(error);
      results.push({ name: smokeCase.name, ok: false, durationMs, error: err });
      console.error(`[fail] ${smokeCase.name} (${durationMs}ms)`);
      console.error(indent(formatError(err)));
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(`Smoke summary: ${passed}/${results.length} passed`);
  for (const result of results) {
    console.log(` - ${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.durationMs}ms)`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function smokeCliFakeTurnAndResume(): Promise<void> {
  await withTempWorkspace("chili-smoke-cli-", async (workspace) => {
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "smoke-cli" }, null, 2), "utf8");

    const first = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "read package"]);
    const sessionId = /\[session\]\s+(session_[^\s]+)/.exec(first.stdout)?.[1];
    assert.ok(sessionId, `missing session id in CLI output:\n${first.stdout}`);
    assert.match(first.stdout, /\[tool\] read/);
    assert.match(first.stdout, /I read the file and the tool loop works/);
    await stat(join(workspace, ".chili", "chili.sqlite"));

    const resumed = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "--resume", sessionId, "hello resume"]);
    assert.match(resumed.stdout, new RegExp(`\\[session\\] ${escapeRegex(sessionId)} \\(resumed\\)`));
    assert.match(resumed.stdout, /Echo: hello resume/);
  });
}

async function smokeRuntimeToolSurface(): Promise<void> {
  await withTempWorkspace("chili-smoke-tools-", async (workspace) => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "alpha.ts"),
      "export const value = 'alpha';\nexport const marker = 'smoke-grep';\n",
      "utf8",
    );
    await writeFile(join(workspace, "src", "beta.ts"), "beta=old\n", "utf8");

    const harness = createRuntimeHarness(workspace, {
      stream: async function* () {
        yield { type: "tool_call", name: "read", input: { filePath: "src/beta.ts" } };
        yield { type: "tool_call", name: "glob", input: { pattern: "src/*.ts" } };
        yield {
          type: "tool_call",
          name: "grep",
          input: { pattern: "smoke-grep", path: "src", outputMode: "content", headLimit: 10 },
        };
        yield {
          type: "tool_call",
          name: "edit",
          input: { filePath: "src/beta.ts", oldString: "beta=old", newString: "beta=new" },
        };
        yield {
          type: "tool_call",
          name: "apply_patch",
          input: {
            operations: [{ type: "create", path: "src/patched.txt", content: "patched\n" }],
          },
        };
        yield { type: "tool_call", name: "bash", input: { command: "cat src/patched.txt", timeoutMs: 5000 } };
        yield { type: "finish", reason: "stop" };
      },
    });

    try {
      const sessionId = await harness.runtime.createSession({ threadId: "thread_tools" as never, cwd: workspace });
      await harness.runtime.appendUserMessage({
        sessionId,
        threadId: "thread_tools" as never,
        text: "exercise the core local tools",
      });
      const result = await harness.runtime.runTurn({ sessionId, threadId: "thread_tools" as never, cwd: workspace });

      assert.equal(result.status, "completed", result.status === "failed" ? result.error.message : undefined);
      assert.equal(await readFile(join(workspace, "src", "beta.ts"), "utf8"), "beta=new\n");
      assert.equal(await readFile(join(workspace, "src", "patched.txt"), "utf8"), "patched\n");

      const events = (await harness.store.events({ sessionId, limit: 200 })) as EventLike[];
      assertToolsCompleted(events, ["read", "glob", "grep", "edit", "apply_patch", "bash"]);
      assert.ok(toolOutputIncludes(events, "glob", "src/alpha.ts"), "glob output did not include src/alpha.ts");
      assert.ok(toolOutputIncludes(events, "grep", "smoke-grep"), "grep output did not include smoke-grep");
      assert.ok(toolOutputIncludes(events, "bash", "patched"), "bash output did not include patched content");
      assert.ok(events.some((event) => event.type === "snapshot.created"), "write tools did not create snapshots");
    } finally {
      harness.store.close();
    }
  });
}

async function smokeRuntimeCompaction(): Promise<void> {
  await withTempWorkspace("chili-smoke-compact-", async (workspace) => {
    let compactionCalls = 0;
    const harness = createRuntimeHarness(
      workspace,
      {
        stream: async function* (input) {
          if (input.tools.length === 0) {
            compactionCalls++;
            yield {
              type: "text_delta",
              text: "<context_summary>\nCurrent goal: keep a compact smoke summary.\nNext steps: continue.\n</context_summary>",
            };
            yield { type: "finish", reason: "stop" };
            return;
          }
          yield { type: "text_delta", text: "continued after compaction" };
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        contextBudget: { maxInputChars: 180, preserveRecentMessages: 1 },
        contextCompaction: { verifySummary: false, maxSourceChars: 1_000, maxSummaryChars: 500 },
      },
    );

    try {
      const sessionId = await harness.runtime.createSession({ threadId: "thread_compact" as never, cwd: workspace });
      await harness.runtime.appendUserMessage({
        sessionId,
        threadId: "thread_compact" as never,
        text: `older context ${"x".repeat(800)}`,
      });
      await harness.runtime.appendUserMessage({
        sessionId,
        threadId: "thread_compact" as never,
        text: "continue with compacted context",
      });

      const result = await harness.runtime.runTurn({ sessionId, threadId: "thread_compact" as never, cwd: workspace });
      assert.equal(result.status, "completed", result.status === "failed" ? result.error.message : undefined);
      assert.equal(compactionCalls, 1);

      const events = (await harness.store.events({ sessionId, limit: 200 })) as EventLike[];
      assert.ok(events.some((event) => event.type === "turn.compaction_requested"), "missing compaction request");
      assert.ok(events.some((event) => event.type === "turn.compaction_completed"), "missing compaction completion");
      const messages = await harness.store.messages(sessionId);
      assert.ok(
        messages.some((message) => message.parts.some((part) => part.type === "compaction")),
        "missing compaction message part",
      );
    } finally {
      harness.store.close();
    }
  });
}

function createRuntimeHarness(workspace: string, model: ModelRouter, options: RuntimeOverrides = {}) {
  const createId = idFactory();
  const store = new SqliteEventStore(join(workspace, `${globalThis.crypto.randomUUID()}.sqlite`));
  const registry = registerTools();
  const snapshotProvider = new FileSystemSnapshotProvider({
    rootDir: join(workspace, "snapshots"),
    createId,
    now: () => 1 as never,
  });
  const toolExecutor = new ToolExecutor({
    registry,
    events: { publish: (event) => store.append(event) },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    snapshotProvider,
    createId,
    now: () => 1 as never,
    maxResultOutputBytes: 8_192,
  });
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor,
    createId,
    now: () => 1 as never,
    ...options,
  });
  return { runtime, store };
}

function registerTools(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool());
  registry.register(createGitDiffTool());
  registry.register(createToolSearchTool(registry));
  return registry;
}

function idFactory(): (prefix: string) => string {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

async function runCli(args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "cli", "--", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    assert.equal(
      code,
      0,
      [
        timedOut ? `CLI timed out after ${timeoutMs}ms` : `CLI exited with code ${code}`,
        `args: ${args.join(" ")}`,
        "stdout:",
        stdout,
        "stderr:",
        stderr,
      ].join("\n"),
    );
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function withTempWorkspace<T>(prefix: string, run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  let keep = keepWorkspaces;
  try {
    return await run(workspace);
  } catch (error) {
    keep = true;
    const err = toError(error);
    err.message = `${err.message}\nfixture workspace kept at ${workspace}`;
    throw err;
  } finally {
    if (keep) {
      if (keepWorkspaces) console.log(`[debug] kept fixture workspace: ${workspace}`);
    } else {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

function completedToolNames(events: readonly EventLike[]): string[] {
  const calls = new Map<string, string>();
  const completed: string[] = [];
  for (const event of events) {
    const payload = asRecord(event.payload);
    const callId = typeof payload.callId === "string" ? payload.callId : undefined;
    if (!callId) continue;
    if (event.type === "tool.call_started" && typeof payload.toolName === "string") {
      calls.set(callId, payload.toolName);
    }
    if (event.type === "tool.call_finished" && payload.status === "completed") {
      const name = calls.get(callId);
      if (name) completed.push(name);
    }
  }
  return completed;
}

function assertToolsCompleted(events: readonly EventLike[], expected: readonly string[]): void {
  const completed = completedToolNames(events);
  for (const name of expected) {
    assert.ok(completed.includes(name), `missing completed tool ${name}; completed=${completed.join(", ")}`);
  }
}

function toolOutputIncludes(events: readonly EventLike[], toolName: string, text: string): boolean {
  const calls = new Map<string, string>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const callId = typeof payload.callId === "string" ? payload.callId : undefined;
    if (!callId) continue;
    if (event.type === "tool.call_started" && typeof payload.toolName === "string") {
      calls.set(callId, payload.toolName);
      continue;
    }
    if (event.type === "tool.call_finished" && payload.status === "completed" && calls.get(callId) === toolName) {
      return typeof payload.output === "string" && payload.output.includes(text);
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatError(error: Error): string {
  return error.stack ?? error.message;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
