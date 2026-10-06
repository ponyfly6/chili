import { expect, test } from "bun:test";
import {
  canEditComposer,
  canOpenSession,
  canSwitchWorkspace,
  draftScopeChanged,
  nextBoundedRetryAttempt,
  preferredSessionAfterRecovery,
  RENDERER_CREDENTIAL_BOUNDARY_COPY,
  selectWorkspaceEscapingPausedResync,
  sidecarRecoveryGuidance,
  shouldFollowTimeline,
  workspaceSelectionChangesScope,
} from "./interaction-model.js";

test("outage suppresses session opens and recovery prefers reopening the current selection", () => {
  expect(canOpenSession({ healthy: false, resyncing: false })).toBe(false);
  expect(canOpenSession({ healthy: true, resyncing: true })).toBe(false);
  expect(preferredSessionAfterRecovery(false, true, "session_1")).toBe("session_1");
  expect(canOpenSession({ healthy: true, resyncing: false })).toBe(true);
});

test("composer is immutable while a request, resync, load, or outage is active", () => {
  const ready = {
    selectedId: "session_1",
    healthy: true,
    resyncing: false,
    loadingSession: false,
    working: false,
  };
  expect(canEditComposer(ready)).toBe(true);
  for (const blocked of [
    { ...ready, working: true },
    { ...ready, resyncing: true },
    { ...ready, loadingSession: true },
    { ...ready, healthy: false },
    { ...ready, selectedId: undefined },
  ]) expect(canEditComposer(blocked)).toBe(false);
});

test("read-only history can be opened while its composer remains immutable", () => {
  const ready = {
    selectedId: "session_history",
    healthy: true,
    resyncing: false,
    loadingSession: false,
    working: false,
    readOnly: true,
  };
  expect(canOpenSession(ready)).toBe(true);
  expect(canEditComposer(ready)).toBe(false);
  expect(canEditComposer({ ...ready, readOnly: false })).toBe(true);
});

test("draft scope changes on either workspace or session identity", () => {
  const current = { workspace: "/repo-a", sessionId: "session-a" };
  expect(draftScopeChanged(current, { ...current })).toBe(false);
  expect(draftScopeChanged(current, { ...current, sessionId: "session-b" })).toBe(true);
  expect(draftScopeChanged(current, { ...current, workspace: "/repo-b" })).toBe(true);
  expect(draftScopeChanged(current, { workspace: undefined, sessionId: undefined })).toBe(true);
});

test("outer retry attempts stop at a deterministic bound", () => {
  expect(nextBoundedRetryAttempt(0, 3)).toBe(1);
  expect(nextBoundedRetryAttempt(2, 3)).toBe(3);
  expect(nextBoundedRetryAttempt(3, 3)).toBeUndefined();
});

test("workspace switching is enabled as an escape only after resync retries pause", () => {
  const ready = {
    working: false,
    loadingSession: false,
    resyncing: false,
    resyncRetryAvailable: false,
  };
  expect(canSwitchWorkspace(ready)).toBe(true);
  expect(canSwitchWorkspace({ ...ready, resyncing: true })).toBe(false);
  expect(canSwitchWorkspace({ ...ready, resyncing: true, resyncRetryAvailable: true })).toBe(true);
  expect(canSwitchWorkspace({
    ...ready,
    resyncing: true,
    resyncRetryAvailable: true,
    loadingSession: true,
  })).toBe(true);
  expect(canSwitchWorkspace({ ...ready, resyncing: true, resyncRetryAvailable: true, working: true })).toBe(false);
  expect(canSwitchWorkspace({ ...ready, loadingSession: true })).toBe(false);
});

