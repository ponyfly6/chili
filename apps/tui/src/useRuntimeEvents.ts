import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyRuntimeEvent,
  createRuntimeView,
  isEventCursorResyncRequiredError,
  isEventTransportResyncRequiredError,
  markRuntimeOutputGap,
  restoreRuntimeSnapshot,
  type ChiliRuntimeView,
  type HttpRuntimeClient,
  type StreamEventsRequest,
} from "@chili/sdk";
import { isTransientEvent, type ChiliEvent, type SessionId } from "@chili/protocol";

export interface RuntimeTuiOptions {
  baseUrl: string;
  sessionId?: SessionId;
  cwd?: string;
  streamScope?: "all" | "session";
}

export interface RuntimeConnectionState {
  status: "connecting" | "streaming" | "reconnecting" | "offline" | "error";
  error?: string;
  lastEventId?: string;
}

export function runtimeStreamInput(
  scope: Pick<RuntimeTuiOptions, "sessionId" | "streamScope">,
  signal: AbortSignal,
  afterEventId?: string,
): StreamEventsRequest {
  const input: StreamEventsRequest = { signal };
  if (scope.streamScope === "session" && scope.sessionId) input.sessionId = scope.sessionId;
  if (afterEventId) input.afterEventId = afterEventId;
  return input;
}

export interface RuntimeEventsState {
  runtimeView: ChiliRuntimeView;
  revision: number;
  connection: RuntimeConnectionState;
  message: string;
  reconnect: () => void;
  hydrateEvents: (events: readonly ChiliEvent[]) => void;
}

