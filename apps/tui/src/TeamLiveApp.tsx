import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { TeamId } from "@chili/protocol";
import type { TuiTheme } from "./theme/index.js";
import {
  teamLiveModel,
  useTeamLiveRuntime,
  type TeamLiveRuntimeState,
  type TeamLiveTuiOptions,
} from "./useTeamLiveRuntime.js";
import { ActionsBar } from "./components/ActionsBar.js";
import { ActivityLog } from "./components/ActivityLog.js";
import { ApprovalsPanel } from "./components/ApprovalsPanel.js";
import { DetailPane } from "./components/DetailPane.js";
import { DialogStack, type ConfirmDialogState } from "./components/DialogStack.js";
import { HeaderBar } from "./components/HeaderBar.js";
import { MembersPanel } from "./components/MembersPanel.js";
import { RunsPanel } from "./components/RunsPanel.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { TeamRail } from "./components/TeamRail.js";
import {
  FOCUS_REGIONS,
  type FocusRegion,
  type SelectionState,
  type TeamLiveSurfaceRuntime,
} from "./components/types.js";
import { actionNeedsConfirm, clamp, findAction, selectedTeamId as selectedTeamIdAt } from "./components/helpers.js";

const INITIAL_SELECTION: SelectionState = {
  teams: 0,
  runs: 0,
  members: 0,
  tasks: 0,
  approvals: 0,
  activity: 0,
  actions: 0,
  detail: 0,
};

export function TeamLiveApp(props: {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
  onExit: () => void;
  theme: TuiTheme;
}) {
  const runtime = useTeamLiveRuntime({ client: props.client, options: props.options });
  const allTeams = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    sessionId: props.options.sessionId,
    limit: 48,
  });
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | undefined>(props.options.teamId ?? allTeams.selectedTeamId);
  const resolvedSelectedTeamId = props.options.teamId ?? validSelectedTeamId(allTeams, selectedTeamId);
  const model = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    selectedTeamId: resolvedSelectedTeamId,
    sessionId: props.options.sessionId,
    limit: 64,
  });

  useEffect(() => {
    if (props.options.teamId) {
      setSelectedTeamId(props.options.teamId);
      return;
    }
    if (!selectedTeamId || !allTeams.teams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(allTeams.selectedTeamId ?? allTeams.teams[0]?.id);
    }
  }, [allTeams.selectedTeamId, allTeams.teams, props.options.teamId, selectedTeamId]);

  return (
    <TeamLiveSurface
      model={model}
      runtime={runtime}
      selectedTeamId={resolvedSelectedTeamId}
      selectedTeamLocked={Boolean(props.options.teamId)}
      onSelectTeam={setSelectedTeamId}
      onExit={props.onExit}
      theme={props.theme}
    />
  );
}

