import { expect, test } from "bun:test";
import type { SessionId, TurnId } from "@chili/protocol";
import type { AgentMessageSendToolInput, AgentMessageToolController } from "./agent-message.js";
import {
  createAgentResumeTool,
  createAgentSendTool,
  createAgentSpawnTool,
  createAgentStopTool,
} from "./builtins/agent.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { SubagentController, SubagentControlController } from "./subagent.js";
import type {
  ApprovalBrokerRequest,
  ChiliToolDefinition,
  ExecuteToolInput,
  ExecuteToolResult,
  ToolAccessPolicy,
} from "./types.js";

const lifecycleCalls = [
  ["agent_spawn", { description: "inspect", prompt: "inspect the child task", mode: "background" }],
  ["agent_stop", { taskId: "child_task" }],
  ["agent_resume", { taskId: "child_task", prompt: "continue inspection" }],
] as const;
const scopedPolicy: ToolAccessPolicy = {
  allowedTools: ["agent_spawn", "agent_stop", "agent_resume", "agent_send", "code_mode"],
  memberPath: "/root/parent",
  writeScope: [],
  executeScope: [],
};

test("explicitly granted agent lifecycle tools run without shell scope and retain task approvals", async () => {
  const { executor, effects, approvals } = fixture();
  for (const [name, args] of lifecycleCalls) {
    expect((await executor.execute(input(name, args))).status).toBe("completed");
  }
  expect(effects).toEqual(["spawn", "stop", "resume"]);
  expect(approvals.map((request) => [request.toolName, request.permission, request.patterns])).toEqual([
    ["agent_spawn", "task", ["spawn"]],
    ["agent_stop", "task", ["child_task"]],
    ["agent_resume", "task", ["child_task"]],
  ]);
});

test("agent lifecycle exemption does not create worker grants or override root delegation denials", async () => {
  for (const [name, args] of lifecycleCalls) {
    const missingGrant = fixture();
    expectFailure(await missingGrant.executor.execute(input(name, args, {
      ...scopedPolicy, allowedTools: ["agent_send"],
    })), "not allowed");
    expect(missingGrant.effects).toEqual([]);
    expect(missingGrant.approvals).toEqual([]);

    const overlay = fixture({ resolvedPolicy: () => ({ deniedTools: [name] }) });
    expectFailure(await overlay.executor.execute(input(name, args)), "not allowed");
    expect(overlay.effects).toEqual([]);
    expect(overlay.approvals).toEqual([]);
  }

  for (const [name, legacy, args] of [
    ["agent_spawn", "task", lifecycleCalls[0][1]],
    ["agent_stop", "task_close", lifecycleCalls[1][1]],
    ["agent_resume", "task_followup", lifecycleCalls[2][1]],
  ] as const) {
    const legacyDeny = fixture({ resolvedPolicy: () => ({ deniedTools: [legacy] }) });
    expectFailure(await legacyDeny.executor.execute(input(name, args)), "not allowed");
    expect(legacyDeny.effects).toEqual([]);
  }
});

test("agent lifecycle controls still require an allowed task approval", async () => {
  const { executor, effects, approvals } = fixture({ denyApproval: true });
  for (const [name, args] of lifecycleCalls) {
    expectFailure(await executor.execute(input(name, args)), "task approval denied");
  }
  expect(effects).toEqual([]);
  expect(approvals).toHaveLength(3);
  expect(approvals.every((request) => request.permission === "task")).toBe(true);
});

test("execute scope exemption requires the canonical internal agent lifecycle definition", async () => {
  for (const definition of [
    { name: "agent_spawn", resourcePolicy: "process" as const },
    { name: "agent_resume", resourcePolicy: "filesystem" as const },
    { name: "agent_stop" },
    { name: "internal_executor", resourcePolicy: "internal" as const },
    { name: "pretend_agent", aliases: ["agent_spawn"], resourcePolicy: "internal" as const },
  ]) {
    let executed = false;
    const candidate: ChiliToolDefinition = {
      ...definition,
      description: "Exercise trusted tool classification",
      risk: "execute",
      inputSchema: { type: "object" },
      approval: () => ({ permission: "task", patterns: ["spawn"] }),
      execute: async () => { executed = true; return { title: "execute", output: "done" }; },
    };
    const { executor, registry } = fixture();
    for (const alias of candidate.aliases ?? []) registry.unregister(alias);
    registry.register(candidate, { replace: true });
    const result = await executor.execute(input(candidate.name, {}, {
      ...scopedPolicy, allowedTools: [candidate.name],
    }));
    expect(result.status).toBe("failed");
    expect(executed).toBe(false);
  }
});

