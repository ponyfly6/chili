import type { ToolExecutionContext } from "@chili/protocol";

export type SubagentTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type CompleteTaskStatus = "completed" | "failed" | "cancelled";

export interface TaskToolInput {
  description: string;
  prompt: string;
  mode?: string;
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

export type SubagentToolContext = ToolExecutionContext;

export interface SubagentController {
  spawnTask(input: TaskToolInput, context: SubagentToolContext): Promise<SubagentTaskHandle>;
  completeTask(input: CompleteTaskToolInput, context: SubagentToolContext): Promise<SubagentTaskCompletion>;
}