export function TeamLiveSurface(props: {
  model: TeamLiveView;
  runtime: TeamLiveSurfaceRuntime;
  selectedTeamId?: TeamId | undefined;
  selectedTeamLocked?: boolean | undefined;
  onSelectTeam?: ((teamId: TeamId) => void) | undefined;
  onBack?: (() => void) | undefined;
  onExit?: (() => void) | undefined;
  theme: TuiTheme;
}) {
  const dimensions = useTerminalDimensions();
  const [focus, setFocus] = useState<FocusRegion>("teams");
  const [selection, setSelection] = useState<SelectionState>(INITIAL_SELECTION);
  const [detailOpen, setDetailOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmDialogState | undefined>();
  const selectedTeamIndex = selectedTeamIndexFor(props.model, props.selectedTeamId);
  const runtime = props.runtime;

  useEffect(() => {
    setSelection((current) => normalizeSelection(current, props.model, selectedTeamIndex));
  }, [props.model, selectedTeamIndex]);

  const availableActions = props.model.selected?.availableActions ?? props.model.availableActions;
  const actionToRun = useMemo(() => actionResolver(props.model, selection), [props.model, selection]);

  useKeyboard((key) => {
    if (key.eventType !== "press") return;
    if (key.ctrl && key.name === "c") {
      props.onExit?.();
      return;
    }
    if (confirm) {
      if (isEnter(key)) {
        runtime.executeAction(confirm.action);
        setConfirm(undefined);
      } else if (isEscape(key)) {
        setConfirm(undefined);
      }
      return;
    }
    if (helpOpen) {
      if (isEscape(key) || key.name === "?") setHelpOpen(false);
      return;
    }
    if (key.name === "q") {
      props.onExit?.();
      return;
    }
    if (key.name === "r") {
      runtime.reconnect();
      return;
    }
    if (key.name === "?") {
      setHelpOpen(true);
      return;
    }
    if (isEscape(key)) {
      if (detailOpen) setDetailOpen(false);
      else props.onBack?.();
      return;
    }
    if (isTab(key)) {
      setFocus((current) => nextFocus(current, key.shift ? -1 : 1));
      return;
    }
    if (isArrowUp(key) || isArrowDown(key)) {
      moveSelection(isArrowUp(key) ? -1 : 1, props.model, focus, selection, setSelection, props);
      return;
    }
    if (isEnter(key)) {
      if (focus === "actions") {
        submitAction(availableActions[selection.actions], runtime, setConfirm);
      } else {
        setDetailOpen(true);
      }
      return;
    }
    if (key.name === "a") {
      submitAction(actionToRun("approve"), runtime, setConfirm);
      return;
    }
    if (key.name === "x") {
      submitAction(actionToRun("reject") ?? actionToRun("interrupt"), runtime, setConfirm);
      return;
    }
    if (key.name === "m") {
      submitAction(actionToRun("merge"), runtime, setConfirm);
      return;
    }
    if (key.name === "l") {
      submitAction(actionToRun("run_loop"), runtime, setConfirm);
    }
  });

  const narrow = dimensions.width < 100;
  const showWideDetail = !narrow && (detailOpen || dimensions.width >= 120);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.theme.colors.background}>
      <HeaderBar
        model={props.model}
        connection={props.model.connection}
        runtime={runtime}
        focus={focus}
        width={dimensions.width}
        height={dimensions.height}
        theme={props.theme}
      />
      {narrow ? (
        <NarrowBody
          model={props.model}
          focus={focus}
          selection={selection}
          detailOpen={detailOpen}
          selectedTeamId={props.selectedTeamId}
          runtime={runtime}
          theme={props.theme}
        />
      ) : (
        <box width="100%" flexGrow={1} flexDirection="row">
          <TeamRail
            model={props.model}
            focused={focus === "teams"}
            selectedIndex={selection.teams}
            selectedTeamId={props.selectedTeamId}
            width={26}
            theme={props.theme}
          />
          <box flexGrow={1} height="100%" flexDirection="column">
            <box flexGrow={1} minHeight={8} width="100%" flexDirection="row">
              <RunsPanel model={props.model} focused={focus === "runs"} selectedIndex={selection.runs} theme={props.theme} />
              <ApprovalsPanel model={props.model} focused={focus === "approvals"} selectedIndex={selection.approvals} theme={props.theme} />
            </box>
            <box flexGrow={2} minHeight={10} width="100%" flexDirection="row">
              <MembersPanel model={props.model} focused={focus === "members"} selectedIndex={selection.members} theme={props.theme} />
              <TaskBoard model={props.model} focused={focus === "tasks"} selectedIndex={selection.tasks} theme={props.theme} />
            </box>
            <ActivityLog model={props.model} focused={focus === "activity"} selectedIndex={selection.activity} theme={props.theme} />
          </box>
          {showWideDetail ? (
            <DetailPane model={props.model} focus={focus} focused={focus === "detail"} selection={selection} width={Math.min(44, Math.max(30, Math.floor(dimensions.width * 0.28)))} theme={props.theme} />
          ) : null}
        </box>
      )}
      <ActionsBar actions={availableActions} focused={focus === "actions"} selectedIndex={selection.actions} runtime={runtime} theme={props.theme} />
      <DialogStack
        helpOpen={helpOpen}
        confirm={confirm}
        onConfirm={() => {
          if (confirm) runtime.executeAction(confirm.action);
          setConfirm(undefined);
        }}
        onCancel={() => setConfirm(undefined)}
        theme={props.theme}
      />
    </box>
  );
}

