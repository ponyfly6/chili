import type { TuiTheme } from "../theme/index.js";
import { TranscriptLines, type TranscriptLineModel, wrapLine } from "./lines.js";
import { charDisplayWidth } from "./markdown.js";

export type InlineAgentStatus = "pending" | "running" | "completed" | "incomplete" | "failed" | "cancelled";
export type InlineAgentBatchStatus = InlineAgentStatus | "mixed" | "partial";

export interface InlineAgentBatchCounts {
  total: number;
  pending: number;
  running: number;
  active: number;
  completed: number;
  incomplete: number;
  failed: number;
  cancelled: number;
}

export interface InlineAgentMessageDisplay {
  id: string;
  from: string;
  to: string;
  text: string;
  status?: string;
  time: number;
  direction?: "parent_to_agent" | "agent_to_parent" | "agent_to_agent" | "related";
}

export interface InlineAgentDisplay {
  id: string;
  name: string;
  task: string;
  status: InlineAgentStatus;
  summary?: string;
  error?: string;
  activity?: string;
  messages: InlineAgentMessageDisplay[];
  followupCount?: number;
  turns?: number;
}

export interface InlineAgentSpawnFailureDisplay {
  id: string;
  name: string;
  task: string;
  error: string;
}

export interface InlineAgentIntegrationDisplay {
  status: "pending" | "ready" | "integrating" | "responded" | "integrated" | "not_required";
  summary?: string;
}

