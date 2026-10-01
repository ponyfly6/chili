import { describe, expect, test } from "bun:test";
import type { ChiliEvent, SessionId } from "@chili/protocol";
import type { RuntimeClient, RuntimeSessionSummary } from "@chili/sdk";
import {
  parseRemoteControlFrame,
  requiredCapabilityForOperation,
  type RemoteControlInvocationContext,
  type RemoteControlServiceRequest,
} from "@chili/remote-control";
import { DesktopControlService, type DesktopRemoteRootSnapshot } from "./control-service.js";
import {
  DesktopRemoteControlAdapter,
  projectRemoteSessionList,
  projectRemoteSnapshot,
  REMOTE_DESKTOP_MAX_MESSAGES,
  REMOTE_DESKTOP_RESULT_MAX_BYTES,
} from "./remote-control-adapter.js";

describe("real desktop remote adapter boundary", () => {
  for (const mode of ["queue", "steer"] as const) {
    test.each(["remote", "local"] as const)(`a slow ${mode} membership check preserves send before %s Stop`, async (stopOrigin) => {
      const fixture = orderedMembershipHarness();
      const sending = invoke(fixture.adapter, {
        operation: "session.send", payload: { sessionId: "root", text: "older send", mode },
      });
      await until(() => fixture.membershipReads() === 1);
      const stopping = stopOrigin === "remote"
        ? invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } })
        : fixture.service.invoke({ type: "session.stop", sessionId: "root" });
      // The later request's membership is ready, but the older request is not.
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      fixture.membership.resolve([summary("root")]);
      expect(await sending).toEqual({ status: "accepted" });
      expect(await stopping).toEqual({ interrupted: false });
      expect(fixture.order).toEqual(["submit:older send", "desktop_stop"]);
      fixture.adapter.revoke();
    });

    test.each(["remote", "local"] as const)(`a slow Stop membership check preserves Stop before a new %s ${mode}`, async (sendOrigin) => {
      const fixture = orderedMembershipHarness();
      const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
      await until(() => fixture.membershipReads() === 1);
      const sending = sendOrigin === "remote"
        ? invoke(fixture.adapter, { operation: "session.send", payload: { sessionId: "root", text: "new send", mode } })
        : fixture.service.invoke({ type: "session.send", sessionId: "root", text: "new send", mode });
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      fixture.membership.resolve([summary("root")]);
      expect(await stopping).toEqual({ interrupted: false });
      expect(await sending).toEqual({ status: "accepted" });
      expect(fixture.order).toEqual(["desktop_stop", "submit:new send"]);
      fixture.adapter.revoke();
    });
  }

  test("pending remote preflights share one admission deadline instead of multiplying Stop latency", async () => {
    const events = deferred<ChiliEvent[]>();
    const readSignals: AbortSignal[] = [];
    const fixture = harness({ sessionEvents: async ({ signal }) => {
      readSignals.push(signal!);
      return events.promise;
    } }, 60);
    const startedAt = performance.now();
    const sends = Array.from({ length: 8 }, (_, index) => invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: `expired ${index}`, mode: "queue" },
    }).then(() => null, (error: unknown) => error));
    await until(() => readSignals.length > 0);
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    expect(await stopping).toEqual({ interrupted: true });
    expect(performance.now() - startedAt).toBeLessThan(250);
    for (const result of await Promise.all(sends)) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("read timed out");
    }
    // A later actor cannot start a fresh full budget after the first expires.
    // Sub-millisecond admission gaps can allow an additional very short read.
    expect(readSignals.every((signal) => signal.aborted)).toBe(true);
    events.resolve([]);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(fixture.submitted).toEqual([]);
    expect(fixture.queuedCounts).toEqual([]);
    fixture.adapter.revoke();
  });

  test("a send read deadline neither aborts an earlier real write nor discards an authorized Stop", async () => {
    const submission = deferred<{ status: "accepted"; sessionId: SessionId }>();
    const order: string[] = [];
    let writeSignal: AbortSignal | undefined;
    let membershipReads = 0;
    const fixture = harness({
      listSessions: async () => { membershipReads += 1; return [summary("root")]; },
      submitPromptAsync: async ({ text, signal }) => {
        order.push(`submit:${text}`);
        writeSignal = signal;
        return submission.promise;
      },
      interruptSession: async () => { order.push("stop"); return { interrupted: true }; },
    }, 20);
    const first = fixture.service.invoke({ type: "session.send", sessionId: "root", text: "real write", mode: "queue" });
    await until(() => writeSignal !== undefined);
    const later = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "expired preflight", mode: "queue" },
    }).then(() => null, (error: unknown) => error);
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    await until(() => membershipReads === 2);
    // Let only the read budget expire while a real mutation response is held.
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(writeSignal?.aborted).toBe(false);
    expect(order).toEqual(["submit:real write"]);
    submission.resolve({ status: "accepted", sessionId: "root" as SessionId });
    expect(await first).toEqual({ status: "accepted" });
    const expired = await later;
    expect(expired).toBeInstanceOf(Error);
    expect((expired as Error).message).toContain("read timed out");
    expect(await stopping).toEqual({ interrupted: true });
    expect(order).toEqual(["submit:real write", "stop"]);
    expect(writeSignal?.aborted).toBe(false);
    fixture.adapter.revoke();
  });

  test("reserves remote write quotas before membership IO and releases each slot after completion", async () => {
    const membership = deferred<RuntimeSessionSummary[]>();
    let membershipReads = 0;
    const fixture = harness({ listSessions: async () => { membershipReads += 1; return membership.promise; } });
    const sending = Array.from({ length: 8 }, (_, index) => invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: `item ${index}`, mode: "queue" },
    }));
    await until(() => membershipReads === 8);
    await expect(invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "overflow", mode: "queue" },
    })).rejects.toThrow("Too many pending desktop send operations");
    expect(membershipReads).toBe(8);
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    await until(() => membershipReads === 9);
    membership.resolve([summary("root")]);
    expect((await Promise.all(sending)).map((result) => (result as { status: string }).status))
      .toEqual(["accepted", "queued", "queued", "queued", "queued", "queued", "queued", "queued"]);
    expect(await stopping).toEqual({ interrupted: true });
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "capacity restored", mode: "queue" },
    })).toMatchObject({ status: "queued" });
    expect(membershipReads).toBe(10);
    fixture.adapter.revoke();
  });

  test.each(["child", "foreign", "archived", "missing"] as const)("a denied %s Stop cannot mutate or cancel a later desktop send", async (kind) => {
    const membership = deferred<RuntimeSessionSummary[]>();
    const fixture = harness({ listSessions: () => membership.promise });
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } })
      .then(() => null, (error: unknown) => error);
    const sending = fixture.service.invoke({ type: "session.send", sessionId: "root", text: "allowed local", mode: "queue" });
    membership.resolve(kind === "missing" ? [] : [{ ...summary("root"),
      ...(kind === "child" ? { source: "subagent" as const } : {}),
      ...(kind === "foreign" ? { cwd: "/other" } : {}),
      ...(kind === "archived" ? { status: "archived" as const } : {}),
    }]);
    expect(await stopping).toBeInstanceOf(Error);
    expect(await sending).toEqual({ status: "accepted" });
    expect(fixture.submitted).toEqual(["allowed local"]);
    expect(fixture.interrupts).toEqual([]);
    fixture.adapter.revoke();
  });

  test("device scopes share the task actor without blocking a different task", async () => {
    const fixture = orderedMembershipHarness();
    const otherDevice = new DesktopRemoteControlAdapter({ controlService: fixture.service });
    const sending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "first device", mode: "queue" },
    });
    await until(() => fixture.membershipReads() === 1);
    const stopping = invoke(otherDevice, { operation: "session.stop", payload: { sessionId: "root" } });
    expect(await fixture.service.invoke({ type: "session.send", sessionId: "other-task", text: "independent", mode: "queue" }))
      .toEqual({ status: "accepted" });
    expect(fixture.order).toEqual(["submit:independent"]);
    fixture.membership.resolve([summary("root")]);
    expect(await sending).toEqual({ status: "accepted" });
    expect(await stopping).toEqual({ interrupted: false });
    expect(fixture.order).toEqual(["submit:independent", "submit:first device", "desktop_stop"]);
    otherDevice.revoke();
    fixture.adapter.revoke();
  });

  test("lists only existing root tasks in the enabled workspace and never searches hidden paths", async () => {
    const legacy = summary("legacy");
    delete legacy.source;
    const fixture = harness({ listSessions: async () => [
      summary("root"),
      legacy,
      { ...summary("child"), source: "subagent" },
      { ...summary("other"), cwd: "/other/private" },
      { ...summary("nested"), cwd: "/repo/nested" },
    ] });
    const list = await invoke(fixture.adapter, { operation: "sessions.list", payload: {} });
    expect(list).toEqual({ sessions: [
      { id: "root", title: "Root task", status: "active", updatedAt: 2 },
      { id: "legacy", title: "Root task", status: "active", updatedAt: 2 },
    ], truncated: false });
    expect(await invoke(fixture.adapter, { operation: "sessions.list", payload: { query: "/repo" } }))
      .toEqual({ sessions: [], truncated: false });
    fixture.adapter.revoke();
  });

  test("checks every target operation independently and refuses child, foreign, missing and archived mutation targets", async () => {
    let targetReads = 0;
    const fixture = harness({
      listSessions: async () => [summary("root"), { ...summary("child"), source: "subagent" },
        { ...summary("foreign"), cwd: "/other" }, { ...summary("archived"), status: "archived" }],
      sessionEvents: async () => { targetReads += 1; return []; },
    });
    for (const sessionId of ["child", "foreign", "missing"]) {
      for (const request of [
        { operation: "session.snapshot", payload: { sessionId } },
        { operation: "session.send", payload: { sessionId, text: "do work", mode: "queue" } },
        { operation: "session.stop", payload: { sessionId } },
      ] as RemoteControlServiceRequest[]) {
        await expect(invoke(fixture.adapter, request)).rejects.toThrow("not available");
      }
    }
    await expect(invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "archived", text: "work", mode: "queue" },
    })).rejects.toThrow("Archived");
    await expect(invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "archived" } }))
      .rejects.toThrow("Archived");
    expect(targetReads).toBe(0);
    expect(fixture.submitted).toEqual([]);
    expect(fixture.interrupts).toEqual([]);
    fixture.adapter.revoke();
  });

  test("desktop and remote Queue/Steer/Stop use the same session actor and queue", async () => {
    const fixture = harness();
    expect(await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" }))
      .toEqual({ status: "accepted" });
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "mobile queue", mode: "queue" },
    })).toEqual({ status: "queued", position: 1 });
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "mobile steer", mode: "steer" },
    })).toEqual({ status: "queued", position: 1 });
    const snapshot = await invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "root" } });
    expect(snapshot).toMatchObject({ session: { queuedCount: 2 } });
    expect(await invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } }))
      .toEqual({ interrupted: true });
    expect(fixture.submitted).toEqual(["desktop"]);
    expect(fixture.interrupts).toEqual(["desktop_steer", "desktop_stop"]);
    expect(fixture.queuedCounts).toEqual([1, 2]);
    fixture.adapter.revoke();
  });

  test.each(["queue", "steer"] as const)("remote %s is never requeued after the runtime commits but its response fails", async (mode) => {
    const delivered: string[] = [];
    const fixture = harness({ submitPromptAsync: async ({ text }) => {
      delivered.push(text);
      if (text === "remote work") throw new Error("202 response lost after runtime commit");
      return { status: "accepted", sessionId: "root" as SessionId };
    } });
    await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "remote work", mode },
    })).toEqual({ status: "queued", position: 1 });
    fixture.service.observeEvent(event("session.status_changed", { sessionId: "root", status: "idle" }), 1);
    await until(() => fixture.errors.length === 1);
    expect(delivered).toEqual(["desktop", "remote work"]);
    expect(fixture.errors[0]?.message).toContain("result is unknown");
    expect(await invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "root" } }))
      .toMatchObject({ session: { queuedCount: 0, deliveryUnknown: true } });

    // Further idle events, healthy-state flushes, Stop, and a new authorization
    // must not turn the lost response into another runtime submission.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fixture.service.observeEvent(event("session.status_changed", { sessionId: "root", status: "idle" }), 1);
      fixture.service.observeState({ sidecar: { phase: "healthy", attempt: 0 }, queuedBySession: {} }, 1);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    await invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    fixture.adapter.revoke();
    const reauthorized = new DesktopRemoteControlAdapter({ controlService: fixture.service });
    expect(await invoke(reauthorized, { operation: "session.snapshot", payload: { sessionId: "root" } }))
      .toMatchObject({ session: { deliveryUnknown: true } });
    expect(delivered).toEqual(["desktop", "remote work"]);
    reauthorized.revoke();
    fixture.service.clearQueues();
  });

  test("local queued prompts retain the existing retry behavior", async () => {
    const delivered: string[] = [];
    let failOnce = true;
    const fixture = harness({ submitPromptAsync: async ({ text }) => {
      delivered.push(text);
      if (text === "local queued" && failOnce) {
        failOnce = false;
        throw new Error("local transport failure");
      }
      return { status: "accepted", sessionId: "root" as SessionId };
    } });
    await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "local queued", mode: "queue" });
    fixture.service.observeEvent(event("session.status_changed", { sessionId: "root", status: "idle" }), 1);
    await until(() => fixture.errors.length === 1);
    fixture.service.observeState({ sidecar: { phase: "healthy", attempt: 0 }, queuedBySession: {} }, 1);
    await until(() => delivered.length === 3);
    expect(delivered).toEqual(["desktop", "local queued", "local queued"]);
    expect(await invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "root" } }))
      .toMatchObject({ session: { deliveryUnknown: false } });
    fixture.adapter.revoke();
  });

  test("workspace and sidecar changes while checking membership cannot reach a new runtime", async () => {
    const gate = deferred<RuntimeSessionSummary[]>();
    const fixture = harness({ listSessions: () => gate.promise });
    const sending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "stale", mode: "queue" },
    });
    fixture.replaceWorkspace("/other");
    gate.resolve([summary("root")]);
    await expect(sending).rejects.toThrow();
    expect(fixture.submitted).toEqual([]);
    fixture.replaceWorkspace("/repo");
    await expect(invoke(fixture.adapter, { operation: "sessions.list", payload: {} })).rejects.toThrow();
    fixture.adapter.revoke();
  });

  test("revoke immediately releases a slow membership read and denies all later operations", async () => {
    const gate = deferred<RuntimeSessionSummary[]>();
    const fixture = harness({ listSessions: () => gate.promise });
    const sending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "stale", mode: "queue" },
    });
    fixture.adapter.revoke();
    await expect(sending).rejects.toThrow("no longer available");
    gate.resolve([summary("root")]);
    await expect(invoke(fixture.adapter, { operation: "sessions.list", payload: {} })).rejects.toThrow();
    expect(fixture.submitted).toEqual([]);
  });

  test("revoke also prevents a remote send already waiting behind a local actor", async () => {
    const gate = deferred<ChiliEvent[]>();
    let eventReads = 0;
    const fixture = harness({ sessionEvents: () => { eventReads += 1; return gate.promise; } });
    const desktopSending = fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    await until(() => eventReads === 1);
    const mobileSending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "mobile", mode: "queue" },
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.adapter.revoke();
    gate.resolve([]);
    await expect(mobileSending).rejects.toThrow();
    expect(await desktopSending).toEqual({ status: "accepted" });
    expect(fixture.submitted).toEqual(["desktop"]);
    expect(fixture.queuedCounts).toEqual([]);
  });

  test("revoking one device releases its membership read without revoking other devices or the desktop", async () => {
    const gate = deferred<RuntimeSessionSummary[]>();
    let reads = 0;
    const fixture = harness({ listSessions: () => {
      reads += 1;
      return reads === 1 ? gate.promise : Promise.resolve([summary("root")]);
    } });
    const device = new AbortController();
    const sending = fixture.adapter.invoke({
      operation: "session.send", payload: { sessionId: "root", text: "revoked device", mode: "queue" },
    }, { ...context("session.send"), signal: device.signal });
    await until(() => reads === 1);
    device.abort();
    await expect(sending).rejects.toThrow("no longer available");
    gate.resolve([summary("root")]);
    expect(await invoke(fixture.adapter, { operation: "sessions.list", payload: {} })).toMatchObject({
      sessions: [{ id: "root" }],
    });
    await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop survives", mode: "queue" });
    expect(fixture.submitted).toEqual(["desktop survives"]);
    fixture.adapter.revoke();
  });

  test("a revoked device cannot execute a send waiting behind the desktop actor; another device still can", async () => {
    const gate = deferred<ChiliEvent[]>();
    let eventReads = 0;
    const fixture = harness({ sessionEvents: () => { eventReads += 1; return gate.promise; } });
    const desktopSending = fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    await until(() => eventReads === 1);
    const device = new AbortController();
    const revokedSending = fixture.adapter.invoke({
      operation: "session.send", payload: { sessionId: "root", text: "revoked", mode: "queue" },
    }, { ...context("session.send"), signal: device.signal });
    // Let membership and admission settle while the local actor remains gated.
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    device.abort();
    const otherSending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "other device", mode: "queue" },
    });
    gate.resolve([]);
    expect(await desktopSending).toEqual({ status: "accepted" });
    await expect(revokedSending).rejects.toThrow();
    expect(await otherSending).toEqual({ status: "queued", position: 1 });
    expect(fixture.submitted).toEqual(["desktop"]);
    expect(fixture.queuedCounts).toEqual([1]);
    fixture.adapter.revoke();
  });

  test("an already revoked device never even reads membership", async () => {
    let reads = 0;
    const fixture = harness({ listSessions: async () => { reads += 1; return [summary("root")]; } });
    const device = new AbortController();
    device.abort();
    await expect(fixture.adapter.invoke({ operation: "session.stop", payload: { sessionId: "root" } }, {
      ...context("session.stop"), signal: device.signal,
    })).rejects.toThrow();
    expect(reads).toBe(0);
    expect(fixture.interrupts).toEqual([]);
    fixture.adapter.revoke();
  });

  test("revocation during the optimistic busy await cannot enqueue a late prompt", async () => {
    const fixture = harness();
    await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    const device = new AbortController();
    // Inject cancellation precisely at the await, including the in-memory fast
    // path that performs no SDK read and therefore cannot rely on SDK aborts.
    const serviceBoundary = fixture.service as unknown as {
      isBusy(sessionId: string, lease: unknown): Promise<boolean>;
    };
    const original = serviceBoundary.isBusy;
    serviceBoundary.isBusy = function(sessionId, lease) {
      const result = original.call(fixture.service, sessionId, lease);
      queueMicrotask(() => device.abort());
      return result;
    };
    await expect(fixture.adapter.invoke({
      operation: "session.send", payload: { sessionId: "root", text: "revoked", mode: "queue" },
    }, { ...context("session.send"), signal: device.signal })).rejects.toThrow();
    serviceBoundary.isBusy = original;
    expect(fixture.submitted).toEqual(["desktop"]);
    expect(fixture.queuedCounts).toEqual([]);
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "other device", mode: "queue" },
    })).toEqual({ status: "queued", position: 1 });
    fixture.adapter.revoke();
  });

  test("a slow root snapshot does not occupy the stop actor and never traverses descendants", async () => {
    const gate = deferred<ChiliEvent[]>();
    let reads = 0;
    const fixture = harness({
      sessionEventWindow: async ({ sessionId }) => {
        expect(String(sessionId)).toBe("root");
        reads += 1;
        return { events: await gate.promise, pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [] };
      },
      agentTree: async () => { throw new Error("must not fetch agent tree"); },
      listTasks: async () => { throw new Error("must not fetch child tasks"); },
    });
    const reading = invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "root" } });
    await until(() => reads === 1);
    expect(await invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } }))
      .toEqual({ interrupted: true });
    expect(fixture.interrupts).toEqual(["desktop_stop"]);
    gate.resolve([]);
    await reading;
    fixture.adapter.revoke();
  });

  test.each(["busy", "goal"] as const)("a slow local send %s read times out before Stop and never submits late", async (slowRead) => {
    const gate = deferred<unknown>();
    let readSignal: AbortSignal | undefined;
    const fixture = harness({
      sessionEvents: async ({ signal }) => {
        if (slowRead !== "busy") return [];
        readSignal = signal;
        return await gate.promise as ChiliEvent[];
      },
      getGoal: async ({ signal }) => {
        readSignal = signal;
        return await gate.promise as undefined;
      },
    }, 25);
    const started = Date.now();
    const sending = fixture.service.invoke({
      type: "session.send", sessionId: "root", text: "must not submit", mode: slowRead === "goal" ? "steer" : "queue",
    });
    await until(() => readSignal !== undefined);
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    await expect(sending).rejects.toThrow("read timed out");
    expect(await stopping).toEqual({ interrupted: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readSignal?.aborted).toBe(true);
    gate.resolve(slowRead === "busy" ? [] : undefined);
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(fixture.submitted).toEqual([]);
    expect(fixture.queuedCounts).toEqual([]);
    expect(fixture.interrupts).toEqual(["desktop_stop"]);
    fixture.adapter.revoke();
  });

  test("slow membership stays outside actors and its deadline cancels the underlying HTTP signal", async () => {
    let reads = 0;
    let readSignal: AbortSignal | undefined;
    const gate = deferred<RuntimeSessionSummary[]>();
    const fixture = harness({ listSessions: async (input) => {
      reads += 1;
      if (reads > 1) return [summary("root")];
      readSignal = input?.signal;
      return gate.promise;
    } }, 25);
    const reading = invoke(fixture.adapter, { operation: "sessions.list", payload: {} });
    await until(() => reads === 1);
    expect(await invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } }))
      .toEqual({ interrupted: true });
    expect(readSignal?.aborted).toBe(false);
    await expect(reading).rejects.toThrow("read timed out");
    expect(readSignal?.aborted).toBe(true);
    gate.resolve([summary("root")]);
    fixture.adapter.revoke();
  });

  test("a failed parallel snapshot read aborts its hanging sibling and preserves the original error", async () => {
    let siblingSignal: AbortSignal | undefined;
    const gate = deferred<never[]>();
    const fixture = harness({
      sessionEventWindow: async () => { throw new Error("original snapshot failure"); },
      listUserInputs: async (input) => { siblingSignal = input?.signal; return gate.promise; },
    });
    await expect(invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "root" } }))
      .rejects.toThrow("original snapshot failure");
    expect(siblingSignal?.aborted).toBe(true);
    gate.resolve([]);
    fixture.adapter.revoke();
  });

  test("embedding configuration cannot extend the production five-second read deadline", () => {
    expect(() => harness({}, 5_001)).toThrow("between 1 and 5000");
  });

  test("rejects extra path/permission fields, unsupported operations, oversized prompts and wrong capabilities", async () => {
    const fixture = harness();
    for (const invalid of [
      { operation: "workspace.select", payload: {} },
      { operation: "sessions.create", payload: { cwd: "/other" } },
      { operation: "permissions.set", payload: { profile: "full-access" } },
      { operation: "session.send", payload: { sessionId: "root", text: "work", mode: "queue", cwd: "/other" } },
      { operation: "session.send", payload: { sessionId: "root", text: "x".repeat(32_769), mode: "queue" } },
      { operation: "session.snapshot", payload: { sessionId: "../../secret" } },
    ]) {
      await expect(invoke(fixture.adapter, invalid as RemoteControlServiceRequest)).rejects.toThrow();
    }
    await expect(fixture.adapter.invoke({ operation: "session.stop", payload: { sessionId: "root" } }, {
      ...context("session.stop"), capability: "sessions.read",
    })).rejects.toThrow("capability");
    expect(fixture.submitted).toEqual([]);
    expect(fixture.interrupts).toEqual([]);
    fixture.adapter.revoke();
  });
});