function NarrowBody(props: {
  model: TeamLiveView;
  focus: FocusRegion;
  selection: SelectionState;
  detailOpen: boolean;
  selectedTeamId?: TeamId | undefined;
  runtime: TeamLiveSurfaceRuntime;
  theme: TuiTheme;
}) {
  const common = { model: props.model, focused: true, theme: props.theme };
  const panel = props.detailOpen || props.focus === "detail"
    ? <DetailPane model={props.model} focus={props.focus} focused selection={props.selection} width={80} theme={props.theme} />
    : props.focus === "teams"
      ? <TeamRail {...common} selectedIndex={props.selection.teams} selectedTeamId={props.selectedTeamId} width={80} />
      : props.focus === "runs"
        ? <RunsPanel {...common} selectedIndex={props.selection.runs} />
        : props.focus === "members"
          ? <MembersPanel {...common} selectedIndex={props.selection.members} />
          : props.focus === "tasks"
            ? <TaskBoard {...common} selectedIndex={props.selection.tasks} />
            : props.focus === "approvals"
              ? <ApprovalsPanel {...common} selectedIndex={props.selection.approvals} />
              : props.focus === "activity"
                ? <ActivityLog {...common} selectedIndex={props.selection.activity} />
                : <DetailPane model={props.model} focus={props.focus} focused selection={props.selection} width={80} theme={props.theme} />;

  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      {panel}
    </box>
  );
}

function submitAction(
  action: TeamLiveAction | undefined,
  runtime: TeamLiveSurfaceRuntime,
  setConfirm: (dialog: ConfirmDialogState | undefined) => void,
): void {
  if (!action) return;
  if (action.enabled && actionNeedsConfirm(action)) {
    setConfirm({ action, title: confirmTitle(action) });
    return;
  }
  runtime.executeAction(action);
}

function actionResolver(model: TeamLiveView, selection: SelectionState): (type: TeamLiveAction["type"]) => TeamLiveAction | undefined {
  const actions = model.selected?.availableActions ?? model.availableActions;
  return (type) => {
    if (type === "approve" || type === "reject") {
      const approvals = model.selected?.pendingApprovals ?? [];
      const approval = approvals[selection.approvals];
      if (!approval) {
        if (type === "reject" && approvals.length === 0) return undefined;
        return disabledApprovalAction(type, undefined, approvals.length === 0 ? "no_selected_approval" : "selection_out_of_range");
      }
      return actions.find((action) => action.type === type && "approvalId" in action && action.approvalId === approval.id)
        ?? disabledApprovalAction(type, approval, "action_unavailable");
    }
    if (type === "merge") {
      const tasks = model.selected?.tasks ?? [];
      const task = tasks[selection.tasks];
      if (!task) return disabledMergeAction(model, undefined, tasks.length === 0 ? "no_selected_task" : "selection_out_of_range");
      return actions.find((action) => action.type === "merge" && "taskId" in action && action.taskId === task.id)
        ?? disabledMergeAction(model, task, "no_selected_merge");
    }
    return findAction(actions, type);
  };
}

function disabledApprovalAction(
  type: "approve" | "reject",
  approval: NonNullable<TeamLiveView["selected"]>["pendingApprovals"][number] | undefined,
  reason: string,
): TeamLiveAction {
  if (type === "approve") {
    return approval
      ? { type: "approve", approvalId: approval.id, ...(approval.sessionId ? { sessionId: approval.sessionId } : {}), enabled: false, reason }
      : { type: "approve", enabled: false, reason };
  }
  return approval
    ? { type: "reject", approvalId: approval.id, ...(approval.sessionId ? { sessionId: approval.sessionId } : {}), enabled: false, reason }
    : { type: "reject", enabled: false, reason };
}

function disabledMergeAction(
  model: TeamLiveView,
  task: NonNullable<TeamLiveView["selected"]>["tasks"][number] | undefined,
  reason: string,
): TeamLiveAction {
  return {
    type: "merge",
    ...(model.selectedTeamId ? { teamId: model.selectedTeamId } : {}),
    ...(task ? { taskId: task.id } : {}),
    enabled: false,
    reason,
  };
}

