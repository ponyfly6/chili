import { expect, test } from "bun:test";
import { access, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, SessionId, SnapshotId, TimestampMs, TurnId } from "@chili/protocol";
import type { PermissionRule } from "@chili/policy";
import { PolicyApprovalBroker, PolicyApprovalState } from "./approval.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { createBashTool } from "./builtins/bash.js";
import { createMacOsSeatbeltBashRunner } from "./macos-seatbelt.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { FileReadStateStore } from "./file-read-state.js";
import type { ChiliToolDefinition, ExecuteToolInput, ToolExecutorOptions } from "./types.js";

async function workspaceTest(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "chili-foundation-contract-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function input(cwd: string, toolName: string, args: unknown): ExecuteToolInput {
  return { cwd, toolName, input: args, sessionId: "s" as SessionId, turnId: "t" as TurnId };
}

function fixture(definition: ChiliToolDefinition, options: Partial<ToolExecutorOptions> = {}) {
  const registry = new InMemoryToolRegistry();
  registry.register(definition);
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined },
    approvals: new PolicyApprovalBroker({ rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]] }),
    ...options,
  });
  return { registry, executor };
}

function effectTool(execute: ChiliToolDefinition["execute"]): ChiliToolDefinition {
  return { name: "effect", description: "Controlled test side effect", risk: "write", inputSchema: { type: "object" }, execute };
}

test("file deny covers relative, dot, absolute and symlink spellings before the real read", async () => workspaceTest(async (cwd) => {
  await writeFile(join(cwd, "blocked.txt"), "never expose this");
  await symlink("blocked.txt", join(cwd, "alias.txt"));
  await symlink("blocked.txt", join(cwd, "alias*"));
  await symlink("blocked.txt", join(cwd, "alias?"));
  await symlink("blocked.txt", join(cwd, "alias[0]"));
  for (const deniedPath of ["blocked.txt", "./blocked.txt", join(cwd, "blocked.txt"), "alias.txt", "alias*", "alias?", "alias[0]"]) {
    const { executor } = fixture(createReadFileTool(), { approvals: new PolicyApprovalBroker({ rulesets: [[
      { permission: "read", pattern: "*", action: "allow" },
      { permission: `read(${deniedPath})`, pattern: "*", action: "deny" },
    ]] }) });
    for (const filePath of ["blocked.txt", "./blocked.txt", join(cwd, "blocked.txt"), "alias.txt", "alias*", "alias?", "alias[0]"]) {
      expect((await executor.execute(input(cwd, "read", { filePath }))).status).toBe("failed");
    }
  }
  await link(join(cwd, "blocked.txt"), join(cwd, "hardlink.txt"));
  const { executor } = fixture(createReadFileTool());
  const result = await executor.execute(input(cwd, "read", { filePath: "hardlink.txt" }));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("multi-link");
}));

test("interactive file grants bind the workspace and literal stars cannot become reusable wildcards", async () => workspaceTest(async (cwd) => {
  let asks = 0;
  const approvals = new PolicyApprovalBroker({
    rulesets: [[{ permission: "read", pattern: "*", action: "ask" }]],
    ask: async () => { asks++; return { action: "allow_session" }; },
  });
  const { executor } = fixture(createReadFileTool(), { approvals });
  await writeFile(join(cwd, "same.txt"), "a");
  expect((await executor.execute(input(cwd, "read", { filePath: "same.txt" }))).status).toBe("completed");
  expect((await executor.execute(input(cwd, "read", { filePath: "./same.txt" }))).status).toBe("completed");
  expect(asks).toBe(1);
  await workspaceTest(async (other) => {
    await writeFile(join(other, "same.txt"), "b");
    expect((await executor.execute(input(other, "read", { filePath: "same.txt" }))).status).toBe("completed");
    expect(asks).toBe(2);
  });
  await writeFile(join(cwd, "literal*"), "star");
  const rejected = await executor.execute(input(cwd, "read", { filePath: "literal*" }));
  expect(rejected.status).toBe("failed");
  if (rejected.status === "failed") expect(rejected.error.message).toContain("scope");
}));

