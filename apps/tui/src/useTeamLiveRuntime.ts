import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyRuntimeEvent,
  createRuntimeView,
  teamLiveView,
  type ChiliRuntimeView,
  type HttpRuntimeClient,
  type MergeTeamTasksRequest,
  type RunTeamLoopRequest,
  type StreamEventsRequest,
  type TeamLiveAction,
  type TeamLiveConnectionState,
  type TeamLiveView,
} from "@chili/sdk";
import type { ApprovalId, SessionId, TaskId, TeamId, ThreadId } from "@chili/protocol";

export interface TeamLiveTuiOptions {
  baseUrl: string;
  teamId?: TeamId;
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
  runLoop: boolean;
  once: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface TeamLiveStreamScopeInput {
  sessionId?: SessionId;
  threadId?: ThreadId;
}

export function teamLiveStreamInput(
  _scope: TeamLiveStreamScopeInput,
  signal: AbortSignal,
  afterEventId?: string,
): StreamEventsRequest {
  // Team Live needs child-session worker events; SDK projection handles session/team filtering.
  const input: StreamEventsRequest = { signal };
  if (afterEventId) input.afterEventId = afterEventId;
  return input;
}

export type TeamLiveActionStatus = "idle" | "pending" | "success" | "error";

export interface TeamLiveActionFeedback {
  key: string;
  type: TeamLiveAction["type"];
  status: TeamLiveActionStatus;
  message: string;
}

export interface TeamLiveRuntimeState {
  runtimeView: ChiliRuntimeView;
  revision: number;
  connection: TeamLiveConnectionState;
  message: string;
  actionFeedback?: TeamLiveActionFeedback;
  pendingActionKey?: string;
  reconnect: () => void;
  executeAction: (action: TeamLiveAction) => void;
  clearActionFeedback: () => void;
}

export interface UseTeamLiveRuntimeInput {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
}

export function useTeamLiveRuntime(input: UseTeamLiveRuntimeInput): TeamLiveRuntimeState {
  const { client, options } = input;
  const runtimeViewRef = useRef<ChiliRuntimeView>(createRuntimeView());
  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const streamVersionRef = useRef(0);
  const startupRunLoopRef = useRef(false);
  const actionAbortRefs = useRef(new Map<string, AbortController>());

  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<TeamLiveConnectionState>(() => ({ status: "connecting" }));
  const [message, setMessage] = useState("connecting");
  const [actionFeedback, setActionFeedback] = useState<TeamLiveActionFeedback | undefined>();

  const setSafeConnection = useCallback((state: TeamLiveConnectionState, nextMessage: string) => {
    if (!mountedRef.current) return;
    setConnection(state);
    setMessage(nextMessage);
  }, []);

  const startStream = useCallback((status: TeamLiveConnectionState["status"]) => {
    reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
    streamAbortRef.current?.abort();

    const controller = new AbortController();
    streamAbortRef.current = controller;
    const version = ++streamVersionRef.current;
    const lastEventId = runtimeViewRef.current.lastEventId;
    setSafeConnection(connectionState(status, undefined, lastEventId), status === "reconnecting" ? "reconnecting" : "connecting");

    void (async () => {
      try {
        const request = teamLiveStreamInput(options, controller.signal, lastEventId);
        for await (const event of client.streamEvents(request)) {
          if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
          applyRuntimeEvent(runtimeViewRef.current, event);
          setConnection(connectionState("streaming", undefined, runtimeViewRef.current.lastEventId));
          setMessage(`last event: ${event.type}`);
          setRevision((current) => current + 1);
        }
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        setSafeConnection(connectionState("offline", undefined, runtimeViewRef.current.lastEventId), "stream ended");
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        const messageText = toError(error).message;
        setSafeConnection(connectionState("error", messageText, runtimeViewRef.current.lastEventId), messageText);
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) startStream("reconnecting");
        }, 1500);
      }
    })();
  }, [client, options, setSafeConnection]);

  const reconnect = useCallback(() => {
    setActionFeedback(undefined);
    startStream("reconnecting");
  }, [startStream]);

  const runTeamLoop = useCallback((teamId: TeamId, signal?: AbortSignal) => {
    const request: RunTeamLoopRequest = {
      teamId,
      once: options.once,
    };
    if (options.sessionId) request.sessionId = options.sessionId;
    if (options.threadId) request.threadId = options.threadId;
    if (options.cwd) request.cwd = options.cwd;
    if (options.maxCycles !== undefined) request.maxCycles = options.maxCycles;
    if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
    if (options.pollIntervalMs !== undefined) request.pollIntervalMs = options.pollIntervalMs;
    if (signal) request.signal = signal;
    return client.runTeamLoop(request);
  }, [client, options.cwd, options.maxCycles, options.once, options.pollIntervalMs, options.sessionId, options.threadId, options.timeoutMs]);

  const executeAction = useCallback((action: TeamLiveAction) => {
    const key = actionKey(action);
    if (!action.enabled) {
      setActionFeedback({
        key,
        type: action.type,
        status: "error",
        message: `disabled: ${action.reason ?? "unavailable"}`,
      });
      return;
    }

    const controller = action.type === "merge" || action.type === "run_loop" ? new AbortController() : undefined;
    if (controller) actionAbortRefs.current.set(key, controller);
    setActionFeedback({ key, type: action.type, status: "pending", message: pendingMessage(action) });

    void (async () => {
      try {
        await callAction(client, action, options, runTeamLoop, controller?.signal);
        if (!mountedRef.current) return;
        setActionFeedback({ key, type: action.type, status: "success", message: successMessage(action) });
      } catch (error) {
        if (!mountedRef.current) return;
        setActionFeedback({ key, type: action.type, status: "error", message: toError(error).message });
      } finally {
        actionAbortRefs.current.delete(key);
      }
    })();
  }, [client, options, runTeamLoop]);

  useEffect(() => {
    mountedRef.current = true;
    startStream("connecting");
    return () => {
      mountedRef.current = false;
      reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
      streamAbortRef.current?.abort();
      for (const controller of actionAbortRefs.current.values()) controller.abort();
      actionAbortRefs.current.clear();
    };
  }, [startStream]);

  useEffect(() => {
    if (!options.runLoop || startupRunLoopRef.current) return;
    startupRunLoopRef.current = true;
    if (!options.teamId) {
      setActionFeedback({
        key: "run_loop:startup",
        type: "run_loop",
        status: "error",
        message: "--run-loop requires --team",
      });
      return;
    }

    const key = actionKey({ type: "run_loop", teamId: options.teamId, enabled: true });
    const controller = new AbortController();
    actionAbortRefs.current.set(key, controller);
    setActionFeedback({ key, type: "run_loop", status: "pending", message: "starting team loop" });
    void runTeamLoop(options.teamId, controller.signal)
      .then(() => {
        if (mountedRef.current) setActionFeedback({ key, type: "run_loop", status: "success", message: "team loop completed" });
      })
      .catch((error) => {
        if (mountedRef.current) setActionFeedback({ key, type: "run_loop", status: "error", message: toError(error).message });
      })
      .finally(() => {
        actionAbortRefs.current.delete(key);
      });
  }, [options.runLoop, options.teamId, runTeamLoop]);

  return useMemo(() => ({
    runtimeView: runtimeViewRef.current,
    revision,
    connection,
    message,
    ...(actionFeedback ? { actionFeedback } : {}),
    ...(actionFeedback?.status === "pending" ? { pendingActionKey: actionFeedback.key } : {}),
    reconnect,
    executeAction,
    clearActionFeedback: () => setActionFeedback(undefined),
  }), [actionFeedback, connection, executeAction, message, reconnect, revision]);
}

