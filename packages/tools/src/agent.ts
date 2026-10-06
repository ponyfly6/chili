import type { RuntimeSessionInput } from "@chili/protocol";
import type { ChiliToolExecutionContext } from "./types.js";

export interface AgentSpawnToolInput { name: string; prompt: string; cwd?: string; }
export interface AgentTargetToolInput { agentId: string; }
export interface AgentSendToolInput extends AgentTargetToolInput { text: string; mode?: "queue" | "steer"; }
export interface AgentWaitToolInput extends AgentTargetToolInput { inputId: string; timeoutMs?: number; }
export type AgentListToolInput = Record<string, never>;
export type AgentStopToolInput = AgentTargetToolInput;
export type AgentResumeToolInput = AgentTargetToolInput;
export type AgentInputToolRecord = RuntimeSessionInput;

export interface AgentToolRecord {
  agentId: string;
  name: string;
  path: string;
  parentAgentId?: string;
  state: "idle" | "running" | "paused";
}

export interface AgentInputToolReceipt { agentId: string; inputId: string; }
export interface AgentWaitToolResult { input: RuntimeSessionInput; result?: unknown; timedOut: boolean; }

/** The host binds caller identity and authority from the execution context. */
export interface AgentToolController {
  spawnAgent(input: AgentSpawnToolInput, context: ChiliToolExecutionContext): Promise<AgentInputToolReceipt>;
  sendAgent(input: AgentSendToolInput, context: ChiliToolExecutionContext): Promise<AgentInputToolReceipt>;
  waitAgent(input: AgentWaitToolInput, context: ChiliToolExecutionContext): Promise<AgentWaitToolResult>;
  stopAgent(input: AgentStopToolInput, context: ChiliToolExecutionContext): Promise<AgentTargetToolInput>;
  resumeAgent(input: AgentResumeToolInput, context: ChiliToolExecutionContext): Promise<AgentTargetToolInput & { inputId?: string }>;
  listAgents(input: AgentListToolInput, context: ChiliToolExecutionContext): Promise<AgentToolRecord[]>;
}
