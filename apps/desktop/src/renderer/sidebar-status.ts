import type { RuntimeSessionStatus } from "@chili/protocol";

export interface SessionActivityInput {
  status?: RuntimeSessionStatus | "unknown";
  pendingInput?: boolean;
  queuedCount?: number;
  paused?: boolean;
  archived?: boolean;
}

export interface SessionActivity {
  label: string;
  description: string;
  tone: "working" | "attention" | "quiet";
}

/** Show only known activity; an idle conversation does not need a badge. */
export function sessionActivity(input: SessionActivityInput): SessionActivity | undefined {
  if (input.archived) return undefined;
  const queuedCount = Math.max(0, Math.floor(input.queuedCount ?? 0));
  const waiting = queuedCount > 0 ? `，还有 ${queuedCount} 条消息待处理` : "";
  if (input.status === "cancelling") {
    return { label: "正在停止", description: `正在停止处理${waiting}`, tone: "quiet" };
  }
  if (input.pendingInput) {
    return { label: "待补充", description: `需要你补充信息${waiting}`, tone: "attention" };
  }
  if (input.status === "waiting_for_approval") {
    return { label: "审查中", description: `正在自动审查操作${waiting}`, tone: "working" };
  }
  if (input.status === "running") {
    return { label: "处理中", description: `正在处理${waiting}`, tone: "working" };
  }
  if (input.paused) {
    return { label: "已暂停", description: `已暂停，可继续处理${waiting}`, tone: "quiet" };
  }
  if (input.status === "failed") {
    return { label: "未完成", description: `这次处理未完成${waiting}`, tone: "attention" };
  }
  if (queuedCount > 0) {
    return { label: `待处理 ${queuedCount}`, description: `${queuedCount} 条消息待处理`, tone: "quiet" };
  }
  return undefined;
}
