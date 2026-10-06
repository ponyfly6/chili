import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, ToolCallId, TurnId } from "@chili/protocol";
import type { PermissionRule } from "@chili/policy";
import { PolicyApprovalBroker, PolicyApprovalState } from "./approval.js";
import { createEditTool } from "./builtins/edit.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { ToolExecutor } from "./executor.js";
import { FileReadStateStore } from "./file-read-state.js";
import { withFileOperationLocks } from "./file-operation-lock.js";
import { InMemoryToolRegistry } from "./registry.js";
import { FileSystemSnapshotProvider } from "./snapshot.js";
import type { ApprovalPreflightRequest, ChiliToolDefinition, ToolExecutorOptions } from "./types.js";

function request(cwd?: string, sessionId = "s"): ApprovalPreflightRequest {
  return {
    sessionId: sessionId as SessionId, callId: "call" as ToolCallId,
    toolName: "write", risk: "write", permission: "write", patterns: ["file.txt"],
    ...(cwd ? { workspaceRoot: cwd } : {}),
  };
}

async function workspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "chili-authorization-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function executorFor(tool: ChiliToolDefinition, options: Omit<ToolExecutorOptions, "registry" | "events"> & Pick<Partial<ToolExecutorOptions>, "events">): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  return new ToolExecutor({ registry, events: { publish: async () => {} }, ...options });
}

function executeWrite(executor: ToolExecutor, cwd: string) {
  return executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId,
    toolName: "write", input: { filePath: "file.txt", content: "after" } });
}

test("a preflight decision and its revision describe the same single ruleset read", async () => {
  const allowed: PermissionRule[] = [{ permission: "write", pattern: "*", action: "allow" }];
  const denied: PermissionRule[] = [{ permission: "write", pattern: "*", action: "deny" }];
  let loads = 0;
  const broker = new PolicyApprovalBroker({ rulesetsForRequest: () => [++loads === 1 ? allowed : denied] });
  const first = await broker.preflight(request());
  expect(loads).toBe(1);
  expect(first).toEqual(await new PolicyApprovalBroker({ rulesets: [allowed] }).preflight(request()));
  const second = await broker.preflight(request());
  expect(loads).toBe(2);
  expect(second).toEqual(await new PolicyApprovalBroker({ rulesets: [denied] }).preflight(request()));
  expect(first.revision).not.toBe(second.revision);
});

test("snapshot file checks and decisions retain copied rules until the next capture", async () => workspace(async (cwd) => {
  const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
  let loads = 0;
  const broker = new PolicyApprovalBroker({ rulesetsForRequest: () => { loads++; return [rules]; } });
  const snapshot = await broker.capturePolicy(request(cwd));
  const original = await snapshot.preflight();
  rules[0]!.action = "deny";
  expect(await snapshot.preflight()).toEqual(original);
  await snapshot.assertFileResourceAccess(["file.txt"], "write");
  expect(await snapshot.resourceDenials()).toBeUndefined();
  expect(loads).toBe(1);
  expect((await broker.preflight(request(cwd))).action).toBe("deny");
  await expect(broker.assertFileResourceAccess(request(cwd), ["file.txt"], "write")).rejects.toThrow("denied");
}));

test("grant revocation invalidates fresh captures without mutating a captured decision", async () => {
  const state = new PolicyApprovalState();
  state.addSessionGrant({ sessionId: "s" as SessionId, permission: "write", patterns: ["*"], source: "test" });
  const broker = new PolicyApprovalBroker({ state });
  const snapshot = await broker.capturePolicy(request());
  const allowed = await snapshot.preflight();
  state.revokeSessionGrants("s" as SessionId);
  expect(await snapshot.preflight()).toEqual(allowed);
  const current = await broker.preflight(request());
  expect(allowed.action).toBe("allow");
  expect(current.action).toBe("ask");
  expect(current.revision).not.toBe(allowed.revision);
});

test("concurrent captures keep session and workspace rules separate", async () => workspace(async (cwd) => {
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const broker = new PolicyApprovalBroker({ rulesetsForRequest: async (req) => {
    if (req.sessionId === "s") await waiting;
    return [[{ permission: "write", pattern: "*", action: req.workspaceRoot === cwd && req.sessionId === "s" ? "allow" : "deny" }]];
  } });
  await mkdir(join(cwd, "other"));
  const first = broker.capturePolicy(request(cwd));
  const second = await broker.capturePolicy(request(join(cwd, "other"), "other"));
  resume();
  expect((await (await first).preflight()).action).toBe("allow");
  expect(await second.preflight()).toMatchObject({ action: "deny", source: "policy_rule" });
}));

for (const toolName of ["edit", "write"] as const) {
  test(`${toolName} with a real backup has bounded rule reads and still modifies the file`, async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "file.txt"), "before");
    const fileReads = new FileReadStateStore();
    await fileReads.forSession("s").recordTextRead(cwd, join(cwd, "file.txt"), "before");
    let loads = 0;
    const approvals = new PolicyApprovalBroker({ rulesetsForRequest: () => {
      loads++;
      return [[{ permission: "*", pattern: "*", action: "allow" }]];
    } });
    const executor = executorFor(toolName === "edit" ? createEditTool() : createWriteFileTool(), {
      approvals, fileReadState: fileReads, snapshotProvider: new FileSystemSnapshotProvider(),
    });
    const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName,
      input: toolName === "edit" ? { filePath: "file.txt", oldString: "before", newString: "after" }
        : { filePath: "file.txt", content: "after" },
    });
    expect(result.status).toBe("completed");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after");
    // The audited baseline performed 23 / 26 Host ruleset resolutions.
    expect(loads).toBeLessThanOrEqual(8);
  }));
}

