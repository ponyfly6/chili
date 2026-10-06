import type { ChatToolCallRow, ChatToolDisplayStatus, ChatTranscriptItem } from "@chili/sdk";
import type { DesktopWorkItem } from "./view-model.js";

type WorkCategory = "read" | "edit" | "command" | "web" | "delegate" | "other";

const categories: Record<WorkCategory, { label: string; active: string }> = {
  read: { label: "读取与搜索", active: "正在查看项目内容" },
  edit: { label: "修改文件", active: "正在修改文件" },
  command: { label: "运行命令", active: "正在运行命令" },
  web: { label: "查阅资料", active: "正在查阅资料" },
  delegate: { label: "协作任务", active: "正在处理协作任务" },
  other: { label: "工具操作", active: "正在使用工具" },
};

export interface WorkStage {
  id: string;
  label: string;
  items: ChatTranscriptItem[];
  toolCount: number;
  active: boolean;
  failureCount: number;
}

export function workToolCategory(name: string): WorkCategory {
  const value = name.toLowerCase().replaceAll("-", "_");
  if (/^(read|read_file|grep|glob|search|list_directory)$/.test(value)) return "read";
  if (/^(write|write_file|edit|replace|apply_patch)$/.test(value)) return "edit";
  if (/^(bash|run_shell_command|exec_command|write_stdin)$/.test(value)) return "command";
  if (/^(web_search|search_query|web_fetch|fetch_url)$/.test(value)) return "web";
  if (/^agent_/.test(value)) return "delegate";
  return "other";
}

export function workToolTitle(tool: ChatToolCallRow): string {
  const name = tool.toolName.toLowerCase().replaceAll("-", "_");
  if (name === "read" || name === "read_file") return "读取文件";
  if (name === "glob" || name === "list_directory") return "查找文件";
  if (name === "grep" || name === "search") return "搜索内容";
  if (name === "write" || name === "write_file") return "写入文件";
  const category = workToolCategory(tool.toolName);
  if (category !== "other") return categories[category].label;
  return tool.inputSummary.title || tool.toolName;
}

export function workToolSubject(tool: ChatToolCallRow): string | undefined {
  if (tool.input && typeof tool.input === "object") {
    const description = (tool.input as Record<string, unknown>).description;
    if (typeof description === "string" && description.trim()) return description.trim();
  }
  return tool.inputSummary.path ?? tool.inputSummary.pattern ?? tool.inputSummary.scope;
}

export function workToolStatus(status: ChatToolDisplayStatus): string {
  return ({ queued: "排队中", checking: "检查中", waiting_permission: "等待授权", running: "执行中",
    succeeded: "已完成", failed: "未成功", rejected: "已拒绝", cancelled: "已取消" })[status];
}

export function workHeadline(work: DesktopWorkItem): string {
  if (work.status === "waiting") return "等待授权";
  if (work.status === "failed") return "执行未完成";
  if (work.status === "cancelled") return "已停止";
  if (!work.active) return work.failureCount > 0 ? "处理结束" : "已完成";
  const activeTools = work.items.filter((item): item is ChatToolCallRow => item.kind === "tool" && isActiveTool(item));
  if (activeTools.some((tool) => tool.toolName === "request_user_input")) return "等待你的回复";
  const latest = activeTools.at(-1);
  if (latest) return `${categories[workToolCategory(latest.toolName)].active}${activeTools.length > 1 ? ` · ${activeTools.length} 项并行` : ""}`;
  const last = work.items.at(-1);
  return last?.kind === "message" && last.parts.some((part) => part.type === "reasoning")
    ? "正在思考" : "正在整理结果";
}

export function workCurrentDetail(work: DesktopWorkItem): string | undefined {
  const active = work.items.findLast((item) => item.kind === "tool" && isActiveTool(item));
  if (active?.kind === "tool") return workToolSubject(active);
  return undefined;
}

/** Consecutive tools of the same kind form a stage; notes stay in their original order. */
export function workStages(work: DesktopWorkItem): WorkStage[] {
  const stages: WorkStage[] = [];
  let category: WorkCategory | undefined;
  for (const item of work.items) {
    const nextCategory = item.kind === "tool" ? workToolCategory(item.toolName) : undefined;
    let stage = stages.at(-1);
    if (!stage || (nextCategory && category && nextCategory !== category)) {
      stage = { id: `${item.kind}:${item.id}`, label: "思考与说明", items: [], toolCount: 0, active: false, failureCount: 0 };
      stages.push(stage);
      category = undefined;
    }
    if (nextCategory) {
      category = nextCategory;
      stage.label = categories[nextCategory].label;
    }
    stage.items.push(item);
    if (item.kind === "tool") {
      stage.toolCount += 1;
      stage.active ||= work.active && isActiveTool(item);
      if (item.displayStatus === "failed" || item.displayStatus === "rejected") stage.failureCount += 1;
    }
  }
  if (work.active && stages.length > 0 && !stages.some((stage) => stage.active)) stages[stages.length - 1]!.active = true;
  return stages;
}

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ""}`;
}

function isActiveTool(tool: ChatToolCallRow): boolean {
  return ["queued", "checking", "waiting_permission", "running"].includes(tool.displayStatus);
}