test("async JSON Schema extensions fail before handlers and never create an unhandled validation promise", async () => workspaceTest(async (cwd) => {
  let calls = 0;
  const { executor } = fixture({
    ...effectTool(async () => { calls++; return { title: "ok", output: "ok" }; }),
    inputSchema: { $async: true, type: "object", required: ["mustExist"] },
  });
  const result = await executor.execute(input(cwd, "effect", {}));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Asynchronous");
  expect(calls).toBe(0);
}));

test("execute scope compares the whole command and never approves a compound prefix", async () => workspaceTest(async (cwd) => {
  const commands: string[] = [];
  const { executor } = fixture(createBashTool({ runner: {
    supportsExecutionPolicy: true,
    run: async (request) => {
      commands.push(request.command);
      expect(request.executionPolicy).toEqual({ executeScope: ["pwd"], writeScope: [] });
      return { exitCode: 0, signal: null, stdout: cwd, stderr: "", stdoutBytes: cwd.length, stderrBytes: 0,
        stdoutTruncated: false, stderrTruncated: false, outputLimitBytes: request.maxOutputBytes,
        durationMs: 0, timedOut: false, aborted: false, sandbox: "macos-seatbelt" };
    },
  } }), { policyResolver: { resolve: () => ({ allowedTools: ["bash"], executeScope: ["pwd"], writeScope: [] }) } });
  for (const command of ["pwd ; printf marker", "pwd && printf marker", "pwd $(printf marker)", "pwd > output.txt", "pwd -L"]) {
    expect((await executor.execute(input(cwd, "bash", { command }))).status).toBe("failed");
  }
  expect(commands).toEqual([]);
  expect((await executor.execute(input(cwd, "bash", { command: "pwd" }))).status).toBe("completed");
  expect(commands).toEqual(["pwd"]);
}));

test("unproven tools cannot bypass scoped capabilities or a root filesystem deny", async () => workspaceTest(async (cwd) => {
  let effects = 0;
  const tool = { ...effectTool(async () => { effects++; return { title: "opaque", output: "opaque" }; }), risk: "read" as const, isReadOnly: true };
  const scoped = fixture(tool, { policyResolver: { resolve: () => ({ allowedTools: ["effect"], writeScope: [], executeScope: [] }) } });
  expect((await scoped.executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
  const root = fixture(tool, { approvals: new PolicyApprovalBroker({ rulesets: [[
    { permission: "*", pattern: "*", action: "allow" }, { permission: "read", pattern: "secret", action: "deny" },
  ]] }) });
  expect((await root.executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
  expect(effects).toBe(0);
}));

test("an unenforcing shell backend cannot receive an invocation when file resources are denied", async () => workspaceTest(async (cwd) => {
  let effects = 0;
  const { executor } = fixture(createBashTool({ runner: { run: async () => { effects++; throw new Error("must not run"); } } }), {
    approvals: new PolicyApprovalBroker({ rulesets: [[
      { permission: "*", pattern: "*", action: "allow" }, { permission: "read", pattern: "secret", action: "deny" },
    ]] }),
  });
  expect((await executor.execute(input(cwd, "bash", { command: "cat secret" }))).status).toBe("failed");
  expect(effects).toBe(0);
}));

const macOsTest = process.platform === "darwin" ? test : test.skip;

macOsTest("real shell backend enforces file denies through the ordinary executor", async () => workspaceTest(async (cwd) => {
  await writeFile(join(cwd, "secret"), "FAKE_PRIVATE_MARKER");
  await writeFile(join(cwd, "protected"), "original");
  const { executor } = fixture(createBashTool({ runner: createMacOsSeatbeltBashRunner() }), {
    approvals: new PolicyApprovalBroker({ rulesets: [[
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "secret", action: "deny" },
      { permission: "edit", pattern: "protected", action: "deny" },
    ]] }),
  });
  const result = await executor.execute(input(cwd, "bash", { command: "cat secret; printf changed > protected" }));
  if (result.status !== "completed") throw result.error;
  expect(result.result.output).not.toContain("FAKE_PRIVATE_MARKER");
  expect(await readFile(join(cwd, "protected"), "utf8")).toBe("original");
}));

test("file policy revoked during version validation is checked again at commit", async () => workspaceTest(async (cwd) => {
  const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
  class RevokingReads extends FileReadStateStore {
    override forSession(sessionId: string): FileReadStateStore {
      const scoped = super.forSession(sessionId);
      const assertFresh = scoped.assertFresh.bind(scoped);
      scoped.assertFresh = async (workspace, path) => {
        const version = await assertFresh(workspace, path);
        rules.push({ permission: "write", pattern: "file.txt", action: "deny" });
        return version;
      };
      return scoped;
    }
  }
  const fileReads = new RevokingReads();
  await writeFile(join(cwd, "file.txt"), "before");
  await fileReads.forSession("s").recordTextRead(cwd, join(cwd, "file.txt"), "before");
  const { executor } = fixture(createWriteFileTool(), { fileReadState: fileReads, approvals: new PolicyApprovalBroker({ rulesets: [rules] }) });
  expect((await executor.execute(input(cwd, "write", { filePath: "file.txt", content: "after" }))).status).toBe("failed");
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("before");
}));

macOsTest("metadata-time worker scope revocation never reaches OS process dispatch", async () => workspaceTest(async (cwd) => {
  const command = "printf marker > effect";
  let writeScope = ["*"];
  const { executor } = fixture(createBashTool({ runner: createMacOsSeatbeltBashRunner() }), {
    policyResolver: { resolve: () => ({ allowedTools: ["bash"], executeScope: [command], writeScope }) },
    events: { publish: async (event) => {
      if (event.type === "tool.call_updated" && event.payload.metadata?.command === command) writeScope = [];
    } },
  });
  expect((await executor.execute(input(cwd, "bash", { command }))).status).toBe("failed");
  await expect(access(join(cwd, "effect"))).rejects.toThrow();
}));

test("schema-only tools reject invalid arguments and never enter the handler", async () => workspaceTest(async (cwd) => {
  let calls = 0;
  const { executor } = fixture({
    ...effectTool(async () => { calls++; return { title: "ok", output: "ok" }; }),
    inputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 } }, additionalProperties: false },
  });
  for (const args of [{}, { count: "2" }, { count: 0 }, { count: 2, extra: true }]) {
    expect((await executor.execute(input(cwd, "effect", args))).status).toBe("failed");
  }
  expect(calls).toBe(0);
  expect((await executor.execute(input(cwd, "effect", { count: 2 }))).status).toBe("completed");
  expect(calls).toBe(1);
}));

