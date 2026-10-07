import type { RuntimeInputQueue, RuntimeSessionStatus } from "@chili/protocol";

export type ConversationActivityKind = "running" | "reviewing" | "question" | "stopping" | "paused" | "idle";

export interface ConversationActivity {
  kind: ConversationActivityKind;
  label: string;
  hint: string;
  queueInput: boolean;
  canStop: boolean;
}

export function conversationActivity(input: {
  status: RuntimeSessionStatus | "unknown" | undefined;
  paused: boolean;
  pendingQuestions: number;
  readOnly: boolean;
}): ConversationActivity {
  const { status, paused, pendingQuestions, readOnly } = input;
  if (readOnly) return { kind: "idle", label: "", hint: "此会话已归档，可以查看已有成果。", queueInput: false, canStop: false };
  if (status === "cancelling") return { kind: "stopping", label: "正在停止…", hint: "待处理消息会保留，停止完成后可以继续。", queueInput: true, canStop: false };
  if (paused && status !== "running" && status !== "waiting_for_approval") {
    return { kind: "paused", label: "已暂停", hint: "新消息会保留，点击继续处理后执行。", queueInput: true, canStop: false };
  }
  if (pendingQuestions > 0) return { kind: "question", label: "等你补充信息", hint: "可以先回答上面的问题，也可以停止当前处理。", queueInput: true, canStop: true };
  if (status === "waiting_for_approval") return { kind: "reviewing", label: "正在审查操作", hint: "Chili 正在根据你的权限设置检查这次操作。", queueInput: true, canStop: true };
  if (status === "running") return { kind: "running", label: "处理中", hint: "Enter 加入待处理 · 调整方向会先处理新要求", queueInput: true, canStop: true };
  return { kind: "idle", label: "", hint: "Enter 发送 · Shift + Enter 换行", queueInput: false, canStop: false };
}

export function pendingConversationInputs(queue: RuntimeInputQueue | undefined) {
  return (queue?.items ?? []).filter((input) => input.state === "pending")
    .sort((left, right) => left.sequence - right.sequence);
}