describe("remote snapshot whitelist and complete serialization budget", () => {
  test("exports only root user/assistant text and desktop-attention flags", () => {
    const events = [
      ...messageEvents("user", "hello"),
      ...messageEvents("assistant", "safe answer", "root", 10),
      ...messageEvents("system", "SECRET_SYSTEM", "root", 20),
      ...messageEvents("tool", "SECRET_TOOL", "root", 30),
      ...messageEvents("assistant", "SECRET_CHILD", "child", 40),
      event("message.part_added", { messageId: "message_10", part: {
        id: "reasoning", messageId: "message_10", sessionId: "root", type: "reasoning", text: "SECRET_REASONING",
      } }),
      event("message.part_added", { messageId: "message_10", part: {
        id: "tool", messageId: "message_10", sessionId: "root", type: "tool_result", output: "SECRET_OUTPUT",
        callId: "call_1", metadata: { credential: "SECRET_CREDENTIAL" },
      } }),
      event("message.part_added", { messageId: "message_10", part: {
        id: "synthetic", messageId: "message_10", sessionId: "root", type: "text", text: "SECRET_SYNTHETIC", synthetic: true,
      } }),
    ];
    const projected = projectRemoteSnapshot({
      ...rootSnapshot(events), needsDesktop: { approval: true, input: true },
    });
    expect(projected.messages.map((message) => message.text)).toEqual(["hello", "safe answer"]);
    expect(projected.session.needsDesktop).toEqual({ approval: true, input: true });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("/repo");
    expect(Object.keys(projected).sort()).toEqual(["messages", "session", "truncated"]);
    expect(Object.keys(projected.session).sort()).toEqual([
      "deliveryUnknown", "id", "needsDesktop", "queuedCount", "runStatus", "status", "title", "updatedAt",
    ]);
    assertFitsWire(projected);
  });

  test.each(["\u0000\n\t\\\"", "中🌶️文", "\ud800", "\udfff", "plain"])(
    "measures all serialized fields, Unicode and escaping (%s)", (unit) => {
      const text = unit.repeat(15_000);
      const events = Array.from({ length: 55 }, (_, index) => messageEvents("assistant", text, "root", index * 10)).flat();
      const projected = projectRemoteSnapshot({ ...rootSnapshot(events), session: { ...summary("root"), title: text } });
      expect(projected.truncated).toBe(true);
      expect(projected.messages.length).toBeGreaterThan(0);
      expect(projected.messages.length).toBeLessThanOrEqual(REMOTE_DESKTOP_MAX_MESSAGES);
      expect(projected.messages.at(-1)?.id).toBe("message_540");
      expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(REMOTE_DESKTOP_RESULT_MAX_BYTES);
      assertFitsWire(projected);
    },
  );

  test("caps message count independently and preserves the newest messages", () => {
    const projected = projectRemoteSnapshot(rootSnapshot(Array.from({ length: 80 }, (_, index) =>
      messageEvents("user", `text ${index}`, "root", index * 10)).flat()));
    expect(projected.messages).toHaveLength(40);
    expect(projected.messages[0]?.text).toBe("text 40");
    expect(projected.messages.at(-1)?.text).toBe("text 79");
    expect(projected.truncated).toBe(true);
  });

  test("list has a complete byte/entry cap even with maximal titles and omits invalid IDs", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ...summary(`session_${index}`), title: "\u0000\ud800🌶️".repeat(10_000), preview: "SECRET_PREVIEW",
    }));
    rows.push({ ...summary("../../secret"), title: "SECRET_INVALID", preview: "SECRET_PREVIEW" });
    const projected = projectRemoteSessionList(rows);
    expect(projected.sessions.length).toBeLessThanOrEqual(100);
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("SECRET");
    assertFitsWire(projected);
  });
});

