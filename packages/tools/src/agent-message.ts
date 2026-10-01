import type { AgentPath, SessionId, TaskId, ToolExecutionContext } from "@chili/protocol";

export type AgentMessageDelivery = "queueOnly" | "triggerTurn";
export type AgentMessageStatus = "queued" | "delivering" | "consumed" | "discarded";

export interface AgentMessageSendToolInput {
  messageId?: string;
  from?: string;
  to: string;
  content: string;
  delivery?: AgentMessageDelivery;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentMessageListToolInput {
  status?: AgentMessageStatus;
  taskId?: string;
  path?: string;
  from?: string;
  limit?: number;
  all?: boolean;
}

export interface AgentMessageRecord {
  messageId: string;
  fromPath: AgentPath | string;
  toPath: AgentPath | string;
  delivery: AgentMessageDelivery;
  status: AgentMessageStatus;
  taskId?: TaskId | string;
  recipientSessionId?: SessionId | string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  consumedAt?: number;
}

export type AgentMessageToolContext = ToolExecutionContext;

export interface AgentMessageToolController {
  sendAgentMessage(input: AgentMessageSendToolInput, context: AgentMessageToolContext): Promise<AgentMessageRecord>;
  listAgentMessages(input: AgentMessageListToolInput, context: AgentMessageToolContext): Promise<AgentMessageRecord[]>;
}
