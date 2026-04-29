import type { TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { TeamId } from "@chili/protocol";
import type { TeamLiveActionFeedback } from "../useTeamLiveRuntime.js";

export type FocusRegion = "teams" | "runs" | "members" | "tasks" | "approvals" | "activity" | "actions" | "detail";

export const FOCUS_REGIONS: readonly FocusRegion[] = [
  "teams",
  "runs",
  "members",
  "tasks",
  "approvals",
  "activity",
  "actions",
  "detail",
];

export const VISIBLE_LIMITS = {
  teams: 18,
  runs: 3,
  activeTools: 2,
  members: 8,
  tasks: 12,
  approvals: 5,
  activity: 4,
  actions: 8,
} as const;

export interface SelectionState {
  teams: number;
  runs: number;
  members: number;
  tasks: number;
  approvals: number;
  activity: number;
  actions: number;
  detail: number;
}

export interface PanelProps {
  model: TeamLiveView;
  focused: boolean;
  selectedIndex: number;
}

export interface RuntimeActions {
  reconnect: () => void;
  executeAction: (action: TeamLiveAction) => void;
  clearActionFeedback: () => void;
}

export interface TeamLiveSurfaceRuntime extends RuntimeActions {
  message: string;
  actionFeedback?: TeamLiveActionFeedback;
  pendingActionKey?: string;
}

export interface TeamSelection {
  selectedTeamId?: TeamId;
  selectedTeamLocked: boolean;
  onSelectTeam: (teamId: TeamId) => void;
}