function summary(id: string): RuntimeSessionSummary {
  return { id: id as SessionId, cwd: "/repo", title: "Root task", source: "interactive", status: "active", createdAt: 1, updatedAt: 2 };
}

function rootSnapshot(events: ChiliEvent[]): DesktopRemoteRootSnapshot {
  return { session: summary("root"), events, queuedCount: 0, deliveryUnknown: false,
    needsDesktop: { approval: false, input: false }, truncated: false };
}

function context(operation: RemoteControlServiceRequest["operation"]): RemoteControlInvocationContext {
  return {
    hostId: "host-test", deviceId: "device-test", sessionId: "stream-test", sequence: 1,
    requestId: "request-test", idempotencyKey: "request-test", capability: requiredCapabilityForOperation(operation),
  } as RemoteControlInvocationContext;
}

function invoke(adapter: DesktopRemoteControlAdapter, request: RemoteControlServiceRequest) {
  return adapter.invoke(request, context(request.operation));
}

function orderedMembershipHarness() {
  const membership = deferred<RuntimeSessionSummary[]>();
  let reads = 0;
  const order: string[] = [];
  const fixture = harness({
    listSessions: async () => {
      reads += 1;
      return reads === 1 ? membership.promise : [summary("root")];
    },
    submitPromptAsync: async ({ text }) => {
      order.push(`submit:${text}`);
      return { status: "accepted", sessionId: "root" as SessionId };
    },
    interruptSession: async ({ reason }) => {
      order.push(reason ?? "interrupt");
      return { interrupted: false };
    },
  });
  return { ...fixture, membership, membershipReads: () => reads, order };
}

