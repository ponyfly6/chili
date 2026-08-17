import type { ChatSessionView, TeamLiveView } from "@chili/sdk";
import type { ServiceTier } from "@chili/protocol";
import { basename } from "node:path";
import type { ModelSelection, ReasoningLevel } from "../model-state.js";
import type { TuiTheme } from "../theme/index.js";

export interface StatusFooterOptions {
  modeName: string;
  modelName: string;
  providerName: string;
  modelSelection?: ModelSelection | undefined;
  reasoningConfigurable?: boolean | undefined;
  serviceTierConfigurable?: boolean | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: ServiceTier | undefined;
  cwd: string;
  gitBranch?: string | undefined;
}

export function TeamStatusRow(props: { model: TeamLiveView; theme: TuiTheme }) {
  const status = teamStatusText(props.model);
  if (!status) return null;
  return (
    <box width="100%" paddingX={2}>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{status}</text>
    </box>
  );
}

export function StatusFooter(props: {
  options: StatusFooterOptions;
  model: TeamLiveView;
  chatView: ChatSessionView;
  canSubmit: boolean;
  width: number;
  theme: TuiTheme;
  showToolDetails: boolean;
  transcriptActive: boolean;
}) {
  const left = [
    modelText(props.chatView, props.options),
    contextText(props.chatView.latestModelMetadata?.usage, contextWindowFor(props.chatView)),
    workspaceText(props.options),
  ].filter(Boolean).join(" · ");
  const status = sessionStatusText(props.chatView, props.canSubmit, props.model);
  const right = [
    props.options.modeName,
    props.showToolDetails ? "Details on" : undefined,
    props.transcriptActive ? "Transcript on" : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <box width="100%" height={1} flexDirection="row" paddingX={2}>
      <box flexGrow={1} flexShrink={1} minWidth={1} overflow="hidden">
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{left}</text>
      </box>
      <box flexShrink={0} flexDirection="row">
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{right}</text>
        {status ? (
          <>
            <text fg={props.theme.colors.text.disabled}>{" · "}</text>
            <text fg={statusColor(status, props.theme)} wrapMode="none" truncate>{status}</text>
          </>
        ) : null}
      </box>
    </box>
  );
}

export function statusFooterHeight(_width: number): number {
  return 1;
}

function sessionStatusText(chatView: ChatSessionView, canSubmit: boolean, model: TeamLiveView): string | undefined {
  const session = chatView.status === "waiting_for_approval"
    ? "approval"
    : chatView.status === "running"
      ? "running"
      : canSubmit ? undefined : "waiting";
  const goal = goalStatusText(chatView);
  const team = teamStatusText(model);
  const status = [session, goal, team].filter(Boolean).join(" · ");
  return status || undefined;
}

function goalStatusText(chatView: ChatSessionView): string | undefined {
  const goal = chatView.goal;
  if (!goal) return undefined;
  const usage = goal.tokenBudget !== undefined
    ? `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`
    : formatTokenCount(goal.tokensUsed);
  if (goal.status === "active") return `goal ${usage}`;
  if (goal.status === "paused") return "goal paused";
  if (goal.status === "budgetLimited") return `goal budget ${usage}`;
  return "goal complete";
}

function teamStatusText(model: TeamLiveView): string | undefined {
  const counts = model.selected?.health.counts;
  if (!counts) return undefined;
  const parts: string[] = [];
  if (counts.runningTasks > 0) parts.push(`${counts.runningTasks} running`);
  if (counts.pendingApprovals > 0) parts.push(`${counts.pendingApprovals} approval`);
  if (counts.activeTools > 0) parts.push(`${counts.activeTools} tool`);
  return parts.length > 0 ? `team ${parts.join(" ")}` : undefined;
}

function contextText(usage: NonNullable<ChatSessionView["latestModelMetadata"]>["usage"] | undefined, contextWindowTokens: number | undefined): string | undefined {
  const contextTokens = contextInputTokens(usage);
  if (!contextTokens) return undefined;
  if (!contextWindowTokens) return `${formatTokenCount(contextTokens)} ctx`;

  const remaining = Math.max(0, Math.round((1 - contextTokens / contextWindowTokens) * 100));
  return `${remaining}% ctx left`;
}

function contextInputTokens(usage: NonNullable<ChatSessionView["usageSummary"]> | undefined): number | undefined {
  if (!usage) return undefined;
  const input = finiteTokenCount(usage.inputTokens) ?? 0;
  const cacheRead = finiteTokenCount(usage.cacheReadInputTokens) ?? 0;
  const cacheCreation = finiteTokenCount(usage.cacheCreationInputTokens) ?? 0;
  const total = input + cacheRead + cacheCreation;
  return total > 0 ? total : undefined;
}

function contextWindowFor(chatView: ChatSessionView): number | undefined {
  return finiteTokenCount(chatView.latestModelMetadata?.contextWindowTokens);
}

function modelText(chatView: ChatSessionView, options: StatusFooterOptions): string {
  const model = options.modelSelection?.model ?? chatView.latestModelMetadata?.model ?? options.modelName;
  const reasoning = options.reasoningConfigurable !== false && options.reasoningLevel
    ? reasoningText(options.reasoningLevel)
    : undefined;
  const serviceTier = options.serviceTierConfigurable !== false ? serviceTierText(options.serviceTier) : undefined;
  return [model, reasoning, serviceTier].filter(Boolean).join(" · ");
}

function reasoningText(level: ReasoningLevel): string {
  return level === "off" ? "thinking off" : `thinking ${level}`;
}

function serviceTierText(serviceTier: ServiceTier | undefined): string | undefined {
  if (serviceTier === "fast") return "fast";
  if (serviceTier === "standard") return "standard";
  return undefined;
}

function workspaceText(options: StatusFooterOptions): string {
  const workspace = basename(options.cwd) || options.cwd;
  return options.gitBranch ? `${workspace} (${options.gitBranch})` : workspace;
}

function statusColor(status: string, theme: TuiTheme): string {
  if (status.includes("approval")) return theme.colors.status.pending;
  if (status.includes("running")) return theme.colors.status.info;
  if (status === "waiting") return theme.colors.text.muted;
  return theme.colors.text.disabled;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
