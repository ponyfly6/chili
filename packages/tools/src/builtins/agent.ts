import type { ToolResult } from "@chili/protocol";
import type { AgentListToolInput, AgentSendToolInput, AgentSpawnToolInput, AgentTargetToolInput, AgentToolController, AgentWaitToolInput } from "../agent.js";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

const identifier = { type: "string", minLength: 1 };
const receiptSchema = {
  type: "object", required: ["agentId", "inputId"], additionalProperties: false,
  properties: { agentId: identifier, inputId: identifier },
};
const targetSchema = {
  type: "object", required: ["agentId"], additionalProperties: false,
  properties: { agentId: identifier },
};

export function createAgentSpawnTool(controller: AgentToolController): ChiliToolDefinition<AgentSpawnToolInput> {
  return {
    name: "agent_spawn",
    description: "Create one agent and enqueue its first input. Returns agentId and inputId immediately; use agent_wait for that input's result. Use separate calls, optionally Promise.all in code_mode, to create several agents. Agents retain their identity and history after each input completes.",
    resourcePolicy: "internal", risk: "write", codeMode: true, isConcurrencySafe: true,
    inputSchema: {
      type: "object", required: ["name", "prompt"], additionalProperties: false,
      properties: { name: { ...identifier, pattern: "^[a-zA-Z0-9_-]+$", description: "One agent path segment: letters, digits, hyphens, or underscores." }, prompt: identifier, cwd: identifier },
    },
    outputSchema: receiptSchema,
    validate(input) {
      const checked = strings<AgentSpawnToolInput>(input, ["name", "prompt"], ["cwd"]);
      if (!checked.ok) return checked;
      if (!/^[a-zA-Z0-9_-]+$/u.test(checked.value.name)) return { ok: false, message: "name must contain only letters, digits, hyphens, or underscores" };
      return checked;
    },
    approval: () => ({ permission: "agent_spawn", patterns: ["*"] }),
    async execute(input, context) { return result("agent_spawn", await controller.spawnAgent(input, context)); },
  };
}

export function createAgentSendTool(controller: AgentToolController): ChiliToolDefinition<AgentSendToolInput> {
  return {
    name: "agent_send",
    description: "Submit an input to an agent in the same root hierarchy, including a peer or parent, and return a stable inputId. The receiver sees trusted sender identity with the text. mode=queue (default) queues work; mode=steer redirects active work through the same input queue. An idle agent may run queued input; a paused agent stays paused until agent_resume.",
    resourcePolicy: "internal", risk: "write", codeMode: true, isConcurrencySafe: true,
    inputSchema: {
      type: "object", required: ["agentId", "text"], additionalProperties: false,
      properties: { agentId: identifier, text: identifier, mode: { type: "string", enum: ["queue", "steer"], default: "queue" } },
    },
    outputSchema: receiptSchema,
    validate(input) {
      const checked = strings<AgentSendToolInput>(input, ["agentId", "text"], ["mode"]);
      if (!checked.ok) return checked;
      if (checked.value.mode !== undefined && checked.value.mode !== "queue" && checked.value.mode !== "steer") return { ok: false, message: "mode must be queue or steer" };
      return checked;
    },
    approval: (input) => ({ permission: "agent_send", patterns: [input.agentId] }),
    async execute(input, context) { return result("agent_send", await controller.sendAgent(input, context)); },
  };
}

