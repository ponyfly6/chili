import type { RuntimeInputQueue, RuntimeSessionInput } from "@chili/protocol";
import type { ChiliRuntimeView, RuntimeAgentRecord, RuntimeSessionView } from "@chili/sdk";
import { buildAgentDetailsModel } from "./agent-details-model.js";
import type { DesktopWorkItem } from "./view-model.js";
import { workHeadline } from "./work-presentation.js";

export type ProgressRuntime = Pick<ChiliRuntimeView, "sessions" | "turnStatuses" | "messages">;
export type ProgressState = "running" | "queued" | "waiting" | "paused" | "completed" | "attention" | "failed" | "stopped";

export interface ProgressItem {
  id: string;
  title: string;
  state: ProgressState;
  detail: string;
  control?: "pause" | "resume";
}

export interface ProgressModelInput {
  sessionId: string | undefined;
  agents?: readonly RuntimeAgentRecord[] | undefined;
  inputQueues?: Readonly<Record<string, RuntimeInputQueue>> | undefined;
  runtime?: ProgressRuntime | undefined;
  workItems?: readonly DesktopWorkItem[] | undefined;
  pendingQuestions?: number | undefined;
}

const labels: Record<ProgressState, string> = {
  running: "进行中", queued: "等待开始", waiting: "等待后续安排", paused: "已暂停",
  completed: "已完成", attention: "需要你回应", failed: "未完成", stopped: "已停止",
};

const descriptions: Record<ProgressState, string> = {
  running: "工作正在进行，新的进展会更新在这里。",
  queued: "这项工作已安排，正在等待开始。",
  waiting: "暂时没有进行中的操作，等待后续安排。",
  paused: "工作已暂停，可以在对话中继续。",
  completed: "本轮工作已完成，结果可以在对话中查看。",
  attention: "请回到对话查看需要确认的内容。",
  failed: "这项工作未能完成，请回到对话查看详情。",
  stopped: "本轮工作已停止，已有内容保留在对话中。",
};

export function progressStateLabel(state: ProgressState): string { return labels[state]; }

/** A quiet persistent session is not evidence that its assigned work completed. */
export function buildProgressModel(input: ProgressModelInput): { primary?: ProgressItem; tasks: ProgressItem[] } {
  if (!input.sessionId) return { tasks: [] };
  const descendants = (input.agents ?? []).filter((agent) => agent.agentId !== input.sessionId);
  const tree = buildAgentDetailsModel(descendants);
  const taskStates = new Map([...tree.nodes.values()].map((agent) => [agent.agentId, sessionProgressState(input, agent.agentId, agent)]));
  const tasks = tree.roots.map((id, index): ProgressItem => {
    const root = tree.nodes.get(id)!;
    const branch: RuntimeAgentRecord[] = [];
    const pending = [id];
    while (pending.length) {
      const node = tree.nodes.get(pending.pop()!)!;
      branch.push(node);
      pending.push(...node.children);
    }
    const state = combineProgressStates(branch.map((agent) => taskStates.get(agent.agentId)!));
    const session = matchingSession(input, id);
    const queue = matchingQueue(input, id);
    const taskText = taskDisplayText(latestInput(queue)?.text) ?? latestMessageText(input, id, "user");
    const title = usefulText(session?.title, 64) ?? usefulText(taskText, 64) ?? usefulName(root) ?? `工作 ${index + 1}`;
    const result = latestMessageText(input, id, "assistant", true);
    const detail = usefulText(result, 220) ?? usefulText(taskText, 220) ?? descriptions[state];
    const control = root.state === "paused" ? "resume" : root.state === "running" ? "pause" : undefined;
    return { id, title, state, detail, ...(control ? { control } : {}) };
  });

  const root = input.agents?.find((agent) => agent.agentId === input.sessionId);
  const session = matchingSession(input, input.sessionId);
  const latest = input.workItems?.at(-1);
  // A previous turn's work must not supply the headline or completion for a new turn.
  const work = latest && (!session?.currentTurnId || !latest.turnId || latest.turnId === session.currentTurnId) ? latest : undefined;
  let state = sessionProgressState(input, input.sessionId, root);
  if ((work?.status === "waiting" || hasWaitingQuestion(work)) && !["paused", "failed", "stopped"].includes(state)) state = "attention";
  else if (state !== "paused" && state !== "queued") {
    if (work?.status === "failed") state = "failed";
    else if (work?.status === "cancelled") state = "stopped";
    else if (work?.active && (state === "waiting" || state === "completed")) state = "running";
  }
  // Historical outcomes remain in the list; only live background work can
  // change the current conversation's progress. Inspect each actual task so
  // a queued descendant is not hidden by its group's historical failure.
  const background = [...taskStates.values()].filter((taskState) => ["running", "queued", "attention"].includes(taskState));
  state = combineProgressStates([state, ...background]);
  if ((input.pendingQuestions ?? 0) > 0) state = "attention";
  const headline = state === "running" && work?.active ? workHeadline(work) : "当前工作";
  return {
    primary: { id: input.sessionId, title: headline, state, detail: descriptions[state] },
    tasks,
  };
}