test("preparation fixes validated scheduling arguments and rejects a replaced catalog", async () => workspaceTest(async (cwd) => {
  let validated = 0;
  let executed = 0;
  const tool: ChiliToolDefinition = {
    ...effectTool(async (args) => { executed++; expect(args.count).toBe(2); return { title: "ok", output: "ok" }; }),
    inputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
    validate: (args) => { validated++; return { ok: true, value: { count: Number((args as { alias: string }).alias) } }; },
    isConcurrencySafe: (args) => args.count === 2,
  };
  const { registry, executor } = fixture(tool);
  const request = input(cwd, "effect", { alias: "2" });
  const prepared = await executor.prepare(request);
  expect(prepared.isConcurrencySafe).toBe(true);
  expect((await executor.execute({ ...request, prepared })).status).toBe("completed");
  expect(validated).toBe(1);
  const old = await executor.prepare(request);
  registry.register({ ...tool, execute: async () => { throw new Error("replacement must not run"); } }, { replace: true });
  expect((await executor.execute({ ...request, prepared: old })).status).toBe("failed");
  expect(executed).toBe(1);
}));

test("policy changes while waiting invalidate approval before remembering a grant", async () => workspaceTest(async (cwd) => {
  let rules: PermissionRule[] = [];
  let effects = 0;
  let approve!: (value: ApprovalDecision) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const approvals = new PolicyApprovalBroker({
    rulesetsForRequest: () => [rules],
    ask: () => { started(); return new Promise((resolve) => { approve = resolve; }); },
  });
  const { executor } = fixture(effectTool(async () => { effects++; return { title: "effect", output: "effect" }; }), { approvals });
  const pending = executor.execute(input(cwd, "effect", {}));
  await waiting;
  rules = [{ permission: "effect", pattern: "*", action: "deny" }];
  approve({ action: "allow_session" });
  expect((await pending).status).toBe("failed");
  expect(effects).toBe(0);
  rules = [];
  expect((await approvals.preflight({ sessionId: "s" as SessionId, callId: "c" as import("@chili/protocol").ToolCallId, toolName: "effect", risk: "write", permission: "effect", patterns: ["*"] })).action).toBe("ask");
}));

