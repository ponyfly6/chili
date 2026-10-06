import type { RuntimeAgentRecord } from "@chili/sdk";

export const AGENT_TREE_PAGE_SIZE = 100;
export const AGENT_RECEIPT_PAGE_SIZE = 20;

export interface AgentDetailsNode extends RuntimeAgentRecord {
  children: string[];
}

export interface AgentDetailsModel {
  /** Identity, rather than a display path, owns selection and expansion. */
  nodes: Map<string, AgentDetailsNode>;
  roots: string[];
  counts: { total: number; idle: number; running: number; paused: number };
}

export function agentDetailsScopeKey(projectId: string | undefined, sessionId: string | undefined): string {
  return JSON.stringify([projectId ?? null, sessionId ?? null]);
}

/** The selected root already has its own conversation and lifecycle controls. */
export function sessionDescendantAgents(agents: readonly RuntimeAgentRecord[] | undefined, sessionId: string | undefined): RuntimeAgentRecord[] {
  return sessionId ? (agents ?? []).filter((agent) => agent.agentId !== sessionId) : [];
}

export function buildAgentDetailsModel(agents: readonly RuntimeAgentRecord[] = []): AgentDetailsModel {
  const nodes = new Map<string, AgentDetailsNode>();
  for (const agent of agents) {
    nodes.set(agent.agentId, {
      ...agent,
      name: agent.name.trim() || agent.path.split("/").at(-1) || agent.agentId,
      children: [],
    });
  }

  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.parentAgentId && node.parentAgentId !== node.agentId && nodes.has(node.parentAgentId)) {
      parents.set(node.agentId, node.parentAgentId);
    }
  }
  // Keep every identity inspectable if a partial or malformed snapshot contains a
  // parent cycle. Break one edge per cycle, independent of record arrival order.
  const visited = new Set<string>();
  for (const agentId of nodes.keys()) {
    const branch: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = agentId;
    while (current !== undefined && !visited.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        const cycleRoot = branch.slice(cycleStart).reduce((first, id) => id < first ? id : first, current);
        parents.delete(cycleRoot);
        break;
      }
      positions.set(current, branch.length);
      branch.push(current);
      current = parents.get(current);
    }
    for (const id of branch) visited.add(id);
  }

  const roots: string[] = [];
  const counts: AgentDetailsModel["counts"] = { total: nodes.size, idle: 0, running: 0, paused: 0 };
  for (const node of nodes.values()) {
    counts[node.state] += 1;
    const parentId = parents.get(node.agentId);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent) parent.children.push(node.agentId);
    else roots.push(node.agentId);
  }
  function compare(left: string, right: string): number {
    return (nodes.get(left)?.path ?? "").localeCompare(nodes.get(right)?.path ?? "") || left.localeCompare(right);
  }
  roots.sort(compare);
  for (const node of nodes.values()) node.children.sort(compare);
  return { nodes, roots, counts };
}

export function visibleAgentRows(model: AgentDetailsModel, expanded: ReadonlySet<string>): { node: AgentDetailsNode; depth: number }[] {
  const rows: { node: AgentDetailsNode; depth: number }[] = [];
  const queue = model.roots.map((agentId) => ({ agentId, depth: 0 })).reverse();
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item) continue;
    const node = model.nodes.get(item.agentId);
    if (!node) continue;
    rows.push({ node, depth: item.depth });
    if (expanded.has(node.agentId)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const agentId = node.children[index];
        if (agentId) queue.push({ agentId, depth: item.depth + 1 });
      }
    }
  }
  return rows;
}

export function agentStateLabel(state: RuntimeAgentRecord["state"]): string {
  const labels: Record<RuntimeAgentRecord["state"], string> = { idle: "Idle", running: "Running", paused: "Paused" };
  return labels[state];
}

export function agentListPage<T>(items: readonly T[], requestedPage: number, size: number): { items: readonly T[]; page: number; total: number } {
  const total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(requestedPage, total - 1));
  return { items: items.slice(page * size, (page + 1) * size), page, total };
}