test("scoped code mode composes granted agent controls while preserving the caller identity", async () => {
  const { executor, effects, callerSessions, approvals } = fixture();
  const result = await executor.execute(input("code_mode", {
    code: `const spawned = await tools.agent_spawn({description: "inspect", prompt: "inspect", mode: "background"});
      const taskId = spawned.structuredData.task_id;
      await tools.agent_stop({taskId});
      const resumed = await tools.agent_resume({taskId});
      text(resumed.structuredData.status);`,
  }));
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(result.result.output).toContain("running");
  expect(effects).toEqual(["spawn", "stop", "resume"]);
  expect(callerSessions).toEqual(["session_scoped_parent", "session_scoped_parent", "session_scoped_parent"]);
  expect(approvals.map((request) => request.permission)).toEqual(["task", "task", "task"]);
});

test("code mode cannot invoke agent lifecycle tools after a root policy revocation during approval", async () => {
  let revoked = false;
  const { executor, effects, approvals } = fixture({
    resolvedPolicy: () => revoked ? { deniedTools: ["agent_spawn"] } : undefined,
    onApproval: () => { revoked = true; },
  });
  expectFailure(await executor.execute(input("code_mode", {
    code: `await tools.agent_spawn({description: "inspect", prompt: "inspect", mode: "background"});`,
  })), "not allowed");
  expect(effects).toEqual([]);
  expect(approvals.map((request) => request.toolName)).toEqual(["agent_spawn"]);
});

test("recursive scoped agents cannot impersonate their parent or message unrelated branches", async () => {
  for (const useCodeMode of [false, true]) {
    const { executor, sentMessages } = fixture();
    const invoke = (args: AgentMessageSendToolInput) => executor.execute(useCodeMode
      ? input("code_mode", { code: `await tools.agent_send(${JSON.stringify(args)});` })
      : input("agent_send", args));
    expectFailure(await invoke({ from: "/root", to: "parent", content: "forged parent" }), "sender must match");
    expectFailure(await invoke({ to: "/root/sibling", content: "cross branch" }), "parent or descendants");
    expectFailure(await invoke({ to: "/root/parent-other/child", content: "prefix collision" }), "parent or descendants");
    expect(sentMessages).toEqual([]);
    for (const to of ["parent", "/root", "/root/parent/child"]) {
      expect((await invoke({ from: "/root/parent", to, content: "authorized" })).status).toBe("completed");
    }
    expect(sentMessages.map((message) => message.to)).toEqual(["parent", "/root", "/root/parent/child"]);
  }
});

function fixture(options: {
  denyApproval?: boolean;
  resolvedPolicy?: () => ToolAccessPolicy | undefined;
  onApproval?: () => void;
} = {}) {
  const effects: string[] = [];
  const callerSessions: string[] = [];
  const approvals: ApprovalBrokerRequest[] = [];
  const sentMessages: AgentMessageSendToolInput[] = [];
  const record = (status: "running" | "cancelled") => ({ taskId: "child_task", status, summary: status, mode: "background" });
  const spawn: SubagentController = {
    spawnTask: async (_args, context) => {
      effects.push("spawn"); callerSessions.push(context.sessionId); return record("running");
    },
    completeTask: async (args) => ({ taskId: args.taskId, summary: args.summary, status: args.status ?? "completed" }),
  };
  const lifecycle: SubagentControlController = {
    listTasks: async () => [],
    waitTask: async () => record("running"),
    waitTasks: async () => ({ waitFor: "all", satisfied: false, timedOut: true, tasks: [] }),
    followupTask: async (_args, context) => {
      effects.push("resume"); callerSessions.push(context.sessionId); return record("running");
    },
    closeTask: async (_args, context) => {
      effects.push("stop"); callerSessions.push(context.sessionId); return record("cancelled");
    },
    listMailbox: async () => [],
    consumeMailbox: async () => { throw new Error("Unused mailbox operation"); },
  };
  const messages: AgentMessageToolController = {
    sendAgentMessage: async (args) => {
      sentMessages.push(args);
      return { messageId: "message_child", fromPath: "/root/parent", toPath: args.to, delivery: "queueOnly", status: "queued" };
    },
    listAgentMessages: async () => [],
  };
  const registry = new InMemoryToolRegistry();
  for (const tool of [
    createAgentSpawnTool(spawn, lifecycle), createAgentStopTool(lifecycle), createAgentResumeTool(lifecycle),
    createAgentSendTool(messages), createCodeModeTool(),
  ]) registry.register(tool);
  const executor = new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    ...(options.resolvedPolicy ? { policyResolver: { resolve: options.resolvedPolicy } } : {}),
    approvals: { decide: async (request) => {
      approvals.push(request);
      options.onApproval?.();
      return options.denyApproval ? { action: "deny", feedback: "task approval denied" } : { action: "allow_once" };
    } },
  });
  return { executor, registry, effects, callerSessions, approvals, sentMessages };
}

function input(toolName: string, args: unknown, policy = scopedPolicy): ExecuteToolInput {
  return {
    sessionId: "session_scoped_parent" as SessionId,
    turnId: "turn_scoped_parent" as TurnId,
    cwd: process.cwd(), toolName, input: args, policy,
  };
}

function expectFailure(result: ExecuteToolResult, message: string): void {
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain(message);
}