test("revoking policy or a session grant while snapshotting prevents the effect", async () => workspaceTest(async (cwd) => {
  for (const grant of [false, true]) {
    let rules: PermissionRule[] = grant ? [] : [{ permission: "effect", pattern: "*", action: "allow" }];
    let effects = 0;
    const state = new PolicyApprovalState();
    if (grant) state.addSessionGrant({ sessionId: "s" as SessionId, permission: "effect", patterns: ["*"], source: "test" });
    const { executor } = fixture(effectTool(async () => { effects++; return { title: "effect", output: "effect" }; }), {
      approvals: new PolicyApprovalBroker({ state, rulesetsForRequest: () => [rules], ask: async () => ({ action: "deny" }) }),
      snapshotProvider: {
        create: async () => {
          rules = []; state.revokeSessionGrants("s" as SessionId);
          return { id: "snap" as SnapshotId, cwd, paths: [], createdAt: 1 as TimestampMs };
        },
        revert: async () => { throw new Error("unused"); },
      },
    });
    expect((await executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
    expect(effects).toBe(0);
  }
}));

test("latest worker policy is checked after approval and after snapshotting", async () => workspaceTest(async (cwd) => {
  let deniedTools: string[] = [];
  let calls = 0;
  const { executor } = fixture(effectTool(async () => { calls++; return { title: "ok", output: "ok" }; }), {
    policyResolver: { resolve: () => ({ deniedTools }) },
    snapshotProvider: {
      create: async () => { deniedTools = ["effect"]; return undefined; },
      revert: async () => { throw new Error("unused"); },
    },
  });
  expect((await executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
  expect(calls).toBe(0);
}));

test("lifecycle event publication cannot replace revoked approval authority", async () => workspaceTest(async (cwd) => {
  for (const at of ["approval.resolved", "tool.call_updated"] as const) {
    const state = new PolicyApprovalState();
    let effects = 0;
    let rules: PermissionRule[] = at === "tool.call_updated" ? [{ permission: "effect", pattern: "*", action: "allow" }] : [];
    const { executor } = fixture(effectTool(async () => { effects++; return { title: "effect", output: "effect" }; }), {
      approvals: new PolicyApprovalBroker({ state, rulesetsForRequest: () => [rules], ask: async () => ({ action: "allow_session" }) }),
      events: { publish: async (event) => {
        if (at === "approval.resolved" && event.type === at) state.revokeSessionGrants("s" as SessionId);
        if (at === "tool.call_updated" && event.type === at && event.payload.status === "running") {
          rules = [{ permission: "effect", pattern: "*", action: "deny" }];
        }
      } },
    });
    expect((await executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
    expect(effects).toBe(0);
  }
}));

test("an awaited grant observer cannot revoke then resurrect the approved operation", async () => workspaceTest(async (cwd) => {
  const state = new PolicyApprovalState();
  let effects = 0;
  const { executor } = fixture(effectTool(async () => { effects++; return { title: "effect", output: "effect" }; }), {
    approvals: new PolicyApprovalBroker({ state,
      ask: async () => ({ action: "allow_session" }),
      onSessionGrant: async () => state.revokeSessionGrants("s" as SessionId),
    }),
  });
  expect((await executor.execute(input(cwd, "effect", {}))).status).toBe("failed");
  expect(effects).toBe(0);
}));

test("model preview truncation leaves program data exact and oversize data fails explicitly", async () => workspaceTest(async (cwd) => {
  const structuredData = { records: Array.from({ length: 1000 }, (_, id) => ({ id, value: `value-${id}` })) };
  const { executor } = fixture(effectTool(async () => Object.freeze({ title: "data", output: "large output".repeat(1000), structuredData })), { maxResultOutputBytes: 8 });
  const result = await executor.execute(input(cwd, "effect", {}));
  if (result.status !== "completed") throw result.error;
  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.result.output).toContain("truncated");
    expect(result.result.structuredData).toEqual(structuredData);
  }
  const tooLarge = fixture(effectTool(async () => ({ title: "data", output: "preview", structuredData: "x".repeat(4 * 1024 * 1024 + 1) })));
  const failed = await tooLarge.executor.execute(input(cwd, "effect", {}));
  expect(failed.status).toBe("failed");
  if (failed.status === "failed") expect(failed.error.message).toContain("4 MiB");
}));
