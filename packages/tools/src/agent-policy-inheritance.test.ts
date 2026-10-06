import { expect, test } from "bun:test";
import type { SessionId, TurnId } from "@chili/protocol";
import type { AgentToolController } from "./agent.js";
import { createAgentSpawnTool } from "./builtins/agent.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolDefinition, ToolAccessPolicy } from "./types.js";

for (const code of [false, true]) test(`${code ? "code mode" : "direct"} spawn carries the caller's effective tool restrictions to its child`, async () => {
  let inherited: ToolAccessPolicy | undefined;
  let resourceScopes: ToolAccessPolicy | undefined;
  const controller: AgentToolController = {
    async spawnAgent(_input, context) {
      inherited = context.callerToolPolicy;
      resourceScopes = context.executionPolicy;
      return { agentId: "child", inputId: "input_child" };
    },
    async sendAgent() { throw new Error("Unexpected send"); },
    async waitAgent() { throw new Error("Unexpected wait"); },
    async stopAgent() { throw new Error("Unexpected stop"); },
    async resumeAgent() { throw new Error("Unexpected resume"); },
    async listAgents() { return []; },
  };
  const registry = new InMemoryToolRegistry();
  const effects: string[] = [];
  for (const tool of [fakeTool("read", effects), fakeTool("write", effects), fakeTool("bash", effects)]) registry.register(tool);
  registry.register(createAgentSpawnTool(controller));
  registry.register(createCodeModeTool());
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    policyResolver: { resolve: () => ({ allowedTools: ["*"], deniedTools: ["bash"], writeScope: ["*"], executeScope: ["*"] }) },
  });
  const allowedTools = ["agent_spawn", "read", ...(code ? ["code_mode"] : [])];
  const result = await executor.execute({
    ...context("parent"), toolName: code ? "code_mode" : "agent_spawn",
    input: code ? { code: 'text(await tools.agent_spawn({name:"child",prompt:"Inspect"}));' } : { name: "child", prompt: "Inspect" },
    policy: { allowedTools, deniedTools: ["write"] },
  });
  expect(result.status).toBe("completed");
  expect(inherited).toEqual({ allowedTools: [...allowedTools].sort(), deniedTools: ["bash", "write"], writeScope: ["*"], executeScope: ["*"] });
  expect(resourceScopes).toEqual({ writeScope: ["*"], executeScope: ["*"] });

  const child = new ToolExecutor({
    registry, events: { publish: async () => undefined }, approvals: { decide: async () => ({ action: "allow_once" }) },
    policyResolver: { resolve: () => inherited },
  });
  expect((await child.execute({ ...context("child"), toolName: "read", input: {} })).status).toBe("completed");
  for (const toolName of ["write", "bash"]) expect((await child.execute({ ...context("child"), toolName, input: {} })).status).toBe("failed");
  if (!code) expect((await child.execute({ ...context("child"), toolName: "code_mode", input: { code: "text(1)" } })).status).toBe("failed");
  expect(effects).toEqual(["read"]);
});

test("delegated grants intersect aliases with wildcard policies and preserve empty resource scopes", async () => {
  let inherited: ToolAccessPolicy | undefined;
  const registry = new InMemoryToolRegistry();
  registry.register({ ...fakeTool("read", []), aliases: ["read_file"] });
  registry.register({ ...fakeTool("inspect", []), execute: async (_input, context) => {
    inherited = context.callerToolPolicy;
    return { title: "inspect", output: "ok" };
  } });
  registry.register(fakeTool("write", []));
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined }, approvals: { decide: async () => ({ action: "allow_once" }) },
    policyResolver: { resolve: () => ({ allowedTools: ["*"], writeScope: [], executeScope: [] }) },
  });
  expect((await executor.execute({ ...context("parent"), toolName: "inspect", input: {}, policy: { allowedTools: ["inspect", "read_file"] } })).status).toBe("completed");
  expect(inherited).toEqual({ allowedTools: ["inspect", "read"], writeScope: [], executeScope: [] });
});

test("narrowing caller grants while an approval is pending invalidates delegated authority", async () => {
  let policy: ToolAccessPolicy = { allowedTools: ["inspect", "read", "extra"] };
  const effects: string[] = [];
  const registry = new InMemoryToolRegistry();
  registry.register({ ...fakeTool("inspect", effects), approval: () => ({ permission: "inspect", patterns: ["*"] }) });
  registry.register(fakeTool("read", effects));
  registry.register(fakeTool("extra", effects));
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined }, policyResolver: { resolve: () => policy },
    approvals: { decide: async () => { policy = { allowedTools: ["inspect", "read"] }; return { action: "allow_once" }; } },
  });
  const result = await executor.execute({ ...context("parent"), toolName: "inspect", input: {} });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("caller tool policy changed");
  expect(effects).toEqual([]);
});

test("tool-name grants do not invent resource scopes that the caller did not specify", async () => {
  let inherited: ToolAccessPolicy | undefined;
  const registry = new InMemoryToolRegistry();
  registry.register({ ...fakeTool("write", []), risk: "write", execute: async (_input, context) => {
    inherited = context.callerToolPolicy;
    expect(context.executionPolicy).toBeUndefined();
    return { title: "write", output: "ok" };
  } });
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined }, approvals: { decide: async () => ({ action: "allow_once" }) },
  });
  expect((await executor.execute({ ...context("parent"), toolName: "write", input: {}, policy: { allowedTools: ["write"] } })).status).toBe("completed");
  expect(inherited).toEqual({ allowedTools: ["write"] });
});

function fakeTool(name: string, effects: string[]): ChiliToolDefinition {
  return { name, description: name, risk: "read", resourcePolicy: "internal", codeMode: true, inputSchema: { type: "object" }, approval: () => false,
    execute: async () => { effects.push(name); return { title: name, output: "ok" }; } };
}

function context(name: string) {
  return { sessionId: `session_${name}` as SessionId, turnId: `turn_${name}` as TurnId, cwd: process.cwd() };
}
