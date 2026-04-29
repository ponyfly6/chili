import type { TeamLiveAction, TeamLiveActivityItem, TeamLiveTeamSummary } from "@chili/sdk";
import type { TeamId, TeamRunSummaryCounts } from "@chili/protocol";
import { actionKey } from "../useTeamLiveRuntime.js";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function selectedTeamId(teams: readonly TeamLiveTeamSummary[], selectedIndex = 0): TeamId | undefined {
  if (teams.length === 0) return undefined;
  return teams[clamp(selectedIndex, 0, teams.length - 1)]?.id;
}

export function focusLabel(input: string, focused: boolean): string {
  return focused ? `[${input}]` : input;
}

export function rowMarker(focused: boolean, selected: boolean): string {
  if (focused && selected) return ">";
  if (selected) return "*";
  return " ";
}

export function shorten(value: unknown, max = 80): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}~`;
}

export function compactId(value: string | undefined, max = 18): string {
  if (!value) return "none";
  return shorten(value, max);
}

export function countsCompact(counts: TeamRunSummaryCounts): string {
  const items = Object.entries(counts).filter(([, value]) => typeof value === "number" && value > 0);
  if (items.length === 0) return "none";
  return items.slice(0, 8).map(([key, value]) => `${key}:${value}`).join(" ");
}

export function activityLine(item: TeamLiveActivityItem): string {
  const status = item.status ? ` [${item.status}]` : "";
  const detail = item.detail ? ` - ${shorten(item.detail, 48)}` : "";
  return `${item.kind}${status}: ${shorten(item.label, 44)}${detail}`;
}

export function actionLabel(action: TeamLiveAction): string {
  const target =
    action.type === "approve" || action.type === "reject"
      ? compactId(action.approvalId)
      : action.type === "merge"
        ? compactId(action.taskId ?? action.teamId)
        : action.type === "interrupt"
          ? compactId(action.sessionId)
          : compactId(action.teamId);
  const state = action.enabled ? "ready" : `disabled:${action.reason ?? "unavailable"}`;
  return `${action.type} ${target} ${state}`;
}

export function findAction(actions: readonly TeamLiveAction[], type: TeamLiveAction["type"]): TeamLiveAction | undefined {
  return actions.find((action) => action.type === type && action.enabled) ?? actions.find((action) => action.type === type);
}

export function visibleWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  limit: number,
): {
  rows: { item: T; index: number }[];
  label: string;
} {
  if (items.length === 0 || limit <= 0) return { rows: [], label: "" };
  const count = Math.min(limit, items.length);
  const selected = clamp(selectedIndex, 0, items.length - 1);
  const start = Math.min(Math.max(0, selected - count + 1), items.length - count);
  const end = start + count;
  const label = items.length > limit ? ` ${start + 1}-${end}/${items.length}` : "";
  return {
    rows: items.slice(start, end).map((item, offset) => ({ item, index: start + offset })),
    label,
  };
}

export function actionNeedsConfirm(action: TeamLiveAction): boolean {
  return action.type === "approve" || action.type === "reject" || action.type === "merge" || action.type === "interrupt";
}

export function pendingLabel(action: TeamLiveAction, pendingActionKey: string | undefined): string {
  return pendingActionKey === actionKey(action) ? " pending" : "";
}