export function createAgentWaitTool(controller: AgentToolController): ChiliToolDefinition<AgentWaitToolInput> {
  return {
    name: "agent_wait",
    description: "Wait for the receipt of one specific input in the same root hierarchy, identified by agentId and inputId. Returns the input, its result when available, and timedOut. A timeout ends only this wait and never cancels the input or pauses its agent. Use the same IDs to wait again.",
    resourcePolicy: "internal", risk: "read", codeMode: true, isReadOnly: true, isConcurrencySafe: true,
    inputSchema: {
      type: "object", required: ["agentId", "inputId"], additionalProperties: false,
      properties: { agentId: identifier, inputId: identifier, timeoutMs: { type: "integer", minimum: 0, maximum: 60000, default: 30000, description: "Milliseconds to wait; 0 returns the current receipt immediately." } },
    },
    outputSchema: {
      type: "object", required: ["input", "timedOut"], additionalProperties: false,
      properties: {
        input: { type: "object", required: ["inputId", "sessionId", "state"], properties: {
          inputId: identifier, sessionId: identifier, state: { type: "string", enum: ["pending", "claimed", "settled"] },
          outcome: { type: "string", enum: ["completed", "failed", "cancelled", "interrupted"] },
        } },
        result: {}, timedOut: { type: "boolean" },
      },
    },
    validate(input) {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const { timeoutMs, ...rest } = input;
      const checked = strings<Omit<AgentWaitToolInput, "timeoutMs">>(rest, ["agentId", "inputId"]);
      if (!checked.ok) return checked;
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000)) return { ok: false, message: "timeoutMs must be an integer between 0 and 60000" };
      return { ok: true, value: { ...checked.value, ...(timeoutMs === undefined ? {} : { timeoutMs }) } };
    },
    approval: () => false,
    async execute(input, context) { return result("agent_wait", await controller.waitAgent(input, context)); },
  };
}

export function createAgentStopTool(controller: AgentToolController): ChiliToolDefinition<AgentTargetToolInput> {
  return {
    name: "agent_stop",
    description: "Persistently pause a descendant agent's scheduling and cancel its current activation. Keeps its identity, history, and queued inputs. Repeated stops are safe. Use agent_resume to allow this same agent to run again.",
    resourcePolicy: "internal", risk: "write", codeMode: true, isConcurrencySafe: true,
    inputSchema: targetSchema, outputSchema: targetSchema,
    validate: (input) => strings<AgentTargetToolInput>(input, ["agentId"]),
    approval: (input) => ({ permission: "agent_stop", patterns: [input.agentId] }),
    async execute(input, context) { return result("agent_stop", await controller.stopAgent(input, context)); },
  };
}

export function createAgentResumeTool(controller: AgentToolController): ChiliToolDefinition<AgentTargetToolInput> {
  return {
    name: "agent_resume",
    description: "Unpause a descendant agent and allow its queued or interrupted work to continue under the same identity. Returns agentId and an inputId when work is resumed. Does not create another agent. Submit new instructions with agent_send.",
    resourcePolicy: "internal", risk: "write", codeMode: true, isConcurrencySafe: true,
    inputSchema: targetSchema,
    outputSchema: { ...targetSchema, properties: { agentId: identifier, inputId: identifier } },
    validate: (input) => strings<AgentTargetToolInput>(input, ["agentId"]),
    approval: (input) => ({ permission: "agent_resume", patterns: [input.agentId] }),
    async execute(input, context) { return result("agent_resume", await controller.resumeAgent(input, context)); },
  };
}

export function createAgentListTool(controller: AgentToolController): ChiliToolDefinition<AgentListToolInput> {
  return {
    name: "agent_list",
    description: "List every agent in this caller's root hierarchy, including the root and caller itself, with stable identities, names, paths, parents, and idle/running/paused state. Other roots are inaccessible.",
    resourcePolicy: "internal", risk: "read", codeMode: true, isReadOnly: true, isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object", required: ["agents"], additionalProperties: false,
      properties: { agents: { type: "array", items: {
        type: "object", required: ["agentId", "name", "path", "state"], additionalProperties: false,
        properties: { agentId: identifier, name: identifier, path: identifier, parentAgentId: identifier, state: { type: "string", enum: ["idle", "running", "paused"] } },
      } } },
    },
    validate: (input) => strings<AgentListToolInput>(input === undefined ? {} : input, []),
    approval: () => false,
    async execute(input, context) { return result("agent_list", { agents: await controller.listAgents(input, context) }); },
  };
}

function result(name: string, data: unknown): ToolResult {
  return { title: name, output: JSON.stringify(data), structuredData: data };
}

function strings<T>(input: unknown, required: readonly string[], optional: readonly string[] = []): ValidationResult<T> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) return { ok: false, message: `Unsupported field: ${unexpected}` };
  for (const key of required) if (typeof input[key] !== "string" || !input[key].trim()) return { ok: false, message: `${key} must be a non-empty string` };
  for (const key of optional) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) return { ok: false, message: `${key} must be a non-empty string` };
  return { ok: true, value: { ...input } as T };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
