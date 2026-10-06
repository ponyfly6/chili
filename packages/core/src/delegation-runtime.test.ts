import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { DelegationPolicyGate } from "./delegation.js";
import type { AgentRunner } from "./runner.js";
import { RuntimeService } from "./runtime-service.js";

test("delegation policy reads the durable latest value across runtime instances and event pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-delegation-runtime-"));
  const path = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(path);
  const secondStore = new SqliteEventStore(path);
  const sessionId = "session_shared_delegation" as SessionId;
  const first = runtimeService(firstStore);
  const second = runtimeService(secondStore);

  try {
    await firstStore.append(sessionCreatedEvent("event_shared_delegation_session", sessionId));
    expect((await first.getDelegationConfig(sessionId)).policy).toBe("proactive");

    await second.setDelegationPolicy({ sessionId, policy: "off" });
    expect(await first.getDelegationConfig(sessionId)).toMatchObject({
      sessionId,
      policy: "off",
      source: "session",
    });

    const laterEvents = Array.from({ length: 501 }, (_, index): ChiliEvent => ({
      id: `event_delegation_page_${index}`,
      type: "session.delegation_changed",
      time: (index + 10) as TimestampMs,
      sessionId,
      payload: {
        sessionId,
        policy: index === 500 ? "proactive" : index % 2 === 0 ? "explicit" : "off",
      },
    }));
    await secondStore.appendMany(laterEvents);

    expect(await first.getDelegationConfig(sessionId)).toMatchObject({
      sessionId,
      policy: "proactive",
      source: "session",
    });
  } finally {
    firstStore.close();
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function runtimeService(store: SqliteEventStore): RuntimeService {
  return new RuntimeService({
    runtime: {} as AgentRunner,
    store,
    cwd: "/repo",
  });
}

function sessionCreatedEvent(id: string, sessionId: SessionId): Extract<ChiliEvent, { type: "session.created" }> {
  return {
    id,
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delegation race checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