export interface InlineAgentBatchDisplay {
  id: string;
  kind?: "ad_hoc" | "team";
  title?: string;
  callId?: string;
  batchId?: string;
  status: InlineAgentBatchStatus;
  expected: number;
  counts: InlineAgentBatchCounts;
  agents: InlineAgentDisplay[];
  spawnFailures: InlineAgentSpawnFailureDisplay[];
  messages: InlineAgentMessageDisplay[];
  integration: InlineAgentIntegrationDisplay;
  completionPolicy?: string;
  requestedMaxConcurrency?: number;
  observedPeakConcurrency?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export function AgentBatchCell(props: {
  batch: InlineAgentBatchDisplay;
  width: number;
  expanded: boolean;
  theme: TuiTheme;
}) {
  return <TranscriptLines lines={agentBatchCellLines(props.batch, props.width, props.expanded, props.theme)} />;
}

export function agentBatchCellLines(
  batch: InlineAgentBatchDisplay,
  width: number,
  expanded: boolean,
  theme: TuiTheme,
): TranscriptLineModel[] {
  const key = `agent-batch:${batch.id}`;
  const lines: TranscriptLineModel[] = [];
  const markerColor = batchTone(batch.status, theme);
  const header = `◆ ${batchTitle(batch)} · ${progressText(batch)}`;
  if (expanded) {
    lines.push(...wrapLine(header, {
      key: `${key}:header`,
      fg: theme.colors.text.primary,
      width,
      hangingIndent: "  ",
      leadingAccent: { length: 1, fg: markerColor },
    }));
  } else {
    const compactHeader = width >= 100 ? header : `◆ ${batchTitle(batch)}`;
    lines.push(compactLine(`${key}:header`, compactHeader, theme.colors.text.primary, width, markerColor));
    if (width < 100) {
      lines.push(compactLine(`${key}:progress`, `  ${progressText(batch)}`, theme.colors.text.muted, width));
    }
  }

  const rows: Array<InlineAgentDisplay | InlineAgentSpawnFailureDisplay> = [
    ...batch.agents,
    ...batch.spawnFailures,
  ];
  const compactRowLimit = width >= 100 ? 6 : 5;
  const visibleRows = expanded ? rows : prioritizedCompactRows(rows).slice(0, compactRowLimit);
  const renderedMessageIds = new Set<string>();
  visibleRows.forEach((row, index) => {
    const last = index === visibleRows.length - 1 && visibleRows.length === rows.length;
    const prefix = last ? "  └" : "  ├";
    const status = "status" in row ? row.status : "failed";
    const interaction = "followupCount" in row && ((row.followupCount ?? 0) > 0 || (row.turns ?? 0) > 1)
      ? ` · ${row.turns ?? 1} ${(row.turns ?? 1) === 1 ? "turn" : "turns"}, ${row.followupCount ?? 0} ${(row.followupCount ?? 0) === 1 ? "follow-up" : "follow-ups"}`
      : "";
    const result = "error" in row && row.error
      ? row.error
      : "summary" in row
        ? row.error ?? row.summary
        : row.error;
    if (!expanded) {
      const outcome = result
        ? `${status === "failed" || status === "incomplete" || status === "cancelled" ? "error" : "result"}: ${normalized(result)}`
        : "activity" in row && row.activity
          ? `now: ${normalized(row.activity)}`
          : normalized(row.task) || "delegated task";
      const headline = `${prefix} ${statusGlyph(status)} ${row.name} · ${status}${interaction} · ${outcome}`;
      lines.push(compactLine(
        `${key}:agent:${row.id}:compact`,
        headline,
        agentTone(status, theme),
        width,
      ));
      return;
    }

    const headline = `${prefix} ${statusGlyph(status)} ${row.name} · ${status}${interaction} · ${singleLine(row.task, 96) || "delegated task"}`;
    lines.push(...wrapLine(headline, {
      key: `${key}:agent:${row.id}:headline`,
      fg: agentTone(status, theme),
      width,
      hangingIndent: "      ",
    }));

    if (result) {
      const preview = normalized(result);
      if (preview) {
        lines.push(...wrapLine(`      ${status === "failed" || status === "incomplete" || status === "cancelled" ? "error" : "result"}: ${preview}`, {
          key: `${key}:agent:${row.id}:result`,
          fg: status === "failed" || status === "incomplete" || status === "cancelled"
            ? theme.colors.status.error
            : theme.colors.text.muted,
          width,
          hangingIndent: "              ",
        }));
      }
    } else if ("activity" in row && row.activity) {
      lines.push(...wrapLine(`      now: ${singleLine(row.activity, 140)}`, {
        key: `${key}:agent:${row.id}:activity`,
        fg: theme.colors.text.muted,
        width,
        hangingIndent: "           ",
      }));
    }

    if (expanded && "messages" in row) {
      for (const message of row.messages) {
        if (renderedMessageIds.has(message.id)) continue;
        renderedMessageIds.add(message.id);
        lines.push(...messageLines(`${key}:agent:${row.id}`, message, width, theme));
      }
    }
  });

  if (visibleRows.length < rows.length) {
    const more = `  └ … ${rows.length - visibleRows.length} more agents · Ctrl+O expands all`;
    lines.push(compactLine(`${key}:more`, more, theme.colors.text.disabled, width));
  }

  if (batch.error) {
    const text = `  × batch error: ${normalized(batch.error)}`;
    lines.push(...(expanded
      ? wrapLine(text, {
          key: `${key}:error`,
          fg: theme.colors.status.error,
          width,
          hangingIndent: "    ",
        })
      : [compactLine(`${key}:error`, text, theme.colors.status.error, width)]));
  } else if (rows.length === 0) {
    lines.push(...wrapLine("  └ Waiting for agent handles...", {
      key: `${key}:empty`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "    ",
    }));
  }

  lines.push(...integrationLines(batch, width, expanded, theme));
  lines.push(...interactionLines(batch, width, expanded, theme));
  if (expanded) {
    for (const message of batch.messages) {
      if (renderedMessageIds.has(message.id)) continue;
      renderedMessageIds.add(message.id);
      lines.push(...messageLines(`${key}:batch`, message, width, theme));
    }
  }
  return lines;
}

function prioritizedCompactRows(
  rows: readonly (InlineAgentDisplay | InlineAgentSpawnFailureDisplay)[],
): Array<InlineAgentDisplay | InlineAgentSpawnFailureDisplay> {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => compactStatusPriority(rowStatus(left.row)) - compactStatusPriority(rowStatus(right.row)) || left.index - right.index)
    .map(({ row }) => row);
}

function rowStatus(row: InlineAgentDisplay | InlineAgentSpawnFailureDisplay): InlineAgentStatus {
  return "status" in row ? row.status : "failed";
}

function compactStatusPriority(status: InlineAgentStatus): number {
  if (status === "running") return 0;
  if (status === "failed" || status === "incomplete" || status === "cancelled") return 1;
  if (status === "pending") return 2;
  return 3;
}

