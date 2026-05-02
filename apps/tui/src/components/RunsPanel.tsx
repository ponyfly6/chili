import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { countsCompact, focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function RunsPanel(props: PanelProps) {
  const selected = props.model.selected;
  const runs = selected?.runs ?? [];
  const tools = selected?.activeTools ?? [];
  const health = selected?.health;
  const runWindow = visibleWindow(runs, props.selectedIndex, VISIBLE_LIMITS.runs);
  const { theme } = props;

  return (
    <box flexGrow={1} minWidth={24} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Runs / Health${runWindow.label}`, props.focused)}</text>
      {health ? (
        <text fg={theme.colors.text.secondary} truncate wrapMode="none">
          {`health:${health.status} run:${health.counts.runningTasks} app:${health.counts.pendingApprovals} merge:${health.counts.pendingMerges} tool:${health.counts.activeTools}`}
        </text>
      ) : (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"health: unknown"}</text>
      )}
      {runs.length === 0 ? (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"  run: none"}</text>
      ) : (
        runWindow.rows.map(({ item: run, index }) => (
          <text key={run.id} fg={index === props.selectedIndex ? theme.colors.text.primary : theme.colors.text.secondary} truncate wrapMode="none">
            {`${rowMarker(props.focused, index === props.selectedIndex)} ${run.phase ?? run.status} ${shorten(run.id, 12)} c:${run.cycle} ${countsCompact(run.counts)}`}
          </text>
        ))
      )}
      {tools.slice(0, VISIBLE_LIMITS.activeTools).map((tool) => (
        <text key={tool.id} fg={tool.waitingForApproval ? theme.colors.status.warning : theme.colors.status.success} truncate wrapMode="none">
          {`  tool ${shorten(tool.toolName, 24)} ${tool.status}`}
        </text>
      ))}
    </box>
  );
}
