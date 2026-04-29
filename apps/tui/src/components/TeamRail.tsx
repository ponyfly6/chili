import type { TeamId } from "@chili/protocol";
import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function TeamRail(props: PanelProps & { selectedTeamId?: TeamId | undefined; width?: number }) {
  const teams = visibleWindow(props.model.teams, props.selectedIndex, VISIBLE_LIMITS.teams);
  return (
    <box width={props.width ?? 26} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Teams${teams.label}`, props.focused)}</text>
      {props.model.teams.length === 0 ? (
        <text fg="#8f9baa" truncate wrapMode="none">{"  No teams projected yet."}</text>
      ) : (
        teams.rows.map(({ item: team, index }) => {
          const selected = team.id === props.selectedTeamId || index === props.selectedIndex;
          return (
            <text key={team.id} fg={selected ? "#f8f8f2" : "#d8dee9"} truncate wrapMode="none">
              {`${rowMarker(props.focused, selected)} ${shorten(team.name || team.id, 16)} ${team.status} m:${team.memberCount} t:${team.taskCount} p:${team.pendingApprovalCount}`}
            </text>
          );
        })
      )}
    </box>
  );
}