function interactionLines(batch: InlineAgentBatchDisplay, width: number, expanded: boolean, theme: TuiTheme): TranscriptLineModel[] {
  const parentToAgent = batch.messages.filter((message) => message.direction === "parent_to_agent").length;
  const agentToParent = batch.messages.filter((message) => message.direction === "agent_to_parent").length;
  const agentToAgent = batch.messages.filter((message) => message.direction === "agent_to_agent").length;
  const related = Math.max(0, batch.messages.length - parentToAgent - agentToParent - agentToAgent);
  const followups = batch.agents.reduce((count, agent) => count + (agent.followupCount ?? 0), 0);
  const oneShot = batch.agents.filter((agent) => isTerminalAgentStatus(agent.status) && (agent.followupCount ?? 0) === 0).length
    + batch.spawnFailures.length;
  const text = batch.messages.length === 0
    ? `  ↔ interaction: ${followups} ${followups === 1 ? "follow-up" : "follow-ups"} · ${oneShot} one-shot ${oneShot === 1 ? "result" : "results"}`
    : `  ↔ interaction: ${followups} ${followups === 1 ? "follow-up" : "follow-ups"} · ${oneShot} one-shot ${oneShot === 1 ? "result" : "results"} · ${parentToAgent} parent→agent · ${agentToParent} agent→parent · ${agentToAgent} agent↔agent${related > 0 ? ` · ${related} related` : ""}`;
  const key = `agent-batch:${batch.id}:interaction`;
  const compactText = batch.messages.length === 0
    ? `  ↔ ${followups} ${followups === 1 ? "follow-up" : "follow-ups"} · ${oneShot} one-shot ${oneShot === 1 ? "result" : "results"}`
    : text;
  return expanded
    ? wrapLine(text, { key, fg: theme.colors.text.disabled, width, hangingIndent: "    " })
    : [compactLine(key, width < 60 ? compactText : text, theme.colors.text.disabled, width)];
}