test("cancelled and same-workspace picker results preserve the draft scope", () => {
  const draft = "unsent investigation notes";
  const clearDraft = (nextWorkspace: string | undefined): string => (
    workspaceSelectionChangesScope("/repo-a", nextWorkspace) ? "" : draft
  );
  const cancelledPickerWorkspace = "/repo-a";
  const explicitlyReselectedWorkspace = "/repo-a";
  expect(clearDraft(cancelledPickerWorkspace)).toBe(draft);
  expect(clearDraft(explicitlyReselectedWorkspace)).toBe(draft);
  expect(clearDraft("/repo-b")).toBe("");
  expect(workspaceSelectionChangesScope(undefined, undefined)).toBe(false);
});

test("paused resync cancels its timer and barrier before workspace selection, then resumes its barrier", async () => {
  const order: string[] = [];
  const barrier = { sequence: 7, barrierId: "barrier_7" };
  const result = await selectWorkspaceEscapingPausedResync({
    syncing: true,
    retryPaused: true,
    barrier,
    cancelRetryTimer: () => order.push("cancel timer"),
    cancelBarrier: () => order.push("cancel barrier and request epoch"),
    selectWorkspace: async () => {
      order.push("select workspace");
      return "/repo-b";
    },
    resumeBarrier: (resumed) => order.push(`resume ${resumed.barrierId}`),
  });

  expect(result).toBe("/repo-b");
  expect(order).toEqual([
    "cancel timer",
    "cancel barrier and request epoch",
    "select workspace",
    "resume barrier_7",
  ]);
});

test("a failed or cancelled workspace selection still resumes the escaped resync barrier", async () => {
  const order: string[] = [];
  const selecting = selectWorkspaceEscapingPausedResync({
    syncing: true,
    retryPaused: true,
    barrier: "barrier_cancelled",
    cancelRetryTimer: () => order.push("cancel timer"),
    cancelBarrier: () => order.push("cancel barrier"),
    selectWorkspace: async () => {
      order.push("select workspace");
      throw new Error("dialog failed");
    },
    resumeBarrier: (barrier) => order.push(`resume ${barrier}`),
  });

  expect(selecting).rejects.toThrow("dialog failed");
  await selecting.catch(() => undefined);
  expect(order).toEqual(["cancel timer", "cancel barrier", "select workspace", "resume barrier_cancelled"]);
});

test("timeline follows only while the viewport remains near its bottom", () => {
  expect(shouldFollowTimeline({ scrollTop: 928, scrollHeight: 2_000, clientHeight: 1_000 })).toBe(true);
  expect(shouldFollowTimeline({ scrollTop: 700, scrollHeight: 2_000, clientHeight: 1_000 })).toBe(false);
  expect(shouldFollowTimeline({ scrollTop: 0, scrollHeight: 500, clientHeight: 800 })).toBe(true);
});

test("sidecar guidance distinguishes active recovery from the terminal fourth failure", () => {
  const recovering = sidecarRecoveryGuidance({
    phase: "recovering",
    attempt: 2,
    error: ` failed ${"x".repeat(100)}`,
  }, 20);
  expect(recovering?.message).toContain("Runtime issue: failed");
  expect(recovering?.message).toContain("retrying automatically (attempt 2)");
  expect(recovering?.message).not.toContain("stopped");
  expect(recovering?.actionLabel).toBe("Switch workspace…");

  const terminal = sidecarRecoveryGuidance({
    phase: "error",
    attempt: 3,
    error: "Sidecar stopped after 3 restart attempts",
  });
  expect(terminal?.message).toContain("Automatic retries stopped");
  expect(terminal?.message).toContain("Choose this or another workspace");
  expect(terminal?.message).not.toContain("retrying automatically");
  expect(terminal?.actionLabel).toBe("Choose workspace…");
  expect(sidecarRecoveryGuidance({ phase: "healthy", attempt: 0 })).toBeUndefined();
});

test("welcome security copy describes the actual renderer credential boundary", () => {
  expect(RENDERER_CREDENTIAL_BOUNDARY_COPY).toContain("never enter the renderer");
  expect(RENDERER_CREDENTIAL_BOUNDARY_COPY).not.toContain("main process");
});
