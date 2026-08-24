import type {
  AgentPath,
  TaskCompletionPolicy as ProtocolTaskCompletionPolicy,
  ToolCallId,
  ToolExecutionContext,
} from "@chili/protocol";

export type SubagentTaskStatus = "pending" | "running" | "completed" | "incomplete" | "failed" | "cancelled";

export type CompleteTaskStatus = "completed" | "incomplete" | "failed" | "cancelled";

export type SubagentMailboxStatus = "queued" | "delivering" | "consumed" | "discarded";

export type TaskCompletionPolicy = ProtocolTaskCompletionPolicy;

export type TaskWaitMode = "any" | "all";

export interface TaskToolInput {
  description: string;
  prompt: string;
  mode?: string;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  maxConcurrency?: number;
  completionPolicy?: TaskCompletionPolicy;
}

export interface TaskBatchToolInput {
  tasks: TaskToolInput[];
  maxConcurrency?: number;
  completionPolicy?: TaskCompletionPolicy;
  timeoutMs?: number;
  batchId?: string;
}

export interface CompleteTaskToolInput {
  taskId: string;
  summary: string;
  status?: CompleteTaskStatus;
}

export interface SubagentTaskHandle {
  taskId: string;
  summary: string;
  status: SubagentTaskStatus;
}

export interface SubagentTaskCompletion {
  taskId: string;
  summary: string;
  status: CompleteTaskStatus;
}

export interface SubagentTaskRecord {
  taskId: string;
  path?: AgentPath | string;
  taskName?: string;
  status: SubagentTaskStatus;
  mode?: string;
  generation?: number;
  currentRunId?: string;
  childSessionId?: string;
  childThreadId?: string;
  summary?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
}

export interface SubagentMailboxRecord {
  messageId: string;
  path: AgentPath | string;
  fromPath: AgentPath | string;
  status: SubagentMailboxStatus;
  triggerTurn: boolean;
  taskId?: string;
  childSessionId?: string;
  childThreadId?: string;
  message?: unknown;
  createdAt?: number;
  consumedAt?: number;
}

export interface TaskListToolInput {
  status?: SubagentTaskStatus;
  taskIds?: string[];
  limit?: number;
  all?: boolean;
}

export interface TaskWaitToolInput {
  taskId: string;
  timeoutMs?: number;
}

export interface TaskWaitBatchToolInput {
  taskIds: string[];
  waitFor?: TaskWaitMode;
  timeoutMs?: number;
  batchId?: string;
}

export interface SubagentTaskBatchWaitRecord {
  waitFor: TaskWaitMode;
  satisfied: boolean;
  timedOut: boolean;
  tasks: SubagentTaskRecord[];
}

export interface TaskFollowupToolInput {
  taskId: string;
  prompt: string;
  maxTurns?: number;
}

export interface TaskCloseToolInput {
  taskId: string;
  status?: CompleteTaskStatus;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

export interface MailboxListToolInput {
  status?: SubagentMailboxStatus;
  taskId?: string;
  path?: string;
  limit?: number;
  all?: boolean;
}

export interface MailboxConsumeToolInput {
  messageId: string;
}

export type SubagentToolContext = ToolExecutionContext;

export interface SubagentController {
  spawnTask(input: TaskToolInput, context: SubagentToolContext): Promise<SubagentTaskHandle>;
  completeTask(input: CompleteTaskToolInput, context: SubagentToolContext): Promise<SubagentTaskCompletion>;
}

export interface SubagentControlController {
  listTasks(input: TaskListToolInput, context: SubagentToolContext): Promise<SubagentTaskRecord[]>;
  waitTask(input: TaskWaitToolInput, context: SubagentToolContext): Promise<SubagentTaskRecord>;
  waitTasks(input: TaskWaitBatchToolInput, context: SubagentToolContext): Promise<SubagentTaskBatchWaitRecord>;
  followupTask(input: TaskFollowupToolInput, context: SubagentToolContext): Promise<SubagentTaskRecord>;
  closeTask(input: TaskCloseToolInput, context: SubagentToolContext): Promise<SubagentTaskRecord>;
  listMailbox(input: MailboxListToolInput, context: SubagentToolContext): Promise<SubagentMailboxRecord[]>;
  consumeMailbox(input: MailboxConsumeToolInput, context: SubagentToolContext): Promise<SubagentMailboxRecord>;
}
