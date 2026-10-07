import { expect, test } from "bun:test";
import type { ChiliEvent, RuntimeSessionInput, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import type {
  AgentInputToolReceipt,
  AgentListToolInput,
  AgentSendToolInput,
  AgentSpawnToolInput,
  AgentTargetToolInput,
  AgentToolController,
  AgentToolRecord,
  AgentWaitToolInput,
  AgentWaitToolResult,
} from "./agent.js";
import {
  createAgentListTool,
  createAgentResumeTool,
  createAgentSendTool,
  createAgentSpawnTool,
  createAgentStopTool,
  createAgentWaitTool,
} from "./builtins/agent.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ToolReviewRequest, ChiliToolExecutionContext, ExecuteToolInput, ExecuteToolResult } from "./types.js";

const AGENT_NAMES = ["agent_list", "agent_resume", "agent_send", "agent_spawn", "agent_stop", "agent_wait"];

test("the registry exposes six strict Agent contracts and code mode without legacy aliases", () => {
  const { registry } = setup();
  expect(registry.list().map((tool) => tool.name).sort()).toEqual([...AGENT_NAMES, "code_mode"]);
  for (const name of AGENT_NAMES) {
    const tool = registry.get(name)!;
    expect(tool.aliases).toBeUndefined();
    expect(tool.codeMode).toBe(true);
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool.outputSchema).toBeDefined();
  }
});

