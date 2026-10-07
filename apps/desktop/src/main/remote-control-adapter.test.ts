import { acceptedInput, emptyInputQueue } from "./testing/input-receipts.js";
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
    const fixture = harness({ listSessions: async (input) => {
      if (readSignals.length >= 8) return [summary("root")];
      readSignals.push(input!.signal!);
      return events.promise as unknown as Promise<RuntimeSessionSummary[]>;
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
    expect(fixture.queuedCounts.every((count) => count === 0)).toBe(true);
    fixture.adapter.revoke();
  });

  test("completed membership stays valid while waiting for an earlier admitted write", async () => {
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
      operation: "session.send", payload: { sessionId: "root", text: "authorized follow-up", mode: "queue" },
    }).then(() => null, (error: unknown) => error);
    const stopping = invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } });
    await until(() => membershipReads === 2);
    // Let only the read budget expire while a real mutation response is held.
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(writeSignal?.aborted).toBe(false);
    expect(order).toEqual(["submit:real write"]);
    submission.resolve({ status: "accepted", sessionId: "root" as SessionId });
    expect(await first).toEqual({ status: "accepted" });
    expect(await later).toBeNull();
    expect(await stopping).toEqual({ interrupted: true });
    expect(order).toEqual(["submit:real write", "submit:authorized follow-up", "stop"]);
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
      .toEqual(Array(8).fill("accepted"));
    expect(await stopping).toEqual({ interrupted: true });
    expect(await invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "capacity restored", mode: "queue" },
    })).toMatchObject({ status: "accepted" });
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
      ...(kind === "child" ? { agent: { parentSessionId: "parent" as never, name: "child", path: "/root/child" as never, policy: {} } } : {}),
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
    const fixture = harness({ listSessions: async () => [
      summary("root"),
      legacy,
      { ...summary("child"), agent: { parentSessionId: "root" as never, name: "child", path: "/root/child" as never, policy: {} } },
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
      listSessions: async () => [summary("root"), { ...summary("child"), agent: { parentSessionId: "root" as never, name: "child", path: "/root/child" as never, policy: {} } },
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

  test("archived sessions stay listable and readable while remote send and stop are rejected", async () => {
    const fixture = harness({ listSessions: async () => [{ ...summary("archived"), status: "archived" }] });
    expect(await invoke(fixture.adapter, { operation: "sessions.list", payload: {} }))
      .toMatchObject({ sessions: [{ id: "archived", status: "archived" }] });
    expect(await invoke(fixture.adapter, { operation: "session.snapshot", payload: { sessionId: "archived" } }))
      .toMatchObject({ session: { id: "archived", status: "archived" }, messages: [] });
    for (const mode of ["queue", "steer"] as const) {
      await expect(invoke(fixture.adapter, { operation: "session.send", payload: { sessionId: "archived", text: "resume", mode } }))
        .rejects.toThrow("Archived");
    }
    await expect(invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "archived" } }))
      .rejects.toThrow("Archived");
    expect(fixture.submitted).toEqual([]);
    expect(fixture.interrupts).toEqual([]);
    fixture.adapter.revoke();
  });

  test("remote submissions preserve the authenticated stable ID and trusted source", async () => {
    const received: Array<{ submissionId?: string; inputSource?: string; mode?: string }> = [];
    const fixture = harness({ submitPromptAsync: async (input) => { received.push(input); return acceptedInput("root"); } });
    await fixture.adapter.invoke({ operation: "session.send", payload: { sessionId: "root", text: "remote work", mode: "steer" } },
      { ...context("session.send"), idempotencyKey: "authenticated_request_123" });
    expect(received[0]).toMatchObject({ submissionId: "authenticated_request_123", mode: "steer" });
    expect(received[0]?.inputSource?.startsWith("remote:")).toBe(true);
    fixture.adapter.revoke();
  });

  test("revoking a scope durably revokes each source that admitted work", async () => {
    const sources: string[] = [];
    let admittedSource: string | undefined;
    const fixture = harness({
      submitPromptAsync: async (input) => { admittedSource = input.inputSource; return acceptedInput("root", "pending", true); },
      cancelInputsFromSource: async (input) => { sources.push(input.source); return emptyInputQueue(input.sessionId, true, 2); },
    });
    await invoke(fixture.adapter, { operation: "session.send", payload: { sessionId: "root", text: "pending", mode: "queue" } });
    fixture.adapter.revoke();
    await until(() => sources.length === 1);
    expect(sources).toEqual([admittedSource!]);
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
    const gate = deferred<void>();
    let eventReads = 0;
    const fixture = harness({ submitPromptAsync: async (input) => { eventReads += 1; await gate.promise; return acceptedInput(input.sessionId, input.text); } });
    const desktopSending = fixture.service.invoke({ type: "session.send", sessionId: "root", text: "desktop", mode: "queue" });
    await until(() => eventReads === 1);
    const mobileSending = invoke(fixture.adapter, {
      operation: "session.send", payload: { sessionId: "root", text: "mobile", mode: "queue" },
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.adapter.revoke();
    gate.resolve(undefined as never);
    await expect(mobileSending).rejects.toThrow();
    expect(await desktopSending).toEqual({ status: "accepted" });
    expect(fixture.submitted).toEqual([]);
    expect(fixture.queuedCounts.every((count) => count === 0)).toBe(true);
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
    const gate = deferred<void>();
    let eventReads = 0;
    const fixture = harness({ submitPromptAsync: async (input) => { eventReads += 1; await gate.promise; return acceptedInput(input.sessionId, input.text); } });
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
    gate.resolve(undefined as never);
    expect(await desktopSending).toEqual({ status: "accepted" });
    await expect(revokedSending).rejects.toThrow();
    expect(await otherSending).toEqual({ status: "accepted" });
    expect(fixture.submitted).toEqual([]);
    expect(fixture.queuedCounts.every((count) => count === 0)).toBe(true);
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

  test("a slow root snapshot does not occupy the stop actor and never traverses descendants", async () => {
    const gate = deferred<ChiliEvent[]>();
    let reads = 0;
    const fixture = harness({
      sessionEventWindow: async ({ sessionId }) => {
        expect(String(sessionId)).toBe("root");
        reads += 1;
        return { events: await gate.promise, pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [] };
      },
      listAgents: async () => { throw new Error("must not fetch child Agents"); },
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

  test("local send no longer waits for client-side busy or Goal preflight", async () => {
    const fixture = harness({ sessionEvents: async () => { throw new Error("unused busy read"); }, getGoal: async () => { throw new Error("unused Goal read"); } });
    expect(await fixture.service.invoke({ type: "session.send", sessionId: "root", text: "work", mode: "steer" })).toEqual({ status: "accepted" });
    expect(await invoke(fixture.adapter, { operation: "session.stop", payload: { sessionId: "root" } })).toEqual({ interrupted: true });
    expect(fixture.submitted).toEqual(["work"]);
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
    gate.resolve(undefined as never);
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
  test("exports only public session metadata", () => {
    const session = { ...summary("archived"), status: "archived" as const, cwd: "/SECRET/path", preview: "SECRET_PREVIEW" };
    const projected = projectRemoteSessionList([session, summary("root")]);
    expect(projected.sessions).toEqual([
      { id: "archived", title: "Root task", status: "archived", updatedAt: 2 },
      { id: "root", title: "Root task", status: "active", updatedAt: 2 },
    ]);
    const snapshot = projectRemoteSnapshot({ ...rootSnapshot([]), session });
    expect(Object.keys(snapshot.session).sort()).toEqual([
      "deliveryUnknown", "id", "needsDesktop", "queuedCount", "runStatus", "status", "title", "updatedAt",
    ]);
    expect(JSON.stringify([projected, snapshot])).not.toContain("SECRET");
    assertFitsWire(snapshot);
  });

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
  return { id: id as SessionId, cwd: "/repo", title: "Root task", status: "active", createdAt: 1, updatedAt: 2 };
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
  const originalSubmit = client.submitPromptAsync.bind(client);
  client.submitPromptAsync = async (input) => {
    const response = await originalSubmit(input);
    return response.input ? response : acceptedInput(input.sessionId, input.text, false, input.submissionId);
  };
  client.inputQueue ??= async ({ sessionId }) => emptyInputQueue(sessionId);
  client.getInput ??= async () => undefined;
  client.cancelInputsFromSource ??= async ({ sessionId }) => emptyInputQueue(sessionId, true, 2);
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

test("failed durable revocation remains retryable and cannot admit more device work", async () => {
  let attempts = 0;
  const sources: string[] = [];
  const fixture = harness({
    cancelInputsFromSource: async (input) => {
      sources.push(input.source);
      if (++attempts === 1) throw new Error("Runtime unavailable");
      return emptyInputQueue(input.sessionId, true, 2);
    },
  });
  await invoke(fixture.adapter, { operation: "session.send", payload: { sessionId: "root", text: "pending", mode: "queue" } });
  await expect(fixture.adapter.revokeDevice("device-test")).rejects.toThrow("Runtime unavailable");
  await expect(invoke(fixture.adapter, { operation: "session.send", payload: { sessionId: "root", text: "later", mode: "queue" } })).rejects.toThrow("revoked");
  await fixture.adapter.revokeDevice("device-test");
  expect(sources).toHaveLength(2);
  expect(sources[0]).toBe(sources[1]);
  await fixture.adapter.invoke({ operation: "session.send", payload: { sessionId: "root", text: "other device", mode: "queue" } }, { ...context("session.send"), deviceId: "other" });
  await fixture.adapter.revoke();
});
