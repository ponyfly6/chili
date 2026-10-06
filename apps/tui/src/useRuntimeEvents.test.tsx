import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  EventCursorResyncRequiredError,
  EventTransportResyncRequiredError,
  type HttpRuntimeClient,
  type StreamEventsRequest,
} from "@chili/sdk";
import type {
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  RuntimeStateSnapshot,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import {
  useRuntimeEvents,
  type RuntimeEventsState,
  type RuntimeTuiOptions,
} from "./useRuntimeEvents.js";

test("Runtime stream reconnects after normal rotation and receives the next prompt's events", async () => {
  const requests: StreamEventsRequest[] = [];
  const history = sessionCreatedEvent("event_history", "session_history", 1);
  const fresh = sessionCreatedEvent("event_fresh", "session_fresh", 2);
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) {
        yield history;
        return;
      }
      yield fresh;
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  const options: RuntimeTuiOptions = { baseUrl: "http://chili.test" };
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(
      <RuntimeEventsProbe client={client} options={options} onRuntime={() => {}} />,
      { width: 120, height: 4, exitOnCtrlC: false },
    );
  });

  try {
    await waitForFrame(app, (frame) => frame.includes("cursor:event_fresh"));
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, history.id]);
    expect(app.captureCharFrame()).toContain("session_history,session_fresh");
    expect(app.captureCharFrame()).toContain("status:streaming");
  } finally {
    act(() => app.renderer.destroy());
  }
  expect(requests.at(-1)?.signal?.aborted).toBe(true);
});

for (const unmount of [false, true]) {
  test(unmount
    ? "Runtime stream cancels a pending EOF reconnect on unmount"
    : "Runtime stream backs off after an empty EOF and then reconnects", async () => {
    const requests: StreamEventsRequest[] = [];
    const client = {
      streamEvents: async function* (input: StreamEventsRequest = {}) {
        requests.push(input);
        if (requests.length === 1) return;
        yield sessionCreatedEvent("event_after_empty", "session_fresh", 1);
        await waitForAbort(input.signal);
      },
    } as unknown as HttpRuntimeClient;
    const options: RuntimeTuiOptions = { baseUrl: "http://chili.test" };
    let app!: Awaited<ReturnType<typeof testRender>>;
    let destroyed = false;
    await act(async () => {
      app = await testRender(
        <RuntimeEventsProbe client={client} options={options} onRuntime={() => {}} />,
        { width: 120, height: 4, exitOnCtrlC: false },
      );
    });

    try {
      await waitForFrame(app, (frame) => frame.includes("status:reconnecting"));
      await act(async () => { await Bun.sleep(30); });
      expect(requests).toHaveLength(1);
      if (unmount) {
        act(() => app.renderer.destroy());
        destroyed = true;
      }
      await act(async () => { await Bun.sleep(1550); });
      if (unmount) {
        expect(requests).toHaveLength(1);
      } else {
        await waitForFrame(app, (frame) => frame.includes("cursor:event_after_empty"));
        expect(requests.map((request) => request.afterEventId)).toEqual([undefined, undefined]);
      }
    } finally {
      if (!destroyed) act(() => app.renderer.destroy());
    }
    expect(requests.at(-1)?.signal?.aborted).toBe(true);
  });
}