test("legacy fields and invalid input values fail before the controller or reviews run", async () => {
  const { executor, controller, reviews } = setup();
  const cases: Array<[string, unknown]> = [
    ["agent_spawn", { name: "review", prompt: "Inspect", taskId: "old" }],
    ["agent_spawn", { name: "review", prompt: "Inspect", mode: "background" }],
    ["agent_spawn", { name: "review", prompt: "Inspect", tasks: [{ name: "nested", prompt: "Inspect" }] }],
    ["agent_spawn", { description: "review", prompt: "Inspect" }],
    ["agent_spawn", { name: "review", prompt: "Inspect", completionPolicy: "join" }],
    ["agent_spawn", { name: " ", prompt: "Inspect" }],
    ["agent_spawn", { name: "review/files", prompt: "Inspect" }],
    ["agent_spawn", { name: "review files", prompt: "Inspect" }],
    ["agent_spawn", { name: "review", prompt: "" }],
    ["agent_spawn", { name: "review", prompt: "Inspect", cwd: 42 }],
    ["agent_spawn", []],
    ["agent_send", { agentId: "agent_1", text: "Inspect", taskId: "old" }],
    ["agent_send", { agentId: "agent_1", text: "Inspect", mode: "triggerTurn" }],
    ["agent_send", { agentId: "agent_1", text: "Inspect", delivery: "queueOnly" }],
    ["agent_send", { to: "agent_1", content: "Inspect" }],
    ["agent_wait", { taskId: "old" }],
    ["agent_wait", { agentId: "agent_1" }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", taskIds: ["old"] }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", waitFor: "any" }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", timeoutMs: -1 }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", timeoutMs: 60001 }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", timeoutMs: 1.5 }],
    ["agent_wait", { agentId: "agent_1", inputId: "input_1", timeoutMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["agent_stop", { taskId: "old" }],
    ["agent_stop", { agentId: "agent_1", summary: "done" }],
    ["agent_resume", { taskId: "old" }],
    ["agent_resume", { agentId: "agent_1", prompt: "Continue" }],
    ["agent_list", { taskIds: ["old"] }],
    ["agent_list", { view: "messages" }],
    ["agent_list", { all: true }],
    ["agent_list", null],
  ];
  for (const [name, args] of cases) {
    const result = await executor.execute(input(name, args));
    if (result.status !== "failed") throw new Error(`Expected invalid input for ${name}: ${JSON.stringify(args)}`);
    expect(result.error.name).toBe("ToolValidationError");
  }
  expect(controller.calls).toEqual([]);
  expect(reviews).toEqual([]);
});

test("removed task, Team and completion tools are unknown calls", async () => {
  const { executor, registry, controller } = setup();
  for (const name of ["task", "task_batch", "task_wait", "task_followup", "task_close", "agent_message_send", "complete_task", "team_create"]) {
    expect(registry.get(name)).toBeUndefined();
    const result = await executor.execute(input(name, {}));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(`Expected unknown tool: ${name}`);
    expect(result.error.name).toBe("UnknownToolError");
  }
  expect(controller.calls).toEqual([]);
});

test("spawn returns an admitted input receipt without waiting for the Agent to complete", async () => {
  const { executor, controller } = setup();
  const args = { name: "review", prompt: "Inspect imports", cwd: "/workspace/review" };
  const spawned = completed(await executor.execute(input("agent_spawn", args)));
  expect(spawned.structuredData).toEqual({ agentId: "agent_1", inputId: "input_1" });
  expect(controller.spawnInputs).toEqual([args]);
  expect(controller.inputs.get("input_1")).toMatchObject({ state: "pending", mode: "start", text: "Inspect imports" });
  expect(controller.calls).toEqual(["spawn"]);
  expect(controller.contexts[0]).toMatchObject({ sessionId: "session_agents", turnId: "turn_agents", cwd: process.cwd() });
  await expect(executor.canRunConcurrently("agent_spawn", args)).resolves.toBe(true);
});

test("send preserves queue and steer inputs and returns a separate receipt for each", async () => {
  const { executor, controller } = setup();
  const sends = [
    { agentId: "agent_1", text: "First input" },
    { agentId: "agent_1", text: "Next input", mode: "queue" as const },
    { agentId: "agent_1", text: "Change direction", mode: "steer" as const },
  ];
  const receipts = [];
  for (const args of sends) receipts.push(completed(await executor.execute(input("agent_send", args))).structuredData);
  expect(receipts).toEqual([
    { agentId: "agent_1", inputId: "input_1" },
    { agentId: "agent_1", inputId: "input_2" },
    { agentId: "agent_1", inputId: "input_3" },
  ]);
  expect(controller.sendInputs).toEqual(sends);
  expect([...controller.inputs.values()].map((record) => record.mode)).toEqual(["queue", "queue", "steer"]);
  expect(controller.calls).toEqual(["send", "send", "send"]);
});

test("wait timeouts preserve the specific receipt and never invoke stop or resume", async () => {
  const { executor, controller } = setup();
  const receipt = completed(await executor.execute(input("agent_spawn", { name: "review", prompt: "Inspect" }))).structuredData as AgentInputToolReceipt;
  const pending = { ...controller.inputs.get(receipt.inputId)! };
  const args = { ...receipt, timeoutMs: 0 };
  const timedOut = completed(await executor.execute(input("agent_wait", args)));
  expect(timedOut.structuredData).toEqual({ input: pending, timedOut: true });
  expect(controller.inputs.get(receipt.inputId)).toEqual(pending);

  const settled: RuntimeSessionInput = { ...pending, state: "settled", outcome: "completed", revision: 2 };
  controller.inputs.set(receipt.inputId, settled);
  const finished = completed(await executor.execute(input("agent_wait", args)));
  expect(finished.structuredData).toEqual({ input: settled, result: { summary: "Completed: Inspect" }, timedOut: false });
  expect(controller.waitInputs).toEqual([args, args]);
  expect(controller.calls).toEqual(["spawn", "wait", "wait"]);
});

test("stop and resume target the same identity and preserve an optional resumed input receipt", async () => {
  const { executor, controller } = setup();
  const target = { agentId: "agent_existing" };
  controller.resumedInputId = "input_interrupted";
  expect(completed(await executor.execute(input("agent_stop", target))).structuredData).toEqual(target);
  expect(completed(await executor.execute(input("agent_stop", target))).structuredData).toEqual(target);
  expect(completed(await executor.execute(input("agent_resume", target))).structuredData).toEqual({ ...target, inputId: "input_interrupted" });
  controller.resumedInputId = undefined;
  expect(completed(await executor.execute(input("agent_resume", target))).structuredData).toEqual(target);
  expect(controller.stopInputs).toEqual([target, target]);
  expect(controller.resumeInputs).toEqual([target, target]);
  expect(controller.calls).toEqual(["stop", "stop", "resume", "resume"]);
});

test("list preserves visible hierarchy identities and idle, running and paused states", async () => {
  const { executor, controller } = setup();
  controller.agents = [
    { agentId: "root", name: "root", path: "/root", state: "idle" },
    { agentId: "review", name: "review", path: "/root/review", parentAgentId: "root", state: "running" },
    { agentId: "verify", name: "verify", path: "/root/review/verify", parentAgentId: "review", state: "paused" },
  ];
  const listed = completed(await executor.execute(input("agent_list", {})));
  expect(listed.structuredData).toEqual({ agents: controller.agents });
  expect(controller.listInputs).toEqual([{}]);
  expect(controller.contexts[0]!.sessionId).toBe("session_agents" as SessionId);
});

test("all Agent operations enter the execution gate with their tool identity", async () => {
  const { executor, reviews } = setup();
  completed(await executor.execute(input("agent_spawn", { name: "review", prompt: "Inspect" })));
  completed(await executor.execute(input("agent_send", { agentId: "agent_1", text: "Verify" })));
  completed(await executor.execute(input("agent_stop", { agentId: "agent_1" })));
  completed(await executor.execute(input("agent_resume", { agentId: "agent_1" })));
  completed(await executor.execute(input("agent_wait", { agentId: "agent_1", inputId: "input_1", timeoutMs: 1 })));
  completed(await executor.execute(input("agent_list", {})));
  expect(reviews.map(({ toolName, risk }) => ({ toolName, risk }))).toEqual([
    { toolName: "agent_spawn", risk: "write" },
    { toolName: "agent_send", risk: "write" },
    { toolName: "agent_stop", risk: "write" },
    { toolName: "agent_resume", risk: "write" },
    { toolName: "agent_wait", risk: "read" },
    { toolName: "agent_list", risk: "read" },
  ]);
});

test("code mode composes parallel spawn calls and waits on their structured input receipts", async () => {
  const { executor, controller, events, reviews } = setup();
  controller.completeWaits = true;
  const script = completed(await executor.execute(input("code_mode", {
    code: `
      const receipts = await Promise.all([
        {name:"imports", prompt:"Inspect imports"},
        {name:"coverage", prompt:"Inspect coverage"},
      ].map(async (work) => (await tools.agent_spawn(work)).structuredData));
      const results = await Promise.all(receipts.map(async (receipt) =>
        (await tools.agent_wait({...receipt, timeoutMs:100})).structuredData));
      text({receipts, results});
    `,
  })));
  const parsed = JSON.parse(script.output);
  expect(parsed.receipts).toEqual([
    { agentId: "agent_1", inputId: "input_1" },
    { agentId: "agent_2", inputId: "input_2" },
  ]);
  expect(parsed.results).toMatchObject([
    { input: { inputId: "input_1", sessionId: "agent_1", state: "settled", outcome: "completed" }, result: { summary: "Completed: Inspect imports" }, timedOut: false },
    { input: { inputId: "input_2", sessionId: "agent_2", state: "settled", outcome: "completed" }, result: { summary: "Completed: Inspect coverage" }, timedOut: false },
  ]);
  expect(controller.waitInputs).toEqual(parsed.receipts.map((receipt: AgentInputToolReceipt) => ({ ...receipt, timeoutMs: 100 })));
  const starts = events.filter((event) => event.type === "tool.call_started");
  const outer = starts.find((event) => event.payload.toolName === "code_mode")!;
  const nested = starts.filter((event) => event.payload.parentCallId === outer.payload.callId);
  expect(nested.map((event) => event.payload.toolName).sort()).toEqual(["agent_spawn", "agent_spawn", "agent_wait", "agent_wait"]);
  expect(new Set(nested.map((event) => event.payload.callId)).size).toBe(4);
  expect(reviews.map((request) => request.toolName)).toEqual(["code_mode", "agent_spawn", "agent_spawn", "agent_wait", "agent_wait"]);
});

function completed(result: ExecuteToolResult) {
  if (result.status !== "completed") throw result.error;
  if (result.result.structuredData !== undefined) expect(JSON.parse(result.result.output)).toEqual(result.result.structuredData);
  return result.result;
}

function setup() {
  const controller = new FakeController();
  const registry = new InMemoryToolRegistry();
  const reviews: ToolReviewRequest[] = [];
  const events: ChiliEvent[] = [];
  for (const tool of [
    createAgentSpawnTool(controller), createAgentListTool(controller), createAgentSendTool(controller),
    createAgentWaitTool(controller), createAgentStopTool(controller), createAgentResumeTool(controller), createCodeModeTool(),
  ]) registry.register(tool);
  let nextId = 0;
  const executor = new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    gate: { review: async (request) => { reviews.push(request); return { decision: "allow" }; } },
    createId: (prefix) => `${prefix}_${++nextId}`,
    now: () => 1 as TimestampMs,
  });
  return { controller, registry, executor, reviews, events };
}

