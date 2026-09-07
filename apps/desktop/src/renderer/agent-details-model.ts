import type {
  RuntimeAgentMailboxRecord,
  RuntimeAgentRunRecord,
  RuntimeAgentTaskRecord,
  RuntimeAgentTreeNode,
  RuntimeAgentTreeSnapshot,
} from "@chili/sdk";

export const AGENT_TEXT_LIMIT = 24_000;
export const AGENT_HISTORY_LIMIT = 20;
export const AGENT_TREE_PAGE_SIZE = 100;

export interface AgentDetailsNode {
  path: string;
  name: string;
  status: RuntimeAgentTreeNode["status"];
  children: string[];
  runs: RuntimeAgentRunRecord[];
  tasks: RuntimeAgentTaskRecord[];
  mailbox: RuntimeAgentMailboxRecord[];
  createdAt: number;
}

export interface AgentDetailsModel {
  nodes: Map<string, AgentDetailsNode>;
  roots: string[];
  counts: { total: number; running: number; pending: number; completed: number; failed: number; incomplete: number; cancelled: number };
}

export function agentDetailsScopeKey(projectId: string | undefined, sessionId: string | undefined): string {
  return JSON.stringify([projectId ?? null, sessionId ?? null]);
}

/** Use the full snapshot without fetching histories for every delegated agent. */
export function buildAgentDetailsModel(
  tree: RuntimeAgentTreeSnapshot | undefined,
  tasks: readonly RuntimeAgentTaskRecord[] = [],
): AgentDetailsModel {
  const nodes = new Map<string, AgentDetailsNode>();
  function ensure(path: string): AgentDetailsNode {
    let node = nodes.get(path);
    if (!node) {
      node = { path, name: path.split("/").at(-1) || path, status: "empty", children: [], runs: [], tasks: [], mailbox: [], createdAt: 0 };
      nodes.set(path, node);
    }
    return node;
  }
  const queue = [...(tree?.nodes ?? [])];
  const seen = new Set<RuntimeAgentTreeNode>();
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    if (!source || seen.has(source)) continue;
    seen.add(source);
    const node = ensure(source.path);
    node.name = source.taskName || (source.path === "/root" ? "Main agent" : node.name);
    node.status = source.status;
    node.createdAt = source.createdAt;
    node.runs.push(...source.runs);
    node.tasks.push(...source.tasks);
    node.mailbox.push(...source.mailbox);
    queue.push(...source.children);
  }
  for (const run of tree?.agents ?? []) ensure(run.path).runs.push(run);
  for (const task of [...(tree?.tasks ?? []), ...tasks]) ensure(task.path).tasks.push(task);
  for (const message of tree?.mailbox ?? []) ensure(message.path).mailbox.push(message);

  const roots: string[] = [];
  const counts: AgentDetailsModel["counts"] = { total: 0, running: 0, pending: 0, completed: 0, failed: 0, incomplete: 0, cancelled: 0 };
  for (const node of nodes.values()) {
    node.tasks = newestUnique(node.tasks, (task) => task.updatedAt, (a, b) => b.updatedAt - a.updatedAt || b.generation - a.generation);
    node.runs = newestUnique(node.runs, (run) => run.completedAt ?? run.createdAt, (a, b) => b.createdAt - a.createdAt);
    node.mailbox = newestUnique(node.mailbox, (message) => message.consumedAt ?? message.createdAt, (a, b) => b.createdAt - a.createdAt);
    const task = node.tasks[0];
    const run = node.runs[0];
    // A task includes pending follow-ups and is newer than its previous run.
    const current = task && (!run || task.updatedAt >= run.createdAt) ? task : run;
    if (current) {
      node.name = current.taskName || node.name;
      node.status = current.status;
      node.createdAt = node.createdAt || current.createdAt;
      counts.total += 1;
      counts[current.status] += 1;
    }
    // Canonical path ancestry prevents malformed parent metadata creating cycles.
    const parent = nodes.get(node.path.slice(0, node.path.lastIndexOf("/")));
    if (parent) parent.children.push(node.path);
    else roots.push(node.path);
  }
  function compare(left: string, right: string): number {
    return (nodes.get(left)?.createdAt ?? 0) - (nodes.get(right)?.createdAt ?? 0) || left.localeCompare(right);
  }
  roots.sort(compare);
  for (const node of nodes.values()) node.children.sort(compare);
  return { nodes, roots, counts };
}