for (const action of ["allow_once", "allow_session", "allow_always"] as const) {
  test(`revocation during file approval defeats ${action} without saving a grant or changing the file`, async () => workspace(async (cwd) => {
    const path = join(cwd, "file.txt");
    await writeFile(path, "before");
    const fileReads = new FileReadStateStore();
    await fileReads.forSession("s").recordTextRead(cwd, path, "before");
    const rules: PermissionRule[] = [];
    let approved = 0;
    const approvals = new PolicyApprovalBroker({ rulesetsForRequest: () => [rules],
      ask: async () => {
        rules.push({ permission: "write", pattern: "*", action: "deny" });
        return { action };
      },
      onApproved: async (_request, decision) => { approved++; return decision; },
    });
    const executor = executorFor(createWriteFileTool(), { approvals, fileReadState: fileReads });
    expect((await executeWrite(executor, cwd)).status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("before");
    expect(approved).toBe(0);
    rules.length = 0;
    expect((await approvals.preflight(request(cwd))).action).toBe("ask");
  }));
}

test("revocation after execution entry while a real file lock is held prevents writing", async () => workspace(async (cwd) => {
  const path = join(cwd, "file.txt");
  await writeFile(path, "before");
  const fileReads = new FileReadStateStore();
  await fileReads.forSession("s").recordTextRead(cwd, path, "before");
  const rules: PermissionRule[] = [{ permission: "write", pattern: "*", action: "allow" }];
  let release!: () => void;
  let locked!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { locked = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const unlock = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([path], new AbortController().signal, async () => { locked(); await unlock; });
  await held;
  const write = createWriteFileTool();
  const executor = executorFor({ ...write, execute: async (input, context) => {
    entered();
    return write.execute(input, context);
  } }, { fileReadState: fileReads, approvals: new PolicyApprovalBroker({ rulesetsForRequest: () => [rules] }) });
  const result = executeWrite(executor, cwd);
  try {
    await entry;
    rules[0]!.action = "deny";
  } finally { release(); await holder; }
  expect((await result).status).toBe("failed");
  expect(await readFile(path, "utf8")).toBe("before");
}));

test("unavailable rules fail closed at a later execution boundary", async () => workspace(async (cwd) => {
  let available = true;
  let executed = false;
  const executor = executorFor({ name: "effect", description: "effect", risk: "write", inputSchema: {},
    execute: async () => { executed = true; return { title: "effect", output: "effect" }; },
  }, {
    approvals: new PolicyApprovalBroker({ rulesetsForRequest: () => {
      if (!available) throw new Error("policy unavailable");
      return [[{ permission: "*", pattern: "*", action: "allow" }]];
    } }),
    events: { publish: async (event) => {
      if (event.type === "tool.call_updated" && event.payload.status === "running") available = false;
    } },
  });
  const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName: "effect", input: {} });
  expect(result.status).toBe("failed");
  expect(executed).toBe(false);
}));

test("the executor retains the approval's policy version instead of rebinding it after an awaited reply", async () => workspace(async (cwd) => {
  const path = join(cwd, "file.txt");
  await writeFile(path, "before");
  const fileReads = new FileReadStateStore();
  await fileReads.forSession("s").recordTextRead(cwd, path, "before");
  const rules: PermissionRule[] = [];
  class ChangingBroker extends PolicyApprovalBroker {
    override async resolve(...args: Parameters<PolicyApprovalBroker["resolve"]>) {
      const resolution = await super.resolve(...args);
      // Still ASK for this file, but an older one-shot approval cannot acquire
      // this newer policy version merely by crossing the async broker boundary.
      rules.push({ permission: "write", pattern: "file.txt", action: "ask", source: "new policy" });
      return resolution;
    }
  }
  const approvals = new ChangingBroker({ rulesetsForRequest: () => [rules], ask: async () => ({ action: "allow_once" }) });
  const executor = executorFor(createWriteFileTool(), { approvals, fileReadState: fileReads });
  const result = await executeWrite(executor, cwd);
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Permission authority changed");
  expect(await readFile(path, "utf8")).toBe("before");
}));

test("an approval persistence hook cannot silently rebind a one-shot decision to changed rules", async () => {
  const rules: PermissionRule[] = [];
  const broker = new PolicyApprovalBroker({ rulesetsForRequest: () => [rules],
    ask: async () => ({ action: "allow_once" }),
    onApproved: async (_request, decision) => {
      rules.push({ permission: "write", pattern: "*", action: "ask", source: "changed" });
      return decision;
    },
  });
  const decision = await broker.decide({ ...request(), approvalId: "approval" as import("@chili/protocol").ApprovalId });
  expect(decision.action).toBe("deny");
});

test("worker validation and its backend scope use a copied policy and detect later narrowing", async () => workspace(async (cwd) => {
  const policy = { writeScope: ["*"], executeScope: ["pwd"] };
  let executed = false;
  const tool: ChiliToolDefinition = {
    name: "effect", description: "effect", risk: "execute", resourcePolicy: "process", inputSchema: {},
    isConcurrencySafe: false,
    isReadOnly: async () => { policy.writeScope.length = 0; return false; },
    approval: () => ({ permission: "bash", patterns: ["pwd"] }),
    execute: async () => { executed = true; return { title: "effect", output: "effect" }; },
  };
  const executor = executorFor(tool, {
    approvals: new PolicyApprovalBroker({ rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]] }),
    policyResolver: { resolve: () => policy },
  });
  const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName: "effect", input: {} });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Execution resource scope changed");
  expect(executed).toBe(false);
}));
