import type { RuntimeEvent, EventEnvelope, SessionId, SnapshotId, TimestampMs } from "@chili/protocol";
import { boundPersistedJsonValue, normalizePersistedError, timestampNow } from "@chili/protocol";
import type { EventAppendOptions, EventStore, SessionRow } from "@chili/store";
import type { SnapshotProvider, SnapshotRevertResult } from "@chili/tools";
import { RuntimeService, type SessionOperationCoordinator, type RuntimeSessionOperation } from "./runtime-service.js";

export interface SnapshotRecoveryServiceOptions {
  store: EventStore;
  snapshotProvider: SnapshotProvider;
  sessionOperations?: SessionOperationCoordinator;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface RevertSnapshotInput {
  sessionId: SessionId;
  snapshotId: SnapshotId;
}

export const SNAPSHOT_REVERT_EVENT_LIMITS = {
  paths: 128,
  pathJsonBytes: 16 * 1024,
  pathsJsonBytes: 128 * 1024,
} as const;

export class SnapshotRecoveryService {
  private readonly sessionOperations: SessionOperationCoordinator;

  constructor(private readonly options: SnapshotRecoveryServiceOptions) {
    // Standalone callers retain the same durable run claim as normal prompts.
    // Host injects its service so cancellation and shutdown share local ownership.
    this.sessionOperations = options.sessionOperations ?? new RuntimeService({
      store: options.store,
      cwd: ".",
      runtime: {
        async createSession() { throw new Error("Recovery cannot create sessions"); },
        async appendUserMessage() { throw new Error("Recovery cannot append messages"); },
        async runTurn() { throw new Error("Recovery cannot run model turns"); },
      },
    });
  }

  async revert(input: RevertSnapshotInput): Promise<SnapshotRevertResult> {
    return this.sessionOperations.withSessionOperation(input.sessionId, (operation) => this.revertOwned(input, operation));
  }

  private async revertOwned(input: RevertSnapshotInput, operation: RuntimeSessionOperation): Promise<SnapshotRevertResult> {
    await this.requireRecoverableSession(input.sessionId);
    if (!(await this.snapshotBelongsToSession(input))) {
      throw new Error(`Snapshot not found for session ${input.sessionId}: ${input.snapshotId}`);
    }
    // Snapshot lookup may page through a long event history. Re-read the
    // authoritative session immediately before the filesystem mutation so an
    // archive or ownership change during that lookup fails closed.
    const session = await this.requireRecoverableSession(input.sessionId);

    const appendOptions: EventAppendOptions | undefined = operation.runClaim ? { runClaim: operation.runClaim } : undefined;
    try {
      operation.assertCurrent();
      if (operation.signal.aborted) throw operation.signal.reason ?? new Error("Snapshot recovery cancelled");
      const result = await this.options.snapshotProvider.revert(input.snapshotId, { cwd: session.cwd, signal: operation.signal });
      operation.assertCurrent();
      if (operation.signal.aborted) throw operation.signal.reason ?? new Error("Snapshot recovery cancelled");
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "completed",
        paths: boundedSnapshotPaths(result.paths),
      }, appendOptions);
      return result;
    } catch (error) {
      operation.assertCurrent();
      const err = normalizePersistedError(error);
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "failed",
        paths: [],
        error: err.message,
      }, appendOptions);
      throw err;
    }
  }

  private async requireRecoverableSession(sessionId: SessionId): Promise<SessionRow> {
    const session = (await this.options.store.sessions()).find((item) => item.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") {
      throw new Error(`Session is not active: ${sessionId} (${session.status})`);
    }
    if (session.readOnly || session.agent) {
      throw new Error(`Snapshot recovery requires a writable root Session: ${sessionId}`);
    }
    return session;
  }

  private async snapshotBelongsToSession(input: RevertSnapshotInput): Promise<boolean> {
    const limit = 500;
    let afterEventId: string | undefined;

    while (true) {
      const events = await this.options.store.events({
        sessionId: input.sessionId,
        type: "snapshot.created",
        limit,
        ...(afterEventId ? { afterEventId } : {}),
      });
      if (events.some((event) => (
        event.sessionId === input.sessionId
        && event.type === "snapshot.created"
        && isSnapshotCreatedPayload(event.payload)
        && event.payload.snapshotId === input.snapshotId
      ))) return true;
      if (events.length < limit) return false;
      afterEventId = events.at(-1)?.id;
      if (!afterEventId) return false;
    }
  }

  private async append<TType extends RuntimeEvent["type"], TPayload>(
    input: RevertSnapshotInput,
    type: TType,
    payload: TPayload,
    options?: EventAppendOptions,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    await this.options.store.append(event as RuntimeEvent, options);
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function isSnapshotCreatedPayload(payload: unknown): payload is { snapshotId: SnapshotId } {
  return typeof payload === "object"
    && payload !== null
    && "snapshotId" in payload
    && typeof payload.snapshotId === "string";
}

function boundedSnapshotPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const candidates: string[] = [];
  let rawLength: unknown;
  try {
    rawLength = Reflect.get(value, "length");
  } catch {
    return [];
  }
  const length = typeof rawLength === "number"
    && Number.isSafeInteger(rawLength)
    && rawLength >= 0
    ? rawLength
    : 0;
  for (let index = 0; index < Math.min(length, SNAPSHOT_REVERT_EVENT_LIMITS.paths); index += 1) {
    let path: unknown;
    try {
      path = Reflect.get(value, String(index));
    } catch {
      continue;
    }
    if (typeof path === "string") candidates.push(path);
  }
  const bounded = boundPersistedJsonValue(candidates, {
    maxBytes: SNAPSHOT_REVERT_EVENT_LIMITS.pathsJsonBytes,
    maxStringBytes: SNAPSHOT_REVERT_EVENT_LIMITS.pathJsonBytes - 2,
    maxItems: SNAPSHOT_REVERT_EVENT_LIMITS.paths,
    maxDepth: 2,
    maxNodes: SNAPSHOT_REVERT_EVENT_LIMITS.paths + 1,
    label: "snapshot paths",
  });
  if (!Array.isArray(bounded)) return [];
  return bounded
    .filter((path): path is string => typeof path === "string")
    .slice(0, SNAPSHOT_REVERT_EVENT_LIMITS.paths)
    .map((path) => path.replace(/[\u0000-\u001f\u007f]/gu, "\ufffd"));
}
