import type { ChiliEvent, HistoryMessage, HistoryPart, HistoryTool } from "@chili/protocol";

export function isProcessPart(part: HistoryPart): boolean {
  return part.process === true || Boolean(part.callId) || part.type === "reasoning" || part.type === "compaction";
}

export interface ConversationTask { id: string; messages: HistoryMessage[] }
/** Group only the loaded page slice. A stable server anchor joins page boundaries. */
export function conversationTasks(messages: readonly HistoryMessage[]): ConversationTask[] {
  const tasks: ConversationTask[] = [];
  const seenTools = new Set<string>();
  for (const message of messages) {
    const previous = tasks.at(-1);
    const id = message.workId ?? (message.role === "user" ? message.id : previous?.id ?? message.id);
    const task = previous?.id === id ? previous : { id, messages: [] };
    if (task !== previous) tasks.push(task);
    task.messages.push({ ...message, parts: message.parts.filter((part) => {
      if (!part.callId) return true;
      if (seenTools.has(part.callId)) return false;
      seenTools.add(part.callId); return true;
    }) });
  }
  return tasks;
}

export function historyToolTitle(name: string): string {
  const labels: Record<string, string> = { read: "读取文件", read_file: "读取文件", glob: "查找文件", grep: "搜索内容", search: "搜索内容",
    write: "写入文件", write_file: "写入文件", edit: "修改文件", apply_patch: "修改文件", bash: "运行命令", exec_command: "运行命令",
    write_stdin: "查看命令进展", code_mode: "执行操作", present_file: "展示文件", web_search: "搜索资料", web_fetch: "读取网页",
    request_user_input: "等待你的回复", agent_spawn: "安排子任务", agent_send: "补充子任务", agent_wait: "等待子任务", agent_list: "查看子任务" };
  return labels[name] ?? name;
}

export function historyToolStatus(status: string): string {
  return ({ pending: "准备中", running: "执行中", waiting_for_approval: "等待审查", completed: "已完成", failed: "未成功", cancelled: "已停止", rejected: "已拒绝" } as Record<string, string>)[status] ?? status;
}

export function processSummary(parts: readonly HistoryPart[]): string {
  const tools = parts.filter((part) => part.callId);
  const active = tools.findLast((part) => part.status === "running" || part.status === "waiting_for_approval");
  if (active) return `${historyToolTitle(active.toolName ?? "tool")} · ${visibleToolSubject(active.subject) ?? historyToolStatus(active.status!)}`;
  const failures = tools.filter((part) => part.status === "failed" || part.status === "rejected").length;
  const failure = tools.findLast((part) => (part.status === "failed" || part.status === "rejected") && part.errorSummary)?.errorSummary;
  return tools.length ? `处理过程 · ${tools.length} 次操作${failures ? ` · ${failures} 次未成功${failure ? `：${failure.slice(0, 100)}` : ""}` : ""}` : parts.some((part) => part.type === "compaction") ? "整理上下文" : "思考过程";
}

export function partTool(part: HistoryPart): HistoryTool {
  return { id: part.callId!, name: part.toolName ?? "tool", status: part.status ?? "completed", startedAt: 0, updatedAt: 0,
    ...(visibleToolSubject(part.subject) ? { subject: visibleToolSubject(part.subject)! } : {}), ...(part.errorSummary ? { errorSummary: part.errorSummary } : {}) };
}

export function conversationStatusNote(events: readonly ChiliEvent[], sessionId: string | undefined, status: string | undefined, reason?: string): string | undefined {
  if (status === "failed") return reason ? `处理未完成：${reason}` : "处理未完成，可以继续发送消息。";
  if (status !== "running") return undefined;
  const compact = events.findLast((event) => event.sessionId === sessionId && ["turn.compaction_started", "turn.compaction_completed", "turn.compaction_failed"].includes(event.type));
  const turn = events.findLast((event) => event.sessionId === sessionId && event.type === "turn.started");
  return compact?.type === "turn.compaction_started" && (!turn || (turn.type === "turn.started" && turn.payload.turnId === compact.payload.turnId)) ? "正在整理上下文…" : undefined;
}

/** Keep explicitly loaded parts across live refreshes; refreshed parts win by ID. */
export function mergeHistoryParts(message: HistoryMessage, expanded?: HistoryMessage): HistoryMessage {
  if (!expanded) return message;
  const parts = new Map(expanded.parts.map((part) => [part.id, part]));
  for (const part of message.parts) parts.set(part.id, part);
  const { nextPartOffset: _next, ...rest } = message;
  const nextPartOffset = expanded.nextPartOffset ?? ((message.partCount ?? 0) > parts.size ? parts.size : undefined);
  return { ...rest, parts: [...parts.values()], ...(nextPartOffset !== undefined ? { nextPartOffset } : {}) };
}

export function visibleToolSubject(subject: string | undefined): string | undefined {
  return subject && !/^agent_[a-f\d]{16,}$/iu.test(subject) ? subject : undefined;
}
