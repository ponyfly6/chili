import {
  DELEGATION_POLICIES,
  type DelegationPolicy,
  type RuntimeDelegationConfig,
  type ToolResult,
} from "@chili/protocol";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ValidationResult } from "../types.js";

/** Delegation off blocks new work while preserving observation and stop controls. */
export const DELEGATION_OFF_DENIED_TOOL_NAMES = [
  "agent_spawn", "agent_send", "agent_resume",
] as const;

export interface DelegationToolController {
  getDelegationConfig(context: ChiliToolExecutionContext): Promise<RuntimeDelegationConfig>;
  setDelegationPolicy(
    input: DelegationSetToolInput,
    context: ChiliToolExecutionContext,
  ): Promise<RuntimeDelegationConfig>;
}

export interface DelegationSetToolInput {
  policy: DelegationPolicy;
}

export function createDelegationStatusTool(
  controller: DelegationToolController,
): ChiliToolDefinition<Record<string, never>, ToolResult> {
  return {
    name: "delegation_status",
    description:
      "Read this session's effective delegation policy and its source. This reports policy only; use agent_list to inspect agents.",
    resourcePolicy: "internal",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    alwaysLoad: true,
    inputSchema: {
      type: "object",
      properties: {},
    },
    resources: () => false,
    async execute(_input, context) {
      return delegationToolResult("delegation_status", await controller.getDelegationConfig(context));
    },
  };
}

export function createDelegationSetTool(
  controller: DelegationToolController,
): ChiliToolDefinition<DelegationSetToolInput, ToolResult> {
  return {
    name: "delegation_set",
    description: [
      "Set this session's ongoing delegation policy.",
      "Map requests such as '开启代理', '默认用代理', '以后主动委派', or '自动并行' to proactive; map requests to stop/disable agents to off; use explicit when delegation should happen only when the user asks for it.",
      "Do not change policy merely because the user asks to create several agents for the current task; under explicit policy, create those agents directly and leave policy unchanged.",
    ].join(" "),
    resourcePolicy: "internal",
    risk: "write",
    isConcurrencySafe: false,
    alwaysLoad: true,
    inputSchema: {
      type: "object",
      required: ["policy"],
      properties: {
        policy: { type: "string", enum: [...DELEGATION_POLICIES] },
      },
    },
    validate(input): ValidationResult<DelegationSetToolInput> {
      return validateDelegationSetInput(input);
    },
    resources: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { policy: input.policy } });
      return delegationToolResult(
        `delegation_set ${input.policy}`,
        await controller.setDelegationPolicy(input, context),
      );
    },
  };
}

function validateDelegationSetInput(input: unknown): ValidationResult<DelegationSetToolInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "input must be an object" };
  }
  const policy = (input as Record<string, unknown>).policy;
  if (typeof policy !== "string" || !(DELEGATION_POLICIES as readonly string[]).includes(policy)) {
    return { ok: false, message: "policy must be off, explicit, or proactive" };
  }
  return { ok: true, value: { policy: policy as DelegationPolicy } };
}

function delegationToolResult(title: string, config: RuntimeDelegationConfig): ToolResult {
  return {
    title,
    output: JSON.stringify(config, null, 2),
    metadata: {
      sessionId: config.sessionId,
      policy: config.policy,
      source: config.source,
    },
  };
}
