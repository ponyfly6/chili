import { expect, test } from "bun:test";
import type { AgentPath, ChiliEvent, SessionId, TimestampMs } from "@chili/protocol";
import type { AgentMailboxQuery, AgentMailboxRow, EventPublisher } from "@chili/store";
import {
  AgentMailboxDeliveryPump,
  type AgentMailboxDeliveryController,
} from "./agent-mailbox-delivery-pump.js";
import {
  AgentMailboxDelegationPausedError,
  AgentMailboxTurnRetryError,
  type ConsumeAgentMailboxInput,
} from "./agent-tree.js";

test("starts different mailbox recipients concurrently", async () => {
  const controller = new FakeMailboxDeliveryController([
    mailboxRow("message_alpha", "session_alpha"),
    mailboxRow("message_beta", "session_beta"),
  ]);
  controller.hold("message_alpha");
  controller.hold("message_beta");
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  try {
    await waitUntil(() => controller.activeCount === 2, "both recipients to start");
    expect(new Set(controller.activeIds)).toEqual(new Set(["message_alpha", "message_beta"]));

    controller.release("message_alpha");
    controller.release("message_beta");
    await pump.waitForIdle();

    expect(controller.rowsByStatus("consumed").map((row) => row.id).sort()).toEqual([
      "message_alpha",
      "message_beta",
    ]);
  } finally {
    controller.releaseAll();
    await pump.stop();
  }
});

test("keeps one session FIFO and single-flight", async () => {
  const controller = new FakeMailboxDeliveryController([
    mailboxRow("message_first", "session_shared", 1),
    mailboxRow("message_second", "session_shared", 2),
  ]);
  controller.hold("message_first");
  controller.hold("message_second");
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  try {
    await waitUntil(() => controller.startedIds.length === 1, "the first session turn to start");
    expect(controller.startedIds).toEqual(["message_first"]);
    expect(controller.maxObservedActive).toBe(1);

    controller.release("message_first");
    await waitUntil(() => controller.startedIds.length === 2, "the second session turn to start");
    expect(controller.startedIds).toEqual(["message_first", "message_second"]);
    expect(controller.maxObservedActive).toBe(1);

    controller.release("message_second");
    await pump.waitForIdle();
  } finally {
    controller.releaseAll();
    await pump.stop();
  }
});

test("composes recipient parallelism with a shared delivery cap", async () => {
  const controller = new FakeMailboxDeliveryController(
    [
      mailboxRow("message_one", "session_one", 1),
      mailboxRow("message_two", "session_two", 2),
      mailboxRow("message_three", "session_three", 3),
    ],
    2,
  );
  controller.hold("message_one");
  controller.hold("message_two");
  controller.hold("message_three");
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  try {
    await waitUntil(() => controller.consumeCalls.length === 3, "all delivery calls to enter the shared cap");
    await waitUntil(() => controller.activeCount === 2, "two delivery permits to be active");
    expect(controller.startedIds).toEqual(["message_one", "message_two"]);
    expect(controller.startedIds).not.toContain("message_three");
    expect(controller.maxObservedActive).toBe(2);

    controller.release("message_one");
    await waitUntil(() => controller.startedIds.includes("message_three"), "the third delivery to receive a permit");
    expect(controller.maxObservedActive).toBe(2);

    controller.release("message_two");
    controller.release("message_three");
    await pump.waitForIdle();
  } finally {
    controller.releaseAll();
    await pump.stop();
  }
});