class FakeController implements AgentToolController {
  calls: string[] = [];
  contexts: ChiliToolExecutionContext[] = [];
  spawnInputs: AgentSpawnToolInput[] = [];
  sendInputs: AgentSendToolInput[] = [];
  waitInputs: AgentWaitToolInput[] = [];
  stopInputs: AgentTargetToolInput[] = [];
  resumeInputs: AgentTargetToolInput[] = [];
  listInputs: AgentListToolInput[] = [];
  inputs = new Map<string, RuntimeSessionInput>();
  agents: AgentToolRecord[] = [];
  resumedInputId: string | undefined;
  completeWaits = false;

  async spawnAgent(args: AgentSpawnToolInput, context: ChiliToolExecutionContext) {
    this.record("spawn", context);
    this.spawnInputs.push(args);
    return this.admit(`agent_${this.spawnInputs.length}`, args.prompt, "start");
  }
  async sendAgent(args: AgentSendToolInput, context: ChiliToolExecutionContext) {
    this.record("send", context);
    this.sendInputs.push(args);
    return this.admit(args.agentId, args.text, args.mode ?? "queue");
  }
  async waitAgent(args: AgentWaitToolInput, context: ChiliToolExecutionContext): Promise<AgentWaitToolResult> {
    this.record("wait", context);
    this.waitInputs.push(args);
    const stored = this.inputs.get(args.inputId);
    if (!stored || stored.sessionId !== args.agentId) throw new Error("Unknown input receipt");
    const record: RuntimeSessionInput = this.completeWaits ? { ...stored, state: "settled", outcome: "completed" } : { ...stored };
    return record.state === "settled"
      ? { input: record, result: { summary: `Completed: ${record.text}` }, timedOut: false }
      : { input: record, timedOut: true };
  }
  async stopAgent(args: AgentTargetToolInput, context: ChiliToolExecutionContext) {
    this.record("stop", context);
    this.stopInputs.push(args);
    return { ...args };
  }
  async resumeAgent(args: AgentTargetToolInput, context: ChiliToolExecutionContext) {
    this.record("resume", context);
    this.resumeInputs.push(args);
    return { ...args, ...(this.resumedInputId === undefined ? {} : { inputId: this.resumedInputId }) };
  }
  async listAgents(args: AgentListToolInput, context: ChiliToolExecutionContext) {
    this.record("list", context);
    this.listInputs.push(args);
    return this.agents;
  }
  private record(method: string, context: ChiliToolExecutionContext) {
    this.calls.push(method);
    this.contexts.push(context);
  }
  private admit(agentId: string, text: string, mode: RuntimeSessionInput["mode"]): AgentInputToolReceipt {
    const sequence = this.inputs.size + 1;
    const inputId = `input_${sequence}`;
    this.inputs.set(inputId, {
      inputId, submissionId: `submission_${sequence}`, sessionId: agentId as SessionId,
      mode, state: "pending", revision: 1, sequence, text, acceptedAt: 1, updatedAt: 1,
    });
    return { agentId, inputId };
  }
}

function input(toolName: string, args: unknown): ExecuteToolInput {
  return { sessionId: "session_agents" as SessionId, turnId: "turn_agents" as TurnId, cwd: process.cwd(), toolName, input: args };
}