function moveSelection(
  delta: number,
  model: TeamLiveView,
  focus: FocusRegion,
  selection: SelectionState,
  setSelection: (update: (current: SelectionState) => SelectionState) => void,
  props: {
    selectedTeamLocked?: boolean | undefined;
    onSelectTeam?: ((teamId: TeamId) => void) | undefined;
  },
): void {
  const count = itemCount(model, focus);
  if (count <= 0) return;
  const next = clamp(selection[focus] + delta, 0, count - 1);
  setSelection((current) => ({ ...current, [focus]: next }));
  if (focus === "teams" && !props.selectedTeamLocked) {
    const id = selectedTeamIdAt(model.teams, next);
    if (id) props.onSelectTeam?.(id);
  }
}

function normalizeSelection(selection: SelectionState, model: TeamLiveView, selectedTeamIndex: number): SelectionState {
  return {
    teams: clamp(selectedTeamIndex, 0, Math.max(0, model.teams.length - 1)),
    runs: clamp(selection.runs, 0, Math.max(0, itemCount(model, "runs") - 1)),
    members: clamp(selection.members, 0, Math.max(0, itemCount(model, "members") - 1)),
    tasks: clamp(selection.tasks, 0, Math.max(0, itemCount(model, "tasks") - 1)),
    approvals: clamp(selection.approvals, 0, Math.max(0, itemCount(model, "approvals") - 1)),
    activity: clamp(selection.activity, 0, Math.max(0, itemCount(model, "activity") - 1)),
    actions: clamp(selection.actions, 0, Math.max(0, itemCount(model, "actions") - 1)),
    detail: 0,
  };
}

function itemCount(model: TeamLiveView, focus: FocusRegion): number {
  if (focus === "teams") return model.teams.length;
  if (focus === "runs") return Math.max(model.selected?.runs.length ?? 0, 1);
  if (focus === "members") return model.selected?.members.length ?? 0;
  if (focus === "tasks") return model.selected?.tasks.length ?? 0;
  if (focus === "approvals") return model.selected?.pendingApprovals.length ?? 0;
  if (focus === "activity") return model.selected?.recentActivity.length ?? model.globalActivity.length;
  if (focus === "actions") return (model.selected?.availableActions ?? model.availableActions).length;
  return 1;
}

function nextFocus(current: FocusRegion, delta: number): FocusRegion {
  const index = FOCUS_REGIONS.indexOf(current);
  const next = (index + delta + FOCUS_REGIONS.length) % FOCUS_REGIONS.length;
  return FOCUS_REGIONS[next] ?? "teams";
}

function selectedTeamIndexFor(model: TeamLiveView, teamId: TeamId | undefined): number {
  if (!teamId) return model.selectedTeamId ? Math.max(0, model.teams.findIndex((team) => team.id === model.selectedTeamId)) : 0;
  return Math.max(0, model.teams.findIndex((team) => team.id === teamId));
}

function validSelectedTeamId(model: TeamLiveView, selectedTeamId: TeamId | undefined): TeamId | undefined {
  if (selectedTeamId && model.teams.some((team) => team.id === selectedTeamId)) return selectedTeamId;
  return model.selectedTeamId ?? model.teams[0]?.id;
}

function confirmTitle(action: TeamLiveAction): string {
  if (action.type === "approve") return "Approve pending permission?";
  if (action.type === "reject") return "Reject pending permission?";
  if (action.type === "merge") return "Merge task worktree?";
  return "Interrupt session?";
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter";
}

function isEscape(key: KeyEvent): boolean {
  return key.name === "escape" || key.sequence === "\x1b";
}

function isTab(key: KeyEvent): boolean {
  return key.name === "tab";
}

function isArrowUp(key: KeyEvent): boolean {
  return key.name === "up" || key.name === "arrow_up";
}

function isArrowDown(key: KeyEvent): boolean {
  return key.name === "down" || key.name === "arrow_down";
}