test("stop aborts active and permit-waiting deliveries while leaving messages queued", async () => {
  const controller = new FakeMailboxDeliveryController(
    [
      mailboxRow("message_active", "session_active", 1),
      mailboxRow("message_waiting", "session_waiting", 2),
    ],
    1,
  );
  controller.hold("message_active");
  controller.hold("message_waiting");
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  await waitUntil(() => controller.consumeCalls.length === 2, "both deliveries to enter consumeMailbox");
  await waitUntil(() => controller.activeIds.includes("message_active"), "the first delivery to become active");
  expect(controller.startedIds).toEqual(["message_active"]);

  await within(pump.stop(), 1_000, "pump stop to abort every delivery");

  expect(new Set(controller.abortedIds)).toEqual(new Set(["message_active", "message_waiting"]));
  expect(controller.rowsByStatus("queued").map((row) => row.id).sort()).toEqual([
    "message_active",
    "message_waiting",
  ]);
  expect(controller.activeCount).toBe(0);
});

test("retries AgentMailboxTurnRetryError no earlier than retryAfter and then consumes", async () => {
  const retryAfterMs = 45;
  const providerError = Object.assign(new Error("provider asked the caller to wait"), {
    retryAfterMs,
  });
  const controller = new FakeMailboxDeliveryController([
    mailboxRow("message_retry", "session_retry"),
  ]);
  controller.failNext(
    "message_retry",
    new AgentMailboxTurnRetryError("message_retry", {
      status: "failed",
      turns: [],
      error: providerError,
    }),
  );
  const pump = new AgentMailboxDeliveryPump({
    agents: controller,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 5,
      maxDelayMs: 100,
      factor: 1,
    },
  });

  pump.start();
  try {
    await pump.waitForIdle();

    const starts = controller.startTimes.get("message_retry") ?? [];
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(retryAfterMs - 5);
    expect(controller.row("message_retry")?.status).toBe("consumed");
  } finally {
    await pump.stop();
  }
});

test("startup recovers an interrupted delivering row before consuming it", async () => {
  const controller = new FakeMailboxDeliveryController([
    mailboxRow("message_recovered", "session_recovered", 1, "delivering"),
  ]);
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  try {
    await pump.waitForIdle();

    expect(controller.recoveredIds).toEqual(["message_recovered"]);
    expect(controller.consumeCalls).toEqual(["message_recovered"]);
    expect(controller.row("message_recovered")?.status).toBe("consumed");
  } finally {
    await pump.stop();
  }
});

test("startup requeues an interrupted queue-only claim without auto-delivering it", async () => {
  const row = mailboxRow(
    "message_queue_only_recovered",
    "session_recovered",
    1,
    "delivering",
  );
  row.triggerTurn = false;
  const controller = new FakeMailboxDeliveryController([row]);
  const pump = new AgentMailboxDeliveryPump({ agents: controller });

  pump.start();
  try {
    await pump.waitForIdle();
    expect(controller.recoveredIds).toEqual([row.id]);
    expect(controller.consumeCalls).toEqual([]);
    expect(controller.row(row.id)?.status).toBe("queued");
  } finally {
    await pump.stop();
  }
});

test("re-enable during a claimed delegation pause rescans after the message is requeued", async () => {
  const events = new FakeEventPublisher();
  const controller = new DelegationRaceController(
    mailboxRow("message_policy_race", "session_policy"),
  );
  const pump = new AgentMailboxDeliveryPump({ agents: controller, events });

  pump.start();
  try {
    await controller.firstClaimed.promise;
    events.emit({
      id: "event_delegation_enabled",
      type: "session.delegation_changed",
      time: 2 as TimestampMs,
      sessionId: "session_policy" as SessionId,
      payload: { sessionId: "session_policy" as SessionId, policy: "proactive" },
    });
    controller.finishPausedAttempt.resolve();

    await pump.waitForIdle();
    expect(controller.consumeCalls).toBe(2);
    expect(controller.row.status).toBe("consumed");
  } finally {
    controller.finishPausedAttempt.resolve();
    await pump.stop();
  }
});

