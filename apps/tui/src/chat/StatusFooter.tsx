import type { ChatSessionView, TeamLiveView } from "@chili/sdk";
import { basename } from "node:path";
import { shorten } from "../components/helpers.js";
import { modelSelectionLabel, type ModelSelection, type ReasoningLevel } from "../model-state.js";
import type { TuiTheme } from "../theme/index.js";

export interface StatusFooterOptions {
  modeName: string;
  modelName: string;
  providerName: string;
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
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
  const compact = isCompactFooter(props.width);
  const cwd = compact ? compactCwd(props.options.cwd) : shorten(props.options.cwd, 54);
  const branch = props.options.gitBranch ?? "--";
  const usage = usageText(props.chatView);
  const status = sessionStatusText(props.chatView, props.canSubmit, props.model);
  const model = modelText(props.chatView, props.options, compact);
  const details = props.showToolDetails ? "Details on" : "Details off";
  const transcript = props.transcriptActive ? "Transcript on" : "Transcript";
  const actionHint = compact ? "/commands" : "/ commands";

  if (compact) {
    return (
      <box width="100%" height={1} flexDirection="row" paddingX={1}>
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{`${cwd} ${branch}  ${usage}  ${status}  ${model}  ${details}  Ctrl+T ${transcript}  ${actionHint}`}</text>
      </box>
    );
  }

  return (
    <box width="100%" height={2} flexDirection="column" paddingX={2}>
      <box width="100%" height={1} flexDirection="row">
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{cwd}</text>
        <box flexGrow={1} />
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{branch}</text>
        <box flexGrow={1} />
        <text fg={statusColor(status, props.theme)} wrapMode="none" truncate>{status}</text>
      </box>
      <box width="100%" height={1} flexDirection="row">
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{usage}</text>
        <box flexGrow={1} />
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{`${model}     Ctrl+O ${details}     Ctrl+T ${transcript}     ${actionHint}`}</text>
      </box>
    </box>
  );
}

export function statusFooterHeight(width: number): number {
  return isCompactFooter(width) ? 1 : 2;
}

function isCompactFooter(width: number): boolean {
  return width < 84;
}

function sessionStatusText(chatView: ChatSessionView, canSubmit: boolean, model: TeamLiveView): string {
  const session = chatView.status === "waiting_for_approval"
    ? "approval"
    : chatView.status === "running"
      ? "running"
      : canSubmit
        ? "idle"
        : "waiting";
  const goal = goalStatusText(chatView);
  const team = teamStatusText(model);
  return [session, goal, team].filter(Boolean).join(" | ");
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

function usageText(chatView: ChatSessionView): string {
  const context = contextText(chatView.latestModelMetadata?.usage, contextWindowFor(chatView));
  const used = usedText(chatView.usageSummary ?? chatView.latestModelMetadata?.usage);
  return used ? `${context}  ${used}` : context;
}

function contextText(usage: NonNullable<ChatSessionView["latestModelMetadata"]>["usage"] | undefined, contextWindowTokens: number | undefined): string {
  const contextTokens = contextInputTokens(usage);
  if (!contextTokens) return "ctx --";
  if (!contextWindowTokens) return `ctx ${formatTokenCount(contextTokens)}`;

  const percent = Math.max(0, Math.round((contextTokens / contextWindowTokens) * 100));
  return `ctx ${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindowTokens)} ${percent}%`;
}

function usedText(usage: NonNullable<ChatSessionView["usageSummary"]> | undefined): string | undefined {
  const used = usage?.totalTokens ?? cumulativeTokenTotal(usage);
  return used ? `used ${formatTokenCount(used)}` : undefined;
}

function contextInputTokens(usage: NonNullable<ChatSessionView["usageSummary"]> | undefined): number | undefined {
  if (!usage) return undefined;
  const input = finiteTokenCount(usage.inputTokens) ?? 0;
  const cacheRead = finiteTokenCount(usage.cacheReadInputTokens) ?? 0;
  const cacheCreation = finiteTokenCount(usage.cacheCreationInputTokens) ?? 0;
  const total = input + cacheRead + cacheCreation;
  return total > 0 ? total : undefined;
}

function cumulativeTokenTotal(usage: NonNullable<ChatSessionView["usageSummary"]> | undefined): number | undefined {
  if (!usage) return undefined;
  let total = 0;
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ]) {
    total += finiteTokenCount(value) ?? 0;
  }
  return total > 0 ? total : undefined;
}

function contextWindowFor(chatView: ChatSessionView): number | undefined {
  return finiteTokenCount(chatView.latestModelMetadata?.contextWindowTokens);
}

function modelText(chatView: ChatSessionView, options: StatusFooterOptions, compact: boolean): string {
  const provider = options.modelSelection?.provider ?? chatView.latestModelMetadata?.provider ?? options.providerName;
  const model = options.modelSelection?.model ?? chatView.latestModelMetadata?.model ?? options.modelName;
  const mode = options.modeName;
  const reasoning = options.reasoningLevel ? reasoningText(options.reasoningLevel) : undefined;
  if (compact) return shorten(reasoning ? `${model} ${reasoning}` : model, 22);
  const modelLabel = options.modelSelection ? modelSelectionLabel(options.modelSelection) : `${provider}/${model}`;
  return `${modelLabel} ${mode}${reasoning ? ` ${reasoning}` : ""}`;
}

function reasoningText(level: ReasoningLevel): string {
  return level === "off" ? "thinking off" : `thinking ${level}`;
}

function compactCwd(cwd: string): string {
  const leaf = basename(cwd);
  return leaf ? `~/${leaf}` : shorten(cwd, 24);
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