function sessionProgressState(input: ProgressModelInput, id: string, agent?: RuntimeAgentRecord): ProgressState {
  const session = matchingSession(input, id);
  const queue = matchingQueue(input, id);
  if (session?.status === "waiting_for_approval") return "attention";
  if (agent?.state === "paused" || queue?.paused) return "paused";
  if (session?.status === "failed") return "failed";
  if (session?.status === "cancelled" || session?.status === "cancelling") return "stopped";
  if (agent?.state === "running" || session?.status === "running" || queue?.items.some((item) => item.state === "claimed")) return "running";
  if (queue && (queue.pendingCount > 0 || queue.items.some((item) => item.state === "pending"))) return "queued";
  const receipt = latestInput(queue);
  // Never use an older receipt to mark a newer turn finished.
  if (receipt?.state === "settled" && (!session?.currentTurnId || receipt.turnId === session.currentTurnId)) {
    if (receipt.outcome === "completed") return "completed";
    if (receipt.outcome === "failed") return "failed";
    if (receipt.outcome === "cancelled" || receipt.outcome === "interrupted") return "stopped";
  }
  const turnStatus = session?.currentTurnId ? input.runtime?.turnStatuses[session.currentTurnId] : undefined;
  if (turnStatus === "running") return "running";
  if (turnStatus === "completed" && session?.status === "idle") return "completed";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "cancelled") return "stopped";
  return "waiting";
}

function combineProgressStates(states: readonly ProgressState[]): ProgressState {
  // Keep outstanding work visible when another part has already finished.
  for (const state of ["attention", "running", "failed", "paused", "queued", "stopped", "waiting"] as const) {
    if (states.includes(state)) return state;
  }
  return states.length ? "completed" : "waiting";
}

function matchingSession(input: ProgressModelInput, id: string): RuntimeSessionView | undefined {
  const session = input.runtime?.sessions[id];
  return session?.id === id ? session : undefined;
}

function matchingQueue(input: ProgressModelInput, id: string): RuntimeInputQueue | undefined {
  const queue = input.inputQueues?.[id] ?? matchingSession(input, id)?.inputQueue;
  return queue?.sessionId === id ? queue : undefined;
}

function latestInput(queue: RuntimeInputQueue | undefined): RuntimeSessionInput | undefined {
  return queue?.items.reduce<RuntimeSessionInput | undefined>((latest, item) => !latest || item.sequence > latest.sequence ? item : latest, undefined);
}

function latestMessageText(input: ProgressModelInput, id: string, role: "user" | "assistant", currentTurnOnly = false): string | undefined {
  const session = matchingSession(input, id);
  if (!session || !input.runtime || (currentTurnOnly && !session.currentTurnId)) return undefined;
  for (let index = session.messageIds.length - 1; index >= 0; index -= 1) {
    const messageId = session.messageIds[index];
    const message = messageId ? input.runtime.messages[messageId] : undefined;
    if (!message || message.sessionId !== id || message.role !== role
      || (currentTurnOnly && (message.turnId !== session.currentTurnId || message.completedAt === undefined))) continue;
    const text = message.parts.flatMap((part) => part.type === "text"
      && (role !== "assistant" || part.phase !== "commentary") ? [part.text] : []).join("\n");
    if (usefulText(text, 220)) return text;
  }
  return undefined;
}

function usefulName(agent: RuntimeAgentRecord): string | undefined {
  if (agent.name === agent.agentId || agent.name === agent.path) return undefined;
  return usefulText(agent.name.replace(/[-_]+/gu, " "), 64);
}

/** Short plain prose only; paths and internal identity strings are not task summaries. */
function usefulText(value: string | undefined, limit: number): string | undefined {
  const display = taskDisplayText(value);
  if (!display) return undefined;
  const text = display.slice(0, 8_000)
    .replace(/```[\s\S]*?(?:```|$)/gu, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/^[\s#>*\-]+/gmu, "")
    .replace(/[`*_]/gu, "")
    .split(/\n/gu).map((line) => line.trim()).find((line) => line.length > 0);
  if (!text || /^(?:[A-Za-z]:[\\/]|\/|\.\.?\/|agent[_-][a-f\d]{8}|session[_-][a-f\d]{8})/iu.test(text)) return undefined;
  const sentence = text.split(/(?<=[。！？])\s*/u)[0] ?? text;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

/** Decode the runtime's attribution envelope only as display data. Sender
 * identity and wrapper prose never become a task title or description. */
function taskDisplayText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (/^Agent message\b/iu.test(text)) {
      const newline = text.indexOf("\n");
      // Automatic session titles can be truncated in the middle of the header.
      if (newline < 0 || text.length > 512_000) return undefined;
      try {
        const envelope: unknown = JSON.parse(text.slice(newline + 1));
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
          || !("text" in envelope) || typeof envelope.text !== "string") return undefined;
        text = envelope.text.trim();
      } catch { return undefined; }
      continue;
    }
    if (/^\[Agent\b/iu.test(text)) {
      const prefix = /^\[Agent [^\]\r\n]+\]\s*/iu.exec(text);
      if (!prefix) return undefined;
      text = text.slice(prefix[0].length).trim();
      continue;
    }
    return text || undefined;
  }
  return undefined;
}

function hasWaitingQuestion(work: DesktopWorkItem | undefined): boolean {
  return Boolean(work?.active && work.items.some((item) => item.kind === "tool" && item.toolName === "request_user_input"
    && ["queued", "checking", "waiting_permission", "running"].includes(item.displayStatus)));
}