test("a process-local parked lane preserves FIFO until an explicit pump restart", async () => {
  const events = new FakeEventPublisher();
  const first = mailboxRow("message_parked", "session_shared", 1);
  const second = mailboxRow("message_after_parked", "session_shared", 2);
  const controller = new FakeMailboxDeliveryController([first, second]);
  controller.failNext(
    first.id,
    new AgentMailboxTurnRetryError(first.id, {
      status: "failed",
      turns: [],
      error: Object.assign(new Error("provider quota exhausted"), { retryable: false }),
    }),
  );
  const pump = new AgentMailboxDeliveryPump({ agents: controller, events });

  pump.start();
  await pump.waitForIdle();
  expect(controller.startedIds).toEqual([first.id]);

  events.emit({
    id: "event_shared_idle",
    type: "session.status_changed",
    time: 3 as TimestampMs,
    sessionId: "session_shared" as SessionId,
    payload: { sessionId: "session_shared" as SessionId, status: "idle" },
  });
  await pump.waitForIdle();
  expect(controller.startedIds).toEqual([first.id]);
  expect(controller.rowsByStatus("queued").map((row) => row.id)).toEqual([first.id, second.id]);

  await pump.stop();
  pump.start();
  try {
    await pump.waitForIdle();
    expect(controller.startedIds).toEqual([first.id, first.id, second.id]);
    expect(controller.rowsByStatus("consumed").map((row) => row.id)).toEqual([first.id, second.id]);
  } finally {
    await pump.stop();
  }
});

class FakeMailboxDeliveryController implements AgentMailboxDeliveryController {
  readonly consumeCalls: string[] = [];
  readonly startedIds: string[] = [];
  readonly abortedIds: string[] = [];
  readonly recoveredIds: string[] = [];
  readonly startTimes = new Map<string, number[]>();
  maxObservedActive = 0;

  private readonly rows = new Map<string, AgentMailboxRow>();
  private readonly gates = new Map<string, Deferred<void>>();
  private readonly failures = new Map<string, Error[]>();
  private readonly permitWaiters: PermitWaiter[] = [];
  private readonly active = new Set<string>();
  private permitsInUse = 0;

  constructor(rows: AgentMailboxRow[], private readonly maxActive = Number.POSITIVE_INFINITY) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get activeIds(): string[] {
    return [...this.active];
  }

  row(messageId: string): AgentMailboxRow | undefined {
    return this.rows.get(messageId);
  }

  rowsByStatus(status: AgentMailboxRow["status"]): AgentMailboxRow[] {
    return [...this.rows.values()].filter((row) => row.status === status);
  }

  hold(messageId: string): void {
    if (!this.gates.has(messageId)) this.gates.set(messageId, deferred<void>());
  }

  release(messageId: string): void {
    this.gates.get(messageId)?.resolve();
  }

  releaseAll(): void {
    for (const gate of this.gates.values()) gate.resolve();
  }

  failNext(messageId: string, error: Error): void {
    const failures = this.failures.get(messageId) ?? [];
    failures.push(error);
    this.failures.set(messageId, failures);
  }

