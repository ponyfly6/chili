import type { ChiliEvent, EventEnvelope, SessionId, SnapshotId, TimestampMs } from "@chili/protocol";
import { boundPersistedJsonValue, normalizePersistedError, timestampNow } from "@chili/protocol";
import type { EventStore, SessionRow } from "@chili/store";
import type { SnapshotProvider, SnapshotRevertResult } from "@chili/tools";

export interface SnapshotRecoveryServiceOptions {
  store: EventStore;
  snapshotProvider: SnapshotProvider;
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
  constructor(private readonly options: SnapshotRecoveryServiceOptions) {}

  async revert(input: RevertSnapshotInput): Promise<SnapshotRevertResult> {
    await this.requireRecoverableSession(input.sessionId);
    if (!(await this.snapshotBelongsToSession(input))) {
      throw new Error(`Snapshot not found for session ${input.sessionId}: ${input.snapshotId}`);
    }
    // Snapshot lookup may page through a long event history. Re-read the
    // authoritative session immediately before the filesystem mutation so an
    // archive or ownership change during that lookup fails closed.
    const session = await this.requireRecoverableSession(input.sessionId);

    try {
      const result = await this.options.snapshotProvider.revert(input.snapshotId, { cwd: session.cwd });
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "completed",
        paths: boundedSnapshotPaths(result.paths),
      });
      return result;
    } catch (error) {
      const err = normalizePersistedError(error);
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "failed",
        paths: [],
        error: err.message,
      });
      throw err;
    }
  }

  private async requireRecoverableSession(sessionId: SessionId): Promise<SessionRow> {
    const session = (await this.options.store.sessions()).find((item) => item.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") {
      throw new Error(`Session is not active: ${sessionId} (${session.status})`);
    }
    if (session.source === "subagent") {
      throw new Error(`Snapshot recovery is not allowed for subagent session: ${sessionId}`);
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

  private async append<TType extends ChiliEvent["type"], TPayload>(
    input: RevertSnapshotInput,
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    await this.options.store.append(event as ChiliEvent);
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
