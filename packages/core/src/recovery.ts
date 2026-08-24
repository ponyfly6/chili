import type { ChiliEvent, EventEnvelope, SessionId, SnapshotId, TimestampMs } from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { EventStore } from "@chili/store";
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

export class SnapshotRecoveryService {
  constructor(private readonly options: SnapshotRecoveryServiceOptions) {}

  async revert(input: RevertSnapshotInput): Promise<SnapshotRevertResult> {
    const session = (await this.options.store.sessions()).find((item) => item.id === input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    if (!(await this.snapshotBelongsToSession(input))) {
      throw new Error(`Snapshot not found for session ${input.sessionId}: ${input.snapshotId}`);
    }

    try {
      const result = await this.options.snapshotProvider.revert(input.snapshotId, { cwd: session.cwd });
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "completed",
        paths: result.paths,
      });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.append(input, "snapshot.reverted", {
        snapshotId: input.snapshotId,
        status: "failed",
        paths: [],
        error: err.message,
      });
      throw err;
    }
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
