import {
  chatAgentBatches,
  type ChiliRuntimeView,
  type RuntimeInlineAgentBatchView,
  type RuntimeInlineAgentMessage,
  type TeamLiveView,
} from "@chili/sdk";
import type { SessionId, ThreadId } from "@chili/protocol";
import type {
  InlineAgentBatchDisplay,
  InlineAgentDisplay,
  InlineAgentMessageDisplay,
} from "./AgentBatchCells.js";

export function inlineAgentBatchDisplays(
  batches: readonly RuntimeInlineAgentBatchView[],
): InlineAgentBatchDisplay[] {
  return batches.map((batch) => ({
    id: batch.id,
    callId: batch.callId,
    ...(batch.batchId ? { batchId: batch.batchId } : {}),
    status: batch.status,
    expected: batch.expected,
    counts: { ...batch.counts },
    agents: batch.agents.map(agentDisplay),
    spawnFailures: batch.spawnFailures.map((failure, index) => ({
      id: `${batch.id}:spawn:${failure.batchIndex ?? index}`,
      name: failure.name,
      task: failure.task,
      error: failure.error,
    })),
    messages: batch.messages.map(messageDisplay),
    integration: {
      status: batch.integration.status,
      ...(batch.integration.evidence ? { summary: `evidence: ${batch.integration.evidence}` } : {}),
    },
    ...(batch.completionPolicy ? { completionPolicy: batch.completionPolicy } : {}),
    ...(batch.requestedMaxConcurrency === undefined ? {} : { requestedMaxConcurrency: batch.requestedMaxConcurrency }),
    ...(batch.observedPeakConcurrency === undefined ? {} : { observedPeakConcurrency: batch.observedPeakConcurrency }),
    ...(batch.error ? { error: batch.error } : {}),
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  }));
}

export function inlineAgentBatchesForSession(input: {
  runtimeView: ChiliRuntimeView;
  teamView: TeamLiveView;
  sessionId?: SessionId;
  threadId?: ThreadId;
  limit?: number;
}): InlineAgentBatchDisplay[] {
  if (!input.sessionId) return [];
  return [
    ...inlineAgentBatchDisplays(chatAgentBatches(input.runtimeView, {
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      limit: input.limit ?? 20,
    })),
    ...inlineTeamBatchDisplays(input.teamView, input.sessionId),
  ];
}

export function inlineTeamBatchDisplays(view: TeamLiveView, sessionId?: string): InlineAgentBatchDisplay[] {
  const selected = view.selected;
  if (!selected) return [];
  if (!sessionId) return [];
  const sessionMatches = view.scope.sessionId === sessionId
    || selected.members.some((member) => member.sessionId === sessionId && member.isLead);
  if (!sessionMatches) return [];
  const team = selected.team;
  const latestRun = [...selected.runs].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (selected.tasks.length === 0 && selected.members.length === 0 && !latestRun) return [];

  const agents: InlineAgentDisplay[] = selected.tasks.map((task) => {
    const owner = selected.members.find((member) => member.path === task.ownerPath);
    const status = teamTaskStatus(task.status, task.final);
    return {
      id: task.id,
      name: task.ownerName ?? owner?.name ?? task.ownerPath ?? "unassigned",
      task: task.title,
      status,
      ...(task.summary ? { summary: task.summary } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.dispatch?.agentStatus ? { activity: `worker: ${task.dispatch.agentStatus}` } : {}),
      messages: [],
    };
  });
  const counts = agentCounts(agents);
  const expected = agents.length;
  const status = counts.active > 0
    ? "running"
    : counts.failed + counts.incomplete + counts.cancelled > 0
      ? counts.completed > 0 ? "mixed" : counts.failed > 0 ? "failed" : counts.incomplete > 0 ? "incomplete" : "cancelled"
      : "completed";
  const teamMessageIds = new Set(selected.recentActivity
    .filter((item) => item.kind === "message" && item.teamMessageId)
    .map((item) => item.teamMessageId!));
  const messages = selected.recentActivity
    .filter((item) => (item.kind === "message" || item.kind === "mailbox")
      && !(item.kind === "mailbox" && item.teamMessageId && teamMessageIds.has(item.teamMessageId)))
    .map((item): InlineAgentMessageDisplay => ({
      id: item.id,
      from: item.from ?? team.leadPath,
      to: item.to ?? team.leadPath,
      text: item.detail ? `${item.label}: ${item.detail}` : item.label,
      ...(item.status ? { status: item.status } : {}),
      time: item.time,
      ...(item.from && item.to ? { direction: teamMessageDirection(item.from, item.to, team.leadPath) } : {}),
    }));
  const pendingMerge = selected.mergeQueue.some((merge) => merge.status === "pending" || merge.status === "conflicted" || merge.status === "failed");
  const appliedMerge = selected.mergeQueue.some((merge) => merge.status === "applied");
  const integration = appliedMerge
    ? "integrated"
    : counts.active > 0
      ? "pending"
      : pendingMerge || expected > 0
        ? "ready"
        : "pending";
  const createdAt = latestRun?.startedAt
    ?? Math.min(...selected.tasks.map((task) => task.updatedAt), team.updatedAt);

  return [{
    id: `team:${team.id}:${latestRun?.id ?? "board"}`,
    kind: "team",
    title: team.name || team.id,
    status,
    expected,
    counts,
    agents,
    spawnFailures: [],
    messages,
    integration: { status: integration },
    createdAt,
    updatedAt: Math.max(team.updatedAt, latestRun?.updatedAt ?? 0),
  }];
}

function teamMessageDirection(
  from: string,
  to: string,
  leadPath: string,
): NonNullable<InlineAgentMessageDisplay["direction"]> {
  if (from === leadPath && to !== leadPath) return "parent_to_agent";
  if (from !== leadPath && to === leadPath) return "agent_to_parent";
  if (from !== leadPath && to !== leadPath && from !== to) return "agent_to_agent";
  return "related";
}

function agentDisplay(agent: RuntimeInlineAgentBatchView["agents"][number]): InlineAgentDisplay {
  return {
    id: agent.taskId,
    name: agent.name,
    task: agent.taskPrompt ?? agent.description ?? agent.task,
    status: agent.status,
    ...(agent.summary ? { summary: agent.summary } : {}),
    ...(agent.error ? { error: agent.error } : {}),
    ...(agent.activity ? { activity: `${agent.activity.kind}: ${agent.activity.label} (${agent.activity.status})` } : {}),
    messages: agent.messages.map(messageDisplay),
    followupCount: agent.followupCount,
    turns: agent.turns,
  };
}

function messageDisplay(message: RuntimeInlineAgentMessage): InlineAgentMessageDisplay {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    text: message.text,
    status: message.status,
    time: message.time,
    direction: message.direction,
  };
}

function teamTaskStatus(status: string, final: boolean): InlineAgentDisplay["status"] {
  if (status === "completed") return "completed";
  if (status === "incomplete") return "incomplete";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "in_progress") return "running";
  return final ? "completed" : "pending";
}

function agentCounts(agents: readonly InlineAgentDisplay[]): InlineAgentBatchDisplay["counts"] {
  const count = (status: InlineAgentDisplay["status"]) => agents.filter((agent) => agent.status === status).length;
  const pending = count("pending");
  const running = count("running");
  return {
    total: agents.length,
    pending,
    running,
    active: pending + running,
    completed: count("completed"),
    incomplete: count("incomplete"),
    failed: count("failed"),
    cancelled: count("cancelled"),
  };
}
