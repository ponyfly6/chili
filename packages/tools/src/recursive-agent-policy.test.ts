import { expect, test } from "bun:test";
import type { SessionId, TurnId } from "@chili/protocol";
import type { AgentToolController } from "./agent.js";
import { createAgentResumeTool, createAgentSendTool, createAgentSpawnTool, createAgentStopTool } from "./builtins/agent.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBrokerRequest, ToolAccessPolicy } from "./types.js";

const calls = [
  ["agent_spawn", { name: "review", prompt: "Review the result" }],
  ["agent_send", { agentId: "child", text: "Check errors", mode: "steer" }],
  ["agent_stop", { agentId: "child" }],
  ["agent_resume", { agentId: "child" }],
] as const;

for (const code of [false, true]) {
  test(`${code ? "code mode" : "direct"} Agent writes retain caller identity, grants and approvals`, async () => {
    const f = fixture();
    for (const [name, args] of calls) {
      expect((await f.invoke(name, args, code)).status).toBe("completed");
    }
    expect(f.effects).toEqual(calls.map(([name]) => name));
    expect(f.callers).toEqual(calls.map(() => "session_parent"));
    expect(f.approvals.map(({ permission }) => permission)).toEqual(calls.map(([name]) => name));
  });

  test(`${code ? "code mode" : "direct"} cannot bypass denied Agent capabilities or approval`, async () => {
    for (const [name, args] of calls) {
      const denied = fixture({ deniedTools: [name] });
      expect((await denied.invoke(name, args, code)).status).toBe("failed");
      expect(denied.effects).toEqual([]);
      const noGrant = fixture({ allowedTools: ["read", "code_mode"] });
      expect((await noGrant.invoke(name, args, code)).status).toBe("failed");
      expect(noGrant.effects).toEqual([]);
      const deniedApproval = fixture({}, true);
      expect((await deniedApproval.invoke(name, args, code)).status).toBe("failed");
      expect(deniedApproval.effects).toEqual([]);
    }
  });
}

function fixture(overrides: ToolAccessPolicy = {}, denyApproval = false) {
  const effects: string[] = [];
  const callers: string[] = [];
  const approvals: ApprovalBrokerRequest[] = [];
  const record = (name: string, sessionId: string) => { effects.push(name); callers.push(sessionId); };
  const controller: AgentToolController = {
    async spawnAgent(_input, context) { record("agent_spawn", context.sessionId); return { agentId: "child", inputId: "input_1" }; },
    async sendAgent(_input, context) { record("agent_send", context.sessionId); return { agentId: "child", inputId: "input_2" }; },
    async stopAgent(input, context) { record("agent_stop", context.sessionId); return input; },
    async resumeAgent(input, context) { record("agent_resume", context.sessionId); return input; },
    async listAgents() { return []; },
    async waitAgent() { throw new Error("Unexpected wait"); },
  };
  const registry = new InMemoryToolRegistry();
  registry.register(createCodeModeTool());
  for (const create of [createAgentSpawnTool, createAgentSendTool, createAgentStopTool, createAgentResumeTool]) registry.register(create(controller));
  const executor = new ToolExecutor({
    registry, events: { publish: async () => undefined },
    approvals: { decide: async (request) => { approvals.push(request); return { action: denyApproval ? "deny" : "allow_once" }; } },
    policyResolver: { resolve: () => ({ allowedTools: ["code_mode", ...calls.map(([name]) => name)], writeScope: [], executeScope: [], ...overrides }) },
  });
  return { effects, callers, approvals, invoke: (name: string, args: unknown, code: boolean) => executor.execute({
    sessionId: "session_parent" as SessionId, turnId: "turn_parent" as TurnId, cwd: process.cwd(),
    toolName: code ? "code_mode" : name,
    input: code ? { code: `text(await tools[${JSON.stringify(name)}](${JSON.stringify(args)}));` } : args,
  }) };
}