function harness(overrides: Partial<RuntimeClient> = {}, controlReadTimeoutMs = 5_000) {
  let workspace = "/repo";
  let generation = 1;
  const submitted: string[] = [];
  const interrupts: string[] = [];
  const queuedCounts: number[] = [];
  const errors: Error[] = [];
  const client = {
    listSessions: async () => [summary("root")],
    sessionEvents: async () => [],
    listPendingApprovals: async () => [],
    listUserInputs: async () => [],
    getGoal: async () => undefined,
    submitPromptAsync: async ({ text }: { text: string }) => {
      submitted.push(text);
      return { status: "accepted", sessionId: "root" };
    },
    interruptSession: async ({ reason }: { reason: string }) => {
      interrupts.push(reason);
      return { interrupted: true };
    },
    ...overrides,
  } as unknown as RuntimeClient;
  const service = new DesktopControlService({
    controlReadTimeoutMs,
    sidecar: {
      currentWorkspace: () => workspace,
      currentGeneration: () => generation,
      getClientContext: () => ({ client, generation }),
      setQueuedCount: (_sessionId: string, count: number) => queuedCounts.push(count),
    } as never,
    selectWorkspace: async () => undefined,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError: (error) => { errors.push(error); },
  });
  return {
    service, adapter: new DesktopRemoteControlAdapter({ controlService: service }), submitted, interrupts, queuedCounts, errors,
    replaceWorkspace: (value: string) => { workspace = value; generation += 1; },
  };
}

let nextEventId = 0;
function event(type: string, payload: unknown, sessionId = "root"): ChiliEvent {
  nextEventId += 1;
  return { id: `event_${nextEventId}`, type, time: nextEventId, sessionId, payload } as ChiliEvent;
}

function messageEvents(role: string, text: string, sessionId = "root", suffix = 0): ChiliEvent[] {
  const messageId = `message_${suffix}`;
  return [
    event("message.created", { messageId, role }, sessionId),
    event("message.part_added", { messageId, part: {
      id: `part_${suffix}`, messageId, sessionId, type: "text", text,
    } }, sessionId),
  ];
}

function assertFitsWire(result: unknown): void {
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(REMOTE_DESKTOP_RESULT_MAX_BYTES);
  expect(() => parseRemoteControlFrame({
    version: 1, type: "result", hostId: "h".repeat(128), sessionId: "s".repeat(128),
    sequence: 2_147_483_647, requestId: "r".repeat(128), result,
  })).not.toThrow();
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  throw new Error("Condition did not become true");
}
