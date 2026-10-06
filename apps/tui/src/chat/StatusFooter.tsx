import type { ChatSessionView } from "@chili/sdk";
import type { ServiceTier } from "@chili/protocol";
import { basename, resolve } from "node:path";
import type { ModelSelection, ReasoningLevel } from "../model-state.js";
import type { TuiTheme } from "../theme/index.js";
import type { AgentsViewModel } from "./AgentsView.js";

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

export function StatusFooter(props: {
  options: StatusFooterOptions;
  agentExperience?: AgentsViewModel | undefined;
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
    statusFooterWorkspaceText(props.chatView, props.options),
  ].filter(Boolean).join(" · ");
  const status = statusFooterStatusText(props.chatView, props.canSubmit, props.agentExperience);
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

export function statusFooterStatusText(
  chatView: ChatSessionView,
  canSubmit: boolean,
  agentExperience: AgentsViewModel | undefined,
): string | undefined {
  const session = chatView.status === "failed"
    ? "failed"
    : chatView.status === "cancelled"
      ? "cancelled"
      : chatView.status === "cancelling"
        ? "cancelling"
        : chatView.status === "waiting_for_approval"
          ? "approval"
          : chatView.status === "running"
            ? "running"
            : canSubmit ? undefined : "waiting";
  const goal = goalStatusText(chatView);
  const agents = agentExperience && agentExperience.activeAgents > 0
    ? `${agentExperience.activeAgents} agent${agentExperience.activeAgents === 1 ? "" : "s"}`
    : undefined;
  const status = [session, goal, agents].filter(Boolean).join(" · ");
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

export function statusFooterWorkspaceText(chatView: ChatSessionView, options: StatusFooterOptions): string {
  const cwd = chatView.cwd ?? options.cwd;
  const workspace = basename(cwd) || cwd;
  const branchBelongsToWorkspace = chatView.cwd === undefined || resolve(chatView.cwd) === resolve(options.cwd);
  return options.gitBranch && branchBelongsToWorkspace
    ? `${workspace} (${options.gitBranch})`
    : workspace;
}

function statusColor(status: string, theme: TuiTheme): string {
  if (status.includes("failed") || status.includes("cancelled")) return theme.colors.status.error;
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
