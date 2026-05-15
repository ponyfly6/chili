import type { TeamLiveAction, TeamLiveActivityItem, TeamLiveRunSummary, TeamLiveTeamSummary } from "@chili/sdk";
import type { TeamId, TeamRunSummaryCounts } from "@chili/protocol";
import { actionKey } from "../useTeamLiveRuntime.js";

const COUNT_LABELS: ReadonlyArray<readonly [keyof TeamRunSummaryCounts, string]> = [
  ["dispatched", "disp"],
  ["completed", "done"],
  ["accepted", "accept"],
  ["reopened", "reopen"],
  ["merged", "merge"],
  ["mergeFailed", "mergeFail"],
  ["mergeConflicted", "conflict"],
  ["mergeSkipped", "mergeSkip"],
  ["failed", "fail"],
  ["blocked", "block"],
  ["skipped", "skip"],
  ["stillRunning", "run"],
  ["errors", "err"],
];

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
  const items = COUNT_LABELS.flatMap(([key, label]) => {
    const value = counts[key];
    return typeof value === "number" && value > 0 ? [`${label}:${value}`] : [];
  });
  if (items.length === 0) return "none";
  return items.slice(0, 8).join(" ");
}

export function runBottleneckLabel(run: TeamLiveRunSummary): string {
  const counts = run.counts;
  if (counts.errors > 0) return "errors";
  if (counts.mergeConflicted > 0) return "merge-conflict";
  if (counts.mergeFailed > 0) return "merge-failed";
  if (counts.reopened > 0) return "verify-failed";
  if (counts.blocked > 0) return "blocked";
  if (
    run.maxConcurrentDispatches !== undefined &&
    run.maxConcurrentDispatches > 0 &&
    counts.stillRunning >= run.maxConcurrentDispatches
  ) {
    return "fanout-full";
  }
  if (counts.stillRunning > 0) return "workers-running";
  if (counts.completed > 0 && counts.accepted === 0 && counts.merged === 0) return "verify-pending";
  if (run.stopReason === "timeout") return "timeout";
  if (run.stopReason === "max_cycles") return "max-cycles";
  if (run.stopReason === "drained") return "drained";
  if (run.stopReason === "once") return "one-cycle";
  return run.phase ?? run.status;
}

export function runBottleneckShortLabel(label: string): string {
  switch (label) {
    case "errors":
      return "err";
    case "merge-conflict":
      return "mconf";
    case "merge-failed":
      return "mfail";
    case "verify-failed":
      return "vfail";
    case "blocked":
      return "block";
    case "fanout-full":
      return "full";
    case "workers-running":
      return "run";
    case "waiting-dependencies":
      return "deps";
    case "verify-pending":
      return "verify";
    case "max-cycles":
      return "max";
    case "one-cycle":
      return "once";
    default:
      return label;
  }
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