function isTerminalAgentStatus(status: InlineAgentStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function integrationLines(
  batch: InlineAgentBatchDisplay,
  width: number,
  expanded: boolean,
  theme: TuiTheme,
): TranscriptLineModel[] {
  const key = `agent-batch:${batch.id}:integration`;
  const terminalResults = batch.counts.completed + batch.counts.incomplete + batch.counts.failed + batch.counts.cancelled + batch.spawnFailures.length;
  if (terminalResults === 0 && batch.integration.status === "pending" && batch.kind !== "team") return [];
  const resultLabel = terminalResults > 0
    ? `${terminalResults} ${terminalResults === 1 ? "result" : "results"} available`
    : batch.error
      ? "Launch failed"
    : "Results pending";
  const integration = integrationText(batch.integration);
  const hint = expanded ? "Ctrl+O collapses details" : "Ctrl+O expands details";
  const noun = batch.kind === "team" ? "Team results" : "Results";
  const text = `  └ ${noun}: ${resultLabel} · ${integration} · ${hint}`;
  const compactIntegration = integrationCompactText(batch.integration);
  const compactText = `  └ ${noun}: ${terminalResults > 0 ? `${terminalResults} available` : batch.error ? "launch failed" : "pending"} · ${compactIntegration} · Ctrl+O`;
  const color = batch.integration.status === "pending" || batch.integration.status === "ready"
    ? theme.colors.status.warning
    : theme.colors.text.muted;
  const lines = expanded
    ? wrapLine(text, { key, fg: color, width, hangingIndent: "     " })
    : [compactLine(key, compactText, color, width)];
  if (expanded && batch.integration.summary) {
    lines.push(...wrapLine(`     ${normalized(batch.integration.summary)}`, {
      key: `${key}:summary`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "     ",
    }));
  }
  return lines;
}

function messageLines(key: string, message: InlineAgentMessageDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const route = `${pathLeaf(message.from)} → ${pathLeaf(message.to)}`;
  const status = message.status ? ` · ${message.status}` : "";
  return wrapLine(`      ↔ ${route}${status}: ${singleLine(message.text, 180)}`, {
    key: `${key}:message:${message.id}`,
    fg: theme.colors.text.disabled,
    width,
    hangingIndent: "        ",
  });
}

function batchTitle(batch: InlineAgentBatchDisplay): string {
  const terminal = batch.counts.completed + batch.counts.incomplete + batch.counts.failed + batch.counts.cancelled + batch.spawnFailures.length;
  const prefix = batch.kind === "team" ? `Team ${batch.title ?? batch.id} · ` : "";
  const noun = batch.kind === "team" ? "tasks" : "agents";
  if (batch.error && batch.agents.length === 0 && batch.spawnFailures.length === 0) {
    return `${prefix}${batch.expected}/${batch.expected} ${noun} failed to start`;
  }
  if (batch.status === "running" || batch.counts.active > 0) return `${prefix}${terminal}/${batch.expected} ${noun} finished`;
  if (batch.status === "completed" && batch.counts.completed === batch.expected) return `${prefix}${batch.expected}/${batch.expected} ${noun} completed`;
  if (batch.status === "partial") return `${prefix}${terminal}/${batch.expected} ${noun} finished (partial)`;
  if (batch.status === "mixed") return `${prefix}${terminal}/${batch.expected} ${noun} finished (mixed)`;
  return `${prefix}${terminal}/${batch.expected} ${noun} ${batch.status}`;
}

function progressText(batch: InlineAgentBatchDisplay): string {
  if (batch.error && batch.agents.length === 0 && batch.spawnFailures.length === 0) return "launch failed";
  const parts: string[] = [];
  appendCount(parts, batch.counts.pending, "queued");
  appendCount(parts, batch.counts.running, "running");
  appendCount(parts, batch.counts.completed, "completed");
  appendCount(parts, batch.counts.incomplete, "incomplete");
  appendCount(parts, batch.counts.failed + batch.spawnFailures.length, "failed");
  appendCount(parts, batch.counts.cancelled, "cancelled");
  if (batch.observedPeakConcurrency !== undefined) {
    const requested = batch.requestedMaxConcurrency;
    parts.push(requested !== undefined && requested !== batch.observedPeakConcurrency
      ? `peak ${batch.observedPeakConcurrency} concurrent (requested ${requested})`
      : `peak ${batch.observedPeakConcurrency} concurrent`);
  }
  return parts.length > 0
    ? parts.join(", ")
    : batch.status === "running"
      ? `${batch.expected} starting`
      : `${batch.expected} planned`;
}

function appendCount(parts: string[], count: number, label: string): void {
  if (count > 0) parts.push(`${count} ${label}`);
}

function integrationText(integration: InlineAgentIntegrationDisplay): string {
  if (integration.status === "integrated") return "results marked integrated";
  if (integration.status === "responded") return "parent responded after results";
  if (integration.status === "integrating") return "parent response in progress";
  if (integration.status === "not_required") return "no parent integration required";
  if (integration.status === "ready") return "waiting for parent integration";
  return "parent integration pending";
}

function integrationCompactText(integration: InlineAgentIntegrationDisplay): string {
  if (integration.status === "integrated") return "integrated";
  if (integration.status === "responded") return "parent responded after results";
  if (integration.status === "integrating") return "parent responding";
  if (integration.status === "not_required") return "integration not required";
  if (integration.status === "ready") return "awaiting parent";
  return "integration pending";
}

function statusGlyph(status: InlineAgentStatus): string {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "pending") return "○";
  if (status === "incomplete") return "!";
  if (status === "failed") return "×";
  return "−";
}

function batchTone(status: InlineAgentBatchStatus, theme: TuiTheme): string {
  if (status === "failed" || status === "incomplete" || status === "cancelled" || status === "partial" || status === "mixed") return theme.colors.status.error;
  if (status === "running" || status === "pending") return theme.colors.status.pending;
  return theme.colors.status.success;
}

function agentTone(status: InlineAgentStatus, theme: TuiTheme): string {
  if (status === "failed" || status === "incomplete" || status === "cancelled") return theme.colors.status.error;
  if (status === "running" || status === "pending") return theme.colors.status.pending;
  return theme.colors.text.secondary;
}

function pathLeaf(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

function normalized(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function singleLine(value: string | undefined, limit: number): string {
  const text = value ? normalized(value) : "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function compactLine(
  key: string,
  text: string,
  fg: string,
  width: number,
  accent?: string,
): TranscriptLineModel {
  return {
    key,
    text: truncateVisualLine(text, width),
    fg,
    ...(accent ? { leadingAccent: { length: 1, fg: accent } } : {}),
  };
}

function truncateVisualLine(value: string, width: number): string {
  const limit = Math.max(1, width);
  const normalizedValue = normalized(value);
  const total = [...normalizedValue].reduce((sum, char) => sum + charDisplayWidth(char), 0);
  if (total <= limit) return normalizedValue;
  if (limit === 1) return "…";
  const budget = limit - 1;
  let used = 0;
  let output = "";
  for (const char of normalizedValue) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > budget) break;
    output += char;
    used += charWidth;
  }
  return `${output}…`;
}