export function visibleAgentRows(model: AgentDetailsModel, expanded: ReadonlySet<string>): { node: AgentDetailsNode; depth: number }[] {
  const rows: { node: AgentDetailsNode; depth: number }[] = [];
  const queue = model.roots.map((path) => ({ path, depth: 0 })).reverse();
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item) continue;
    const node = model.nodes.get(item.path);
    if (!node) continue;
    rows.push({ node, depth: item.depth });
    if (expanded.has(node.path)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const path = node.children[index];
        if (path) queue.push({ path, depth: item.depth + 1 });
      }
    }
  }
  return rows;
}

export function agentStatusLabel(status: AgentDetailsNode["status"]): string {
  const labels: Record<AgentDetailsNode["status"], string> = {
    running: "Running", pending: "Pending", completed: "Completed", incomplete: "Incomplete",
    failed: "Failed", cancelled: "Cancelled", empty: "Coordinator", queued: "Message queued",
    delivering: "Delivering message", consumed: "Message delivered", discarded: "Message discarded",
  };
  return labels[status];
}

export function agentTextPreview(text: string, limit = 160): string {
  const parts: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text.trim())) {
    if (parts.length === limit) return `${parts.join("")}…`;
    parts.push(segment);
  }
  return parts.join("");
}

export function boundedAgentText(text: string, limit = AGENT_TEXT_LIMIT): { text: string; omitted: number } {
  // Avoid cutting a UTF-16 surrogate pair when enforcing the DOM text budget.
  let end = Math.min(text.length, limit);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end -= 1;
  return { text: text.slice(0, end), omitted: text.length - end };
}

export function agentTextPage(text: string, start: number, limit = AGENT_TEXT_LIMIT): { text: string; start: number; end: number; hasNext: boolean } {
  const offset = Math.min(Math.max(0, start), text.length);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let length = 0;
  for (const { segment } of segmenter.segment(text.slice(offset))) {
    if (length + segment.length > limit && length > 0) break;
    // An adversarial combining sequence can be an arbitrarily large grapheme.
    // Keep the page bounded while preserving Unicode code points in that case.
    if (segment.length > limit) {
      length = boundedAgentText(segment, limit).text.length;
      break;
    }
    length += segment.length;
    if (length >= limit) break;
  }
  const end = offset + length;
  return { text: text.slice(offset, end), start: offset, end, hasNext: end < text.length };
}

export function agentListPage<T>(items: readonly T[], requestedPage: number, size: number): { items: readonly T[]; page: number; total: number } {
  const total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(requestedPage, total - 1));
  return { items: items.slice(page * size, (page + 1) * size), page, total };
}

export function agentDuration(createdAt: number, completedAt: number | undefined, now: number): string {
  if (!Number.isFinite(createdAt) || !Number.isFinite(completedAt ?? now)) return "Unavailable";
  const seconds = Math.floor(Math.max(0, (completedAt ?? now) - createdAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`;
}

export function agentTaskRun(node: AgentDetailsNode, task: RuntimeAgentTaskRecord | undefined): RuntimeAgentRunRecord | undefined {
  if (!task) return node.runs[0];
  if (task.currentRunId) return node.runs.find((run) => run.id === task.currentRunId);
  return node.runs.find((run) => run.taskId === task.id);
}

function newestUnique<T extends { id: string }>(items: readonly T[], version: (item: T) => number, compare: (a: T, b: T) => number): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const previous = unique.get(item.id);
    if (!previous || version(item) >= version(previous)) unique.set(item.id, item);
  }
  return [...unique.values()].sort(compare);
}
