import type { TeamId } from "@chili/protocol";
import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function TeamRail(props: PanelProps & { selectedTeamId?: TeamId | undefined; width?: number }) {
  const teams = visibleWindow(props.model.teams, props.selectedIndex, VISIBLE_LIMITS.teams);
  return (
    <box width={props.width ?? 26} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? props.theme.colors.border.focus : props.theme.colors.border.subtle} paddingX={1}>
      <text fg={props.theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Teams${teams.label}`, props.focused)}</text>
      {props.model.teams.length === 0 ? (
        <text fg={props.theme.colors.text.muted} truncate wrapMode="none">{"  No teams projected yet."}</text>
      ) : (
        teams.rows.map(({ item: team, index }) => {
          const selected = team.id === props.selectedTeamId || index === props.selectedIndex;
          return (
            <text key={team.id} fg={selected ? props.theme.colors.text.primary : props.theme.colors.text.secondary} truncate wrapMode="none">
              {`${rowMarker(props.focused, selected)} ${shorten(team.name || team.id, 16)} ${team.status} m:${team.memberCount} t:${team.taskCount} p:${team.pendingApprovalCount}`}
            </text>
          );
        })
      )}
    </box>
  );
}