export function useRuntimeEvents(input: { client: HttpRuntimeClient; options: RuntimeTuiOptions }): RuntimeEventsState {
  const { client, options } = input;
  const runtimeViewRef = useRef<ChiliRuntimeView>(createRuntimeView());
  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const streamVersionRef = useRef(0);
  const appliedDurableEventIdsRef = useRef(new Set<string>());
  // History hydration is projection work, not evidence that the global stream
  // has consumed all events before a particular durable cursor.
  const streamCursorRef = useRef<string | undefined>(undefined);
  const streamFromStartRef = useRef(false);
  const snapshotRequiredRef = useRef(false);
  const snapshotCoveredSessionIdsRef = useRef(new Set<string>());

  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<RuntimeConnectionState>(() => ({ status: "connecting" }));
  const [message, setMessage] = useState("connecting");

  const setSafeConnection = useCallback((state: RuntimeConnectionState, nextMessage: string) => {
    if (!mountedRef.current) return;
    setConnection(state);
    setMessage(nextMessage);
  }, []);

  const applyEventOnce = useCallback((event: ChiliEvent): boolean => {
    const durable = !isTransientEvent(event);
    if (durable && appliedDurableEventIdsRef.current.has(event.id)) return false;
    applyRuntimeEvent(runtimeViewRef.current, event);
    if (durable) appliedDurableEventIdsRef.current.add(event.id);
    return true;
  }, []);

  const startStream = useCallback((status: RuntimeConnectionState["status"]) => {
    reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
    streamAbortRef.current?.abort();
    if (streamVersionRef.current > 0) {
      markRuntimeOutputGap(runtimeViewRef.current);
      setRevision((current) => current + 1);
    }

    const controller = new AbortController();
    streamAbortRef.current = controller;
    const version = ++streamVersionRef.current;
    const lastEventId = streamCursorRef.current;
    setSafeConnection(connectionState(status, undefined, lastEventId), status === "reconnecting" ? "reconnecting" : "connecting");

    const scheduleReconnect = (delayMs: number): void => {
      reconnectTimerRef.current = setTimeout(() => {
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        startStream("reconnecting");
      }, delayMs);
    };

    void (async () => {
      let restoringSnapshot = false;
      try {
        if (snapshotRequiredRef.current) {
          restoringSnapshot = true;
          setSafeConnection(connectionState("reconnecting", undefined, streamCursorRef.current), "restoring event snapshot");
          const snapshot = await client.eventSnapshot(runtimeStreamInput(options, controller.signal));
          if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
          runtimeViewRef.current = restoreRuntimeSnapshot(snapshot);
          appliedDurableEventIdsRef.current.clear();
          snapshotCoveredSessionIdsRef.current = new Set(snapshot.coveredSessionIds);
          streamCursorRef.current = snapshot.afterEventId;
          streamFromStartRef.current = snapshot.afterEventId === undefined;
          snapshotRequiredRef.current = false;
          restoringSnapshot = false;
          setRevision((current) => current + 1);
          setSafeConnection(connectionState("reconnecting", undefined, snapshot.afterEventId), snapshot.warning ?? "event snapshot restored");
        }
        const resumeCursor = streamCursorRef.current;
        const request = runtimeStreamInput(options, controller.signal, resumeCursor);
        if (streamFromStartRef.current) request.fromStart = true;
        for await (const event of client.streamEvents(request)) {
          if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
          const applied = applyEventOnce(event);
          if (!isTransientEvent(event)) {
            streamCursorRef.current = event.id;
            streamFromStartRef.current = false;
            runtimeViewRef.current.lastEventId = event.id;
          }
          setConnection(connectionState("streaming", undefined, streamCursorRef.current));
          setMessage(`last event: ${event.type}`);
          if (applied) setRevision((current) => current + 1);
        }
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        markRuntimeOutputGap(runtimeViewRef.current);
        setRevision((current) => current + 1);
        // Normal EOF and transport failure both resume from consumed durable
        // events, retaining the projection and stream/history deduplication.
        const cursor = streamCursorRef.current;
        setSafeConnection(connectionState("reconnecting", undefined, cursor), "stream ended; reconnecting");
        // Drain a bounded backlog promptly, but avoid spinning on empty EOFs.
        scheduleReconnect(cursor !== resumeCursor ? 0 : 1500);
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        markRuntimeOutputGap(runtimeViewRef.current);
        setRevision((current) => current + 1);
        if (!restoringSnapshot && (isEventCursorResyncRequiredError(error) || isEventTransportResyncRequiredError(error))) {
          snapshotRequiredRef.current = true;
          setSafeConnection(connectionState("reconnecting", undefined, streamCursorRef.current), "resyncing event stream");
          startStream("reconnecting");
          return;
        }
        const messageText = toError(error).message;
        setSafeConnection(connectionState("error", messageText, streamCursorRef.current), messageText);
        scheduleReconnect(1500);
      }
    })();
  }, [applyEventOnce, client, options, setSafeConnection]);

  const reconnect = useCallback(() => {
    startStream("reconnecting");
  }, [startStream]);

  const hydrateEvents = useCallback((events: readonly ChiliEvent[]) => {
    if (!mountedRef.current) return;
    let applied = false;
    for (const event of events) {
      // Raw historical deltas already represented by a compact snapshot must
      // not be replayed onto its materialized text/status, including late reads.
      if (event.sessionId && snapshotCoveredSessionIdsRef.current.has(event.sessionId)) continue;
      applied = applyEventOnce(event) || applied;
    }
    if (streamCursorRef.current === undefined) delete runtimeViewRef.current.lastEventId;
    else runtimeViewRef.current.lastEventId = streamCursorRef.current;
    if (applied) setRevision((current) => current + 1);
  }, [applyEventOnce]);

  useEffect(() => {
    mountedRef.current = true;
    startStream("connecting");
    return () => {
      mountedRef.current = false;
      reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
      streamAbortRef.current?.abort();
    };
  }, [startStream]);

  return useMemo(() => ({
    runtimeView: runtimeViewRef.current,
    revision,
    connection,
    message,
    reconnect,
    hydrateEvents,
  }), [connection, hydrateEvents, message, reconnect, revision]);
}

function connectionState(
  status: RuntimeConnectionState["status"],
  error: string | undefined,
  lastEventId: string | undefined,
): RuntimeConnectionState {
  return { status, ...(error ? { error } : {}), ...(lastEventId ? { lastEventId } : {}) };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
