import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  EventCursorResyncRequiredError,
  type HttpRuntimeClient,
  type StreamEventsRequest,
} from "@chili/sdk";
import type { ChiliEvent, SessionId, ThreadId, TimestampMs } from "@chili/protocol";
import {
  useTeamLiveRuntime,
  type TeamLiveRuntimeState,
  type TeamLiveTuiOptions,
} from "./useTeamLiveRuntime.js";

test("Team Live clears a rejected cursor and projection before reconnecting", async () => {
  const requests: StreamEventsRequest[] = [];
  const oldEvent = sessionCreatedEvent("event_old", "session_old", 1);
  const freshEvent = sessionCreatedEvent("event_fresh", "session_fresh", 2);
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
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    runLoop: false,
    once: false,
  };
  let runtime: TeamLiveRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(
      <TeamLiveRuntimeProbe client={client} options={options} onRuntime={(value) => { runtime = value; }} />,
      { width: 80, height: 4, exitOnCtrlC: false },
    );
  });

  try {
    await waitForFrame(app, (frame) => frame.includes("cursor:event_old") && frame.includes("session_old"));

    await act(async () => {
      runtime?.reconnect();
      await Bun.sleep(5);
      await app.renderOnce();
    });

    await waitForFrame(app, (frame) => frame.includes("cursor:event_fresh") && frame.includes("session_fresh"));
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.afterEventId)).toEqual([
      undefined,
      "event_old",
      undefined,
    ]);
    const frame = app.captureCharFrame();
    expect(frame).not.toContain("session_old");
    expect(frame).toContain("session_fresh");
  } finally {
    act(() => app.renderer.destroy());
  }
});

function TeamLiveRuntimeProbe(props: {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
  onRuntime: (runtime: TeamLiveRuntimeState) => void;
}) {
  const runtime = useTeamLiveRuntime({ client: props.client, options: props.options });
  props.onRuntime(runtime);
  return (
    <text>{`status:${runtime.connection.status} cursor:${runtime.runtimeView.lastEventId ?? "none"} sessions:${runtime.runtimeView.sessionIds.join(",")}`}</text>
  );
}

function sessionCreatedEvent(id: string, sessionId: string, time: number): ChiliEvent {
  const typedSessionId = sessionId as SessionId;
  return {
    id,
    type: "session.created",
    time: time as TimestampMs,
    sessionId: typedSessionId,
    threadId: `thread_${sessionId}` as ThreadId,
    payload: { sessionId: typedSessionId, cwd: "/repo/chili" },
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