export function teamLiveModel(
  runtimeView: ChiliRuntimeView,
  input: {
    connection: TeamLiveConnectionState;
    selectedTeamId?: TeamId | undefined;
    sessionId?: SessionId | undefined;
    limit?: number;
  },
): TeamLiveView {
  const request: Parameters<typeof teamLiveView>[1] = {
    connection: input.connection,
    limit: input.limit ?? 48,
  };
  if (input.selectedTeamId) request.teamId = input.selectedTeamId;
  if (input.sessionId) request.sessionId = input.sessionId;
  return teamLiveView(runtimeView, request);
}

export function actionKey(action: TeamLiveAction): string {
  if (action.type === "approve" || action.type === "reject") return `${action.type}:${action.approvalId ?? "missing"}`;
  if (action.type === "merge") return `${action.type}:${action.teamId ?? "missing"}:${action.taskId ?? "all"}`;
  if (action.type === "interrupt") return `${action.type}:${action.sessionId ?? "missing"}`;
  return `${action.type}:${action.teamId ?? "missing"}`;
}

function connectionState(
  status: TeamLiveConnectionState["status"],
  error: string | undefined,
  lastEventId: string | undefined,
): TeamLiveConnectionState {
  const state: TeamLiveConnectionState = { status };
  if (error) state.error = error;
  if (lastEventId) state.lastEventId = lastEventId;
  return state;
}

