import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  EventCursorResyncRequiredError,
  type HttpRuntimeClient,
  type StreamEventsRequest,
} from "@chili/sdk";
import type {
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import {
  useRuntimeEvents,
  type RuntimeEventsState,
  type RuntimeTuiOptions,
} from "./useRuntimeEvents.js";

test("Runtime stream clears a rejected cursor and projection before reconnecting", async () => {
  const requests: StreamEventsRequest[] = [];
  const sharedEventId = "event_replayed_after_resync";
  const oldEvent = sessionCreatedEvent(sharedEventId, "session_old", 1);
  const freshEvent = sessionCreatedEvent(sharedEventId, "session_fresh", 2);
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) {
        yield oldEvent;
        await waitForAbort(input.signal);
        return;
      }
      if (requests.length === 2) {
        throw new EventCursorResyncRequiredError("cursor expired", input.afterEventId ?? "missing");
      }
      yield freshEvent;
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  const options: RuntimeTuiOptions = {
    baseUrl: "http://chili.test",
  };
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(
      <RuntimeEventsProbe client={client} options={options} onRuntime={(value) => { runtime = value; }} />,
      { width: 80, height: 4, exitOnCtrlC: false },
    );
  });

  try {
    await waitForFrame(app, (frame) => frame.includes(`cursor:${sharedEventId}`) && frame.includes("session_old"));

    await act(async () => {
      runtime?.reconnect();
      await Bun.sleep(5);
      await app.renderOnce();
    });

    await waitForFrame(app, (frame) => frame.includes(`cursor:${sharedEventId}`) && frame.includes("session_fresh"));
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.afterEventId)).toEqual([
      undefined,
      sharedEventId,
      undefined,
    ]);
    const frame = app.captureCharFrame();
    expect(frame).not.toContain("session_old");
    expect(frame).toContain("session_fresh");
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream applies durable events once across the stream and hydration", async () => {
  const events = transcriptDeltaEvents();
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      for (const event of events) yield event;
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  const options: RuntimeTuiOptions = {
    baseUrl: "http://chili.test",
  };
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(
      <RuntimeEventsProbe client={client} options={options} onRuntime={(value) => { runtime = value; }} />,
      { width: 120, height: 4, exitOnCtrlC: false },
    );
  });

  try {
    await waitForFrame(app, (frame) => frame.includes("text:hello"));
    await act(async () => {
      runtime?.hydrateEvents(events);
      await app.renderOnce();
    });

    const frame = app.captureCharFrame();
    expect(frame).toContain("text:hello");
    expect(frame).not.toContain("hellohello");
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream continues applying transient events that reuse an event id", async () => {
  const event = toolOutputDeltaEvent("event_transient_output", "toolcall_transient", "chunk");
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      yield event;
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  const options: RuntimeTuiOptions = {
    baseUrl: "http://chili.test",
  };
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(
      <RuntimeEventsProbe client={client} options={options} onRuntime={(value) => { runtime = value; }} />,
      { width: 120, height: 4, exitOnCtrlC: false },
    );
  });

  try {
    await waitForFrame(app, (frame) => frame.includes("live-deltas:1"));
    await act(async () => {
      runtime?.hydrateEvents([event]);
    });

    await waitForFrame(app, (frame) => frame.includes("live-deltas:2"));
  } finally {
    act(() => app.renderer.destroy());
  }
});

function RuntimeEventsProbe(props: {
  client: HttpRuntimeClient;
  options: RuntimeTuiOptions;
  onRuntime: (runtime: RuntimeEventsState) => void;
}) {
  const runtime = useRuntimeEvents({
    client: props.client,
    options: props.options,
  });
  props.onRuntime(runtime);
  const text = Object.values(runtime.runtimeView.messages)
    .flatMap((message) => message.parts)
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("");
  const liveDeltas = Object.values(runtime.runtimeView.toolCalls)
    .reduce((count, call) => count + (call.liveOutput?.length ?? 0), 0);
  return (
    <text>{`status:${runtime.connection.status} cursor:${runtime.runtimeView.lastEventId ?? "none"} sessions:${runtime.runtimeView.sessionIds.join(",")} text:${text} live-deltas:${liveDeltas}`}</text>
  );
}

function sessionCreatedEvent(id: string, sessionId: string, time: number): ChiliEvent {
  const typedSessionId = sessionId as SessionId;
  return {
    id,
    type: "session.created",
    time: time as TimestampMs,
    sessionId: typedSessionId,
    payload: { sessionId: typedSessionId, cwd: "/repo/chili" },
  };
}

function transcriptDeltaEvents(): ChiliEvent[] {
  const sessionId = "session_durable_dedupe" as SessionId;
  const messageId = "message_durable_dedupe" as MessageId;
  const partId = "part_durable_dedupe" as PartId;
  return [
    sessionCreatedEvent("event_durable_session", sessionId, 1),
    {
      id: "event_durable_message",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_durable_part",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "" },
      },
    },
    {
      id: "event_durable_delta",
      type: "message.part_delta",
      time: 4 as TimestampMs,
      sessionId,
      payload: { messageId, partId, field: "text", delta: "hello" },
    },
  ];
}

function toolOutputDeltaEvent(id: string, callId: string, delta: string): ChiliEvent {
  return {
    id,
    type: "tool.output_delta",
    time: 1 as TimestampMs,
    payload: {
      callId: callId as ToolCallId,
      stream: "stdout",
      delta,
    },
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForFrame(
  app: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await app.renderOnce();
      await Bun.sleep(5);
    });
    if (predicate(app.captureCharFrame())) return;
  }
  throw new Error(`Timed out waiting for frame: ${app.captureCharFrame()}`);
}
