import { expect, test } from "bun:test";
import type { SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunOutcome } from "./agent-lifecycle.js";
import { RuntimeService } from "./runtime-service.js";

test.each([false, true])("failed resource cleanup settles the durable input before Agent end (shutdown: %s)", async (shutdownDuringCleanup) => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "agent_cleanup_failure" as SessionId;
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId,
    time: Date.now() as TimestampMs, payload: { sessionId, cwd: "/repo" } });
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const ended: AgentRunOutcome[] = [];
  const snapshots: Array<{ state?: string; outcome?: string; hasLease: boolean; running: boolean }> = [];
  const service = new RuntimeService({
    store,
    cwd: "/repo",
    runtime: {
      createSession: async () => sessionId,
      appendUserMessage: async () => { throw new Error("Durable promotion should be atomic"); },
      runTurn: async (input) => {
        entered();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "cancelled", turnId: input.turnId ?? crypto.randomUUID() as TurnId, error: new Error("stopped") };
      },
    },
    stopSessionResources: async () => { throw new Error("resource cleanup failed"); },
    agentLifecycle: { ended(outcome) {
      ended.push(outcome);
      const input = outcome.inputId ? store.sessionInputById(sessionId, outcome.inputId) : undefined;
      snapshots.push({ ...(input ? { state: input.state } : {}), ...(input?.outcome ? { outcome: input.outcome } : {}),
        hasLease: store.sessionRunClaim(sessionId) !== undefined, running: service.isRunning(sessionId) });
    } },
  });
  try {
    const prompt = service.submitPrompt({ sessionId, text: "wait", signal: controller.signal }).then(
      (result) => ({ status: "fulfilled" as const, result }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await started;
    controller.abort();
    const shutdown = shutdownDuringCleanup ? service.shutdown() : undefined;
    expect(await prompt).toMatchObject({ status: "rejected", reason: { message: "resource cleanup failed" } });
    await shutdown;
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ status: "failed", error: "resource cleanup failed", turnCount: 1 });
    expect(snapshots).toEqual([{ state: "settled", outcome: shutdownDuringCleanup ? "interrupted" : "failed", hasLease: false, running: false }]);
  } finally {
    await service.shutdown();
    await store.flushInputMirrors();
    store.close();
  }
});