async function callAction(
  client: HttpRuntimeClient,
  action: TeamLiveAction,
  options: TeamLiveTuiOptions,
  runTeamLoop: (teamId: TeamId, signal?: AbortSignal) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (action.type === "approve") {
    return client.approveApproval({ approvalId: requireApprovalId(action.approvalId, action.type) });
  }
  if (action.type === "reject") {
    return client.rejectApproval({
      approvalId: requireApprovalId(action.approvalId, action.type),
      feedback: "Rejected from Team Live TUI",
    });
  }
  if (action.type === "merge") {
    const request: MergeTeamTasksRequest = { teamId: requireTeamId(action.teamId, action.type) };
    if (action.taskId) request.taskId = action.taskId;
    if (options.sessionId) request.sessionId = options.sessionId;
    if (options.threadId) request.threadId = options.threadId;
    if (options.cwd) request.cwd = options.cwd;
    if (signal) request.signal = signal;
    return client.mergeTeamTasks(request);
  }
  if (action.type === "run_loop") {
    return runTeamLoop(requireTeamId(action.teamId, action.type), signal);
  }
  return client.interruptSession({
    sessionId: requireSessionId(action.sessionId, action.type),
    reason: "Interrupted from Team Live TUI",
  });
}

function requireTeamId(value: TeamId | undefined, action: string): TeamId {
  if (!value) throw new Error(`${action} requires a team id`);
  return value;
}

function requireApprovalId(value: ApprovalId | undefined, action: string): ApprovalId {
  if (!value) throw new Error(`${action} requires an approval id`);
  return value;
}

function requireSessionId(value: SessionId | undefined, action: string): SessionId {
  if (!value) throw new Error(`${action} requires a session id`);
  return value;
}

function pendingMessage(action: TeamLiveAction): string {
  if (action.type === "approve") return "approving approval";
  if (action.type === "reject") return "rejecting approval";
  if (action.type === "merge") return `merging ${formatTaskTarget(action.taskId)}`;
  if (action.type === "run_loop") return "starting team loop";
  return "interrupting session";
}

function successMessage(action: TeamLiveAction): string {
  if (action.type === "approve") return "approval allowed";
  if (action.type === "reject") return "approval rejected";
  if (action.type === "merge") return `merge completed for ${formatTaskTarget(action.taskId)}`;
  if (action.type === "run_loop") return "team loop completed";
  return "interrupt sent";
}

function formatTaskTarget(taskId: TaskId | undefined): string {
  return taskId ?? "pending tasks";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