test("Runtime stream replaces a rejected cursor and projection with an atomic snapshot", async () => {
  const requests: StreamEventsRequest[] = [];
  const sharedEventId = "event_replayed_after_resync";
  const oldEvent = sessionCreatedEvent(sharedEventId, "session_old", 1);
  const freshEvent = sessionCreatedEvent(sharedEventId, "session_fresh", 2);
  const client = {
    eventSnapshot: async () => snapshot([freshEvent], "snapshot_watermark"),
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

    await waitForFrame(app, (frame) => frame.includes("cursor:snapshot_watermark") && frame.includes("session_fresh"));
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.afterEventId)).toEqual([
      undefined,
      sharedEventId,
      "snapshot_watermark",
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

test("Runtime stream restores oversized events through snapshot state and ignores overlapping history", async () => {
  const requests: StreamEventsRequest[] = [];
  const events = transcriptDeltaEvents();
  const client = {
    eventSnapshot: async () => snapshot(events, "snapshot_after_poison"),
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) throw new EventTransportResyncRequiredError("event too large", "event_poison");
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={(value) => { runtime = value; }} />, { width: 160, height: 4, exitOnCtrlC: false });
  });
  try {
    await waitForFrame(app, (frame) => frame.includes("cursor:snapshot_after_poison") && frame.includes("text:hello"));
    await act(async () => { runtime?.hydrateEvents(events); });
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, "snapshot_after_poison"]);
    expect(app.captureCharFrame()).not.toContain("hellohello");
    expect(runtime?.runtimeView.lastEventId).toBe("snapshot_after_poison");
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream retries failed snapshots with backoff instead of replaying the poison event", async () => {
  const requests: StreamEventsRequest[] = [];
  let snapshotAttempts = 0;
  const client = {
    eventSnapshot: async () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) throw new Error("snapshot temporarily unavailable");
      return snapshot([], "snapshot_recovered");
    },
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) throw new EventTransportResyncRequiredError("event too large", "event_poison");
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={() => {}} />, { width: 120, height: 4, exitOnCtrlC: false });
  });
  try {
    await waitForFrame(app, (frame) => frame.includes("status:error"));
    await act(async () => { await Bun.sleep(30); });
    expect(snapshotAttempts).toBe(1);
    expect(requests).toHaveLength(1);
    await act(async () => { await Bun.sleep(1550); });
    await waitForFrame(app, (frame) => frame.includes("cursor:snapshot_recovered"));
    expect(snapshotAttempts).toBe(2);
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, "snapshot_recovered"]);
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream backs off ordinary failures and resumes only the durable events already consumed", async () => {
  const requests: StreamEventsRequest[] = [];
  const events = transcriptDeltaEvents();
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) {
        for (const event of events) yield event;
        throw new Error("network lost");
      }
      // A replayed event already applied from stream or hydration remains once.
      yield events[3]!;
      yield sessionCreatedEvent("event_reconnected", "session_fresh", 5);
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={() => {}} />, { width: 160, height: 4, exitOnCtrlC: false });
  });
  try {
    await waitForFrame(app, (frame) => frame.includes("status:error") && frame.includes("text:hello"));
    await act(async () => { await Bun.sleep(30); });
    expect(requests).toHaveLength(1);
    await act(async () => { await Bun.sleep(1550); });
    await waitForFrame(app, (frame) => frame.includes("cursor:event_reconnected"));
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, "event_durable_delta"]);
    expect(app.captureCharFrame()).not.toContain("hellohello");
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream resumes an empty snapshot from the beginning after transient overflow", async () => {
  const requests: StreamEventsRequest[] = [];
  const client = {
    eventSnapshot: async () => snapshot([]),
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) throw new EventTransportResyncRequiredError("transient overflow", undefined, "transient_buffer_overflow");
      yield sessionCreatedEvent("event_after_snapshot", "session_after_snapshot", 1);
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={() => {}} />, { width: 120, height: 4, exitOnCtrlC: false });
  });
  try {
    await waitForFrame(app, (frame) => frame.includes("cursor:event_after_snapshot"));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.fromStart).toBe(true);
    expect(requests[1]?.afterEventId).toBeUndefined();
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime history hydration cannot advance a global stream cursor before its first event", async () => {
  const requests: StreamEventsRequest[] = [];
  const client = {
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={(value) => { runtime = value; }} />, { width: 120, height: 4, exitOnCtrlC: false });
  });
  try {
    await act(async () => { runtime?.hydrateEvents([sessionCreatedEvent("event_history_only", "session_history_only", 1)]); });
    expect(runtime?.runtimeView.lastEventId).toBeUndefined();
    await act(async () => { runtime?.reconnect(); });
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, undefined]);
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("Runtime stream discards a snapshot completed after reconnect supersedes it", async () => {
  let resolveOld!: (value: RuntimeStateSnapshot) => void;
  const oldSnapshot = new Promise<RuntimeStateSnapshot>((resolve) => { resolveOld = resolve; });
  const snapshotSignals: Array<AbortSignal | undefined> = [];
  const requests: StreamEventsRequest[] = [];
  const client = {
    eventSnapshot: async (input: { signal?: AbortSignal }) => {
      snapshotSignals.push(input.signal);
      return snapshotSignals.length === 1 ? oldSnapshot : snapshot([], "snapshot_current");
    },
    streamEvents: async function* (input: StreamEventsRequest = {}) {
      requests.push(input);
      if (requests.length === 1) throw new EventTransportResyncRequiredError("event too large", "event_poison");
      await waitForAbort(input.signal);
    },
  } as unknown as HttpRuntimeClient;
  let runtime: RuntimeEventsState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<RuntimeEventsProbe client={client} options={{ baseUrl: "http://chili.test" }} onRuntime={(value) => { runtime = value; }} />, { width: 120, height: 4, exitOnCtrlC: false });
  });
  try {
    await waitForFrame(app, () => snapshotSignals.length === 1);
    await act(async () => { runtime?.reconnect(); });
    await waitForFrame(app, (frame) => frame.includes("cursor:snapshot_current"));
    await act(async () => { resolveOld(snapshot([], "snapshot_stale")); });
    expect(runtime?.runtimeView.lastEventId).toBe("snapshot_current");
    expect(snapshotSignals[0]?.aborted).toBe(true);
    expect(requests.map((request) => request.afterEventId)).toEqual([undefined, "snapshot_current"]);
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

function snapshot(events: ChiliEvent[], afterEventId?: string): RuntimeStateSnapshot {
  return {
    version: 1,
    ...(afterEventId === undefined ? {} : { afterEventId }),
    events,
    coveredSessionIds: [...new Set(events.flatMap((event) => event.sessionId ? [event.sessionId] : []))],
    truncated: false,
    temporaryOutput: "not-replayed",
  };
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