  async mailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    let rows = [...this.rows.values()];
    if (query.messageId) rows = rows.filter((row) => row.id === query.messageId);
    if (query.taskId) rows = rows.filter((row) => row.taskId === query.taskId);
    if (query.path) rows = rows.filter((row) => row.path === query.path);
    if (query.recipientSessionId) {
      rows = rows.filter((row) => row.recipientSessionId === query.recipientSessionId);
    }
    if (query.triggerTurn !== undefined) {
      rows = rows.filter((row) => row.triggerTurn === query.triggerTurn);
    }
    if (query.status) rows = rows.filter((row) => row.status === query.status);
    rows.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    return rows.slice(0, query.limit ?? rows.length);
  }

  async recoverMailboxDelivery(input: { messageId: string; error?: string }): Promise<AgentMailboxRow> {
    const row = this.requireRow(input.messageId);
    this.recoveredIds.push(input.messageId);
    if (row.status === "delivering") row.status = "queued";
    return row;
  }

  async consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow> {
    const row = this.requireRow(input.messageId);
    this.consumeCalls.push(input.messageId);
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.acquirePermit(input.signal);
      throwIfAborted(input.signal);
      row.status = "delivering";
      this.active.add(input.messageId);
      this.startedIds.push(input.messageId);
      const starts = this.startTimes.get(input.messageId) ?? [];
      starts.push(Date.now());
      this.startTimes.set(input.messageId, starts);
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active.size);

      const failures = this.failures.get(input.messageId);
      const failure = failures?.shift();
      if (failure) throw failure;

      const gate = this.gates.get(input.messageId);
      if (gate) await abortable(gate.promise, input.signal);
      throwIfAborted(input.signal);
      row.status = "consumed";
      return row;
    } catch (error) {
      row.status = "queued";
      if (isAbortError(error)) this.abortedIds.push(input.messageId);
      throw error;
    } finally {
      this.active.delete(input.messageId);
      releasePermit?.();
    }
  }

  private requireRow(messageId: string): AgentMailboxRow {
    const row = this.rows.get(messageId);
    if (!row) throw new Error(`Unknown fake mailbox row: ${messageId}`);
    return row;
  }

  private acquirePermit(signal: AbortSignal | undefined): Promise<() => void> {
    throwIfAborted(signal);
    if (this.permitsInUse < this.maxActive) {
      this.permitsInUse += 1;
      return Promise.resolve(this.releasePermit());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject };
      if (signal) {
        const onAbort = () => {
          const index = this.permitWaiters.indexOf(waiter);
          if (index < 0) return;
          this.permitWaiters.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          reject(signalAbortError(signal));
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.permitWaiters.push(waiter);
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.permitsInUse = Math.max(0, this.permitsInUse - 1);
      this.drainPermitWaiters();
    };
  }

  private drainPermitWaiters(): void {
    while (this.permitsInUse < this.maxActive) {
      const waiter = this.permitWaiters.shift();
      if (!waiter) return;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(signalAbortError(waiter.signal));
        continue;
      }
      this.permitsInUse += 1;
      waiter.resolve(this.releasePermit());
    }
  }
}

class DelegationRaceController implements AgentMailboxDeliveryController {
  readonly firstClaimed = deferred<void>();
  readonly finishPausedAttempt = deferred<void>();
  consumeCalls = 0;

  constructor(readonly row: AgentMailboxRow) {}

  async mailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    if (query.messageId && query.messageId !== this.row.id) return [];
    if (query.recipientSessionId && query.recipientSessionId !== this.row.recipientSessionId) return [];
    if (query.triggerTurn !== undefined && query.triggerTurn !== this.row.triggerTurn) return [];
    if (query.status && query.status !== this.row.status) return [];
    return [this.row];
  }

  async consumeMailbox(): Promise<AgentMailboxRow> {
    this.consumeCalls += 1;
    if (this.consumeCalls === 1) {
      this.row.status = "delivering";
      this.firstClaimed.resolve();
      await this.finishPausedAttempt.promise;
      this.row.status = "queued";
      throw new AgentMailboxDelegationPausedError(
        this.row.id,
        "session_policy" as SessionId,
      );
    }
    this.row.status = "consumed";
    return this.row;
  }
}

class FakeEventPublisher implements EventPublisher {
  private readonly listeners = new Set<(event: ChiliEvent) => void>();

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ChiliEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface PermitWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function mailboxRow(
  id: string,
  sessionId: string,
  createdAt = 1,
  status: AgentMailboxRow["status"] = "queued",
): AgentMailboxRow {
  return {
    id,
    path: `/root/${id}` as AgentPath,
    fromPath: "/root" as AgentPath,
    triggerTurn: true,
    status,
    recipientSessionId: sessionId as SessionId,
    message: { role: "user", content: `deliver ${id}` },
    createdAt,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signalAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signalAbortError(signal);
}

function signalAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Fake mailbox delivery aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
