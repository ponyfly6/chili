import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyRuntimeEvent,
  createRuntimeView,
  isEventCursorResyncRequiredError,
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

    const controller = new AbortController();
    streamAbortRef.current = controller;
    const version = ++streamVersionRef.current;
    const lastEventId = runtimeViewRef.current.lastEventId;
    setSafeConnection(connectionState(status, undefined, lastEventId), status === "reconnecting" ? "reconnecting" : "connecting");

    void (async () => {
      try {
        const request = runtimeStreamInput(options, controller.signal, lastEventId);
        for await (const event of client.streamEvents(request)) {
          if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
          const applied = applyEventOnce(event);
          setConnection(connectionState("streaming", undefined, runtimeViewRef.current.lastEventId));
          setMessage(`last event: ${event.type}`);
          if (applied) setRevision((current) => current + 1);
        }
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        setSafeConnection(connectionState("offline", undefined, runtimeViewRef.current.lastEventId), "stream ended");
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted || version !== streamVersionRef.current) return;
        if (isEventCursorResyncRequiredError(error)) {
          runtimeViewRef.current = createRuntimeView();
          appliedDurableEventIdsRef.current.clear();
          setRevision((current) => current + 1);
          setSafeConnection(connectionState("reconnecting", undefined, undefined), "resyncing event stream");
          startStream("reconnecting");
          return;
        }
        const messageText = toError(error).message;
        setSafeConnection(connectionState("error", messageText, runtimeViewRef.current.lastEventId), messageText);
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) startStream("reconnecting");
        }, 1500);
      }
    })();
  }, [applyEventOnce, client, options, setSafeConnection]);

  const reconnect = useCallback(() => {
    startStream("reconnecting");
  }, [startStream]);

  const hydrateEvents = useCallback((events: readonly ChiliEvent[]) => {
    const liveCursor = runtimeViewRef.current.lastEventId;
    let applied = false;
    for (const event of events) applied = applyEventOnce(event) || applied;
    if (liveCursor) runtimeViewRef.current.lastEventId = liveCursor;
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
