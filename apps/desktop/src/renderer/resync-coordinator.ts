import { serializedJsonUtf8Bytes } from "./json-bytes.js";

export type ProjectionRequestKind = "state" | "sessions" | "snapshot" | "diff";

export interface SequencedProjectionFrame<Frame> {
  sequence: number;
  frame: Frame;
}

export interface ProjectionRequestToken {
  epoch: number;
  kind: ProjectionRequestKind;
  version: number;
}

export interface ResyncStatus {
  epoch: number;
  syncing: boolean;
  actionsDisabled: boolean;
  diffRevision: number;
}

export interface ResyncJournalDiagnostics {
  bufferedFrames: number;
  bufferedBytes: number;
  droppedThroughSequence: number;
  outOfOrderInsertions: number;
  storageCompactions: number;
}

export interface CoordinatedProjection<State, Session, Snapshot> {
  epoch: number;
  diffRevision: number;
  state: State;
  sessions: Session[];
  selectedId?: string;
  snapshot?: Snapshot;
}

export interface ResyncBarrier {
  sequence: number;
  barrierId?: string;
  preferredSessionId?: string;
}

export interface ResyncRetryOptions {
  resetCompletionBudget?: boolean;
}

export type ResyncOutcome = "completed" | "superseded";

export interface ResyncComplete<State, Session, Snapshot> {
  barrierId?: string;
  projection: CoordinatedProjection<State, Session, Snapshot>;
  framesThroughSequence: number;
}

export type ResyncCompletion = "completed" | "retry" | { status: "completed" | "retry" } | void;

export interface ResyncCoordinatorOptions<State, Session, Snapshot, Frame> {
  loadState(): Promise<State>;
  listSessions(state: State): Promise<Session[]>;
  loadSnapshot(sessionId: string, state?: State): Promise<Snapshot>;
  preferredSessionId?(state: State): string | undefined;
  canListSessions?(state: State): boolean;
  authorityKey(state: State): string | number | undefined;
  sessionId(session: Session): string;
  isSessionActive(session: Session): boolean;
  snapshotSessionId(snapshot: Snapshot): string;
  snapshotEventIds(snapshot: Snapshot): Iterable<string>;
  frameEventId(frame: Frame): string | undefined;
  frameRequiresRehydrate?(frame: Frame): boolean;
  frameRelatedToSnapshot(frame: Frame, snapshot: Snapshot, sessionId: string): boolean;
  applyFrameToSnapshot(snapshot: Snapshot, frame: Frame): Snapshot;
  applyFrames(
    projection: CoordinatedProjection<State, Session, Snapshot>,
    frames: readonly SequencedProjectionFrame<Frame>[],
  ): CoordinatedProjection<State, Session, Snapshot>;
  publish(projection: CoordinatedProjection<State, Session, Snapshot>): void;
  complete?(result: ResyncComplete<State, Session, Snapshot>): ResyncCompletion | Promise<ResyncCompletion>;
  statusChanged?(status: ResyncStatus): void;
  maxBufferedFrames?: number;
  maxBufferedBytes?: number;
  retryDelayMs?: number;
  maxCompleteRetries?: number;
}

interface BarrierIntent {
  epoch: number;
  sequence: number;
  barrierId?: string;
  preferredSessionId?: string;
  releaseCompleted?: boolean;
  completeRetries?: number;
}

export class SupersededProjectionRequestError extends Error {
  override readonly name = "SupersededProjectionRequestError";
}

export class SnapshotIdentityMismatchError extends Error {
  override readonly name = "SnapshotIdentityMismatchError";
}

export class RecoveryInProgressError extends Error {
  override readonly name = "RecoveryInProgressError";
}

export class RecoveryInvalidatedError extends Error {
  override readonly name = "RecoveryInvalidatedError";
}

export class ProjectionReplayWindowError extends Error {
  override readonly name = "ProjectionReplayWindowError";
}

export class ResyncRetryLimitError extends Error {
  override readonly name = "ResyncRetryLimitError";
}

export class ResyncCoordinatorDisposedError extends Error {
  override readonly name = "ResyncCoordinatorDisposedError";
}

/**
 * Coordinates renderer hydration around an ordered event-stream resync barrier.
 * It intentionally knows nothing about React, Electron, or the desktop IPC
 * contract; callers provide the projection and frame reducers.
 */
export class ResyncCoordinator<State, Session, Snapshot, Frame> {
  private readonly maxBufferedFrames: number;
  private readonly maxBufferedBytes: number;
  private readonly retryDelayMs: number;
  private readonly maxCompleteRetries: number;
  private readonly requestVersions: Record<ProjectionRequestKind, number> = {
    state: 0,
    sessions: 0,
    snapshot: 0,
    diff: 0,
  };
  private frames: Array<(SequencedProjectionFrame<Frame> & { order: number; bytes: number }) | undefined> = [];
  private frameHead = 0;
  private bufferedBytes = 0;
  private droppedThroughSequence = -1;
  private nextFrameOrder = 0;
  private outOfOrderInsertions = 0;
  private storageCompactions = 0;
  private latestSequence = -1;
  private epoch = 0;
  private diffRevision = 0;
  private syncing = false;
  private currentBarrier: BarrierIntent | undefined;
  private actor: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveRetryDelay: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: ResyncCoordinatorOptions<State, Session, Snapshot, Frame>) {
    this.maxBufferedFrames = options.maxBufferedFrames ?? 20_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 12_000_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxCompleteRetries = options.maxCompleteRetries ?? 4;
    if (!Number.isSafeInteger(this.maxBufferedFrames) || this.maxBufferedFrames < 1) {
      throw new RangeError("maxBufferedFrames must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) {
      throw new RangeError("maxBufferedBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.maxCompleteRetries) || this.maxCompleteRetries < 0) {
      throw new RangeError("maxCompleteRetries must be a non-negative safe integer");
    }
  }

  status(): ResyncStatus {
    return {
      epoch: this.epoch,
      syncing: this.syncing,
      actionsDisabled: this.syncing,
      diffRevision: this.diffRevision,
    };
  }

  journalDiagnostics(): ResyncJournalDiagnostics {
    return {
      bufferedFrames: this.frames.length - this.frameHead,
      bufferedBytes: this.bufferedBytes,
      droppedThroughSequence: this.droppedThroughSequence,
      outOfOrderInsertions: this.outOfOrderInsertions,
      storageCompactions: this.storageCompactions,
    };
  }

  recordFrame(input: SequencedProjectionFrame<Frame>): void {
    if (this.disposed) return;
    requireSequence(input.sequence, "frame sequence");
    this.latestSequence = Math.max(this.latestSequence, input.sequence);
    const bytes = serializedJsonUtf8Bytes(input);
    const frame = { ...input, order: this.nextFrameOrder++, bytes };
    const last = this.frames.at(-1);
    if (!last || compareFrames(last, frame) <= 0) {
      this.frames.push(frame);
    } else {
      let low = this.frameHead;
      let high = this.frames.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = this.frames[middle];
        if (candidate && compareFrames(candidate, frame) <= 0) low = middle + 1;
        else high = middle;
      }
      this.frames.splice(low, 0, frame);
      this.outOfOrderInsertions += 1;
    }
    this.bufferedBytes += bytes;
    while (this.frames.length - this.frameHead > this.maxBufferedFrames || this.bufferedBytes > this.maxBufferedBytes) {
      const dropped = this.frames[this.frameHead];
      this.frames[this.frameHead] = undefined;
      this.frameHead += 1;
      if (!dropped) continue;
      this.bufferedBytes -= dropped.bytes;
      this.droppedThroughSequence = Math.max(this.droppedThroughSequence, dropped.sequence);
    }
    const compactThreshold = Math.max(1, Math.min(1_024, this.maxBufferedFrames));
    if (this.frameHead >= compactThreshold && this.frameHead * 2 >= this.frames.length) {
      this.frames = this.frames.slice(this.frameHead);
      this.frameHead = 0;
      this.storageCompactions += 1;
    }
  }

  beginRequest(kind: ProjectionRequestKind): ProjectionRequestToken {
    this.requireActive();
    if (this.syncing) throw new RecoveryInProgressError(`${kind} request is suppressed while resync is in progress`);
    this.requestVersions[kind] += 1;
    return { epoch: this.epoch, kind, version: this.requestVersions[kind] };
  }

  isRequestCurrent(token: ProjectionRequestToken): boolean {
    return !this.syncing
      && token.epoch === this.epoch
      && token.version === this.requestVersions[token.kind];
  }

  acceptResponse(token: ProjectionRequestToken): void {
    if (!this.isRequestCurrent(token)) {
      throw new SupersededProjectionRequestError(`${token.kind} response belongs to an obsolete projection epoch`);
    }
  }

  invalidateRequests(...kinds: ProjectionRequestKind[]): void {
    const selected = kinds.length > 0 ? kinds : (Object.keys(this.requestVersions) as ProjectionRequestKind[]);
    for (const kind of selected) this.requestVersions[kind] += 1;
  }

  barrier(input: ResyncBarrier): Promise<ResyncOutcome> {
    this.requireActive();
    requireSequence(input.sequence, "barrier sequence");
    this.latestSequence = Math.max(this.latestSequence, input.sequence);
    const intent: BarrierIntent = {
      epoch: ++this.epoch,
      sequence: input.sequence,
      ...(input.barrierId ? { barrierId: input.barrierId } : {}),
      ...(input.preferredSessionId ? { preferredSessionId: input.preferredSessionId } : {}),
    };
    this.currentBarrier = intent;
    this.syncing = true;
    this.invalidateRequests();
    this.notifyStatus();
    return this.enqueue(() => this.recover(intent));
  }

  retry(options: ResyncRetryOptions = {}): Promise<ResyncOutcome> {
    this.requireActive();
    const intent = this.currentBarrier;
    if (!intent || !this.syncing) throw new RecoveryInProgressError("There is no incomplete resync barrier to retry");
    if (options.resetCompletionBudget) intent.completeRetries = 0;
    if ((intent.completeRetries ?? 0) > this.maxCompleteRetries) {
      return Promise.reject(new ResyncRetryLimitError("Resync completion exceeded its bounded retry budget"));
    }
    return this.enqueue(() => this.recover(intent));
  }

  cancel(): void {
    this.cancelRetryDelay();
    this.epoch += 1;
    this.syncing = false;
    this.currentBarrier = undefined;
    this.invalidateRequests();
    this.frames = [];
    this.frameHead = 0;
    this.bufferedBytes = 0;
    this.droppedThroughSequence = -1;
    this.latestSequence = -1;
    this.nextFrameOrder = 0;
    this.outOfOrderInsertions = 0;
    this.storageCompactions = 0;
    this.actor = Promise.resolve();
    this.notifyStatus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  async refreshSessionSnapshot(
    sessionId: string,
    load: (sessionId: string) => Promise<Snapshot> = this.options.loadSnapshot,
  ): Promise<Snapshot> {
    this.requireActive();
    if (this.syncing) throw new RecoveryInProgressError("Session refresh is suppressed while resync is in progress");
    const token = this.beginRequest("snapshot");
    const startSequence = this.latestSequence;
    const snapshot = await load(sessionId);
    this.acceptResponse(token);
    this.assertSnapshotIdentity(snapshot, sessionId);
    return this.replaySnapshot(snapshot, sessionId, this.framesAfter(startSequence));
  }

  private enqueue(operation: () => Promise<ResyncOutcome>): Promise<ResyncOutcome> {
    const run = this.actor.then(operation, operation);
    this.actor = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async recover(intent: BarrierIntent): Promise<ResyncOutcome> {
    try {
      while (this.isIntentCurrent(intent)) {
        const hydrated = await this.hydrate(intent);
        if (!hydrated) return "superseded";
        const { projection, framesThroughSequence, rehydrateRequired } = hydrated;

        if (intent.releaseCompleted && rehydrateRequired) continue;

        this.diffRevision += 1;
        const published = { ...projection, diffRevision: this.diffRevision };
        this.options.publish(published);
        if (!intent.releaseCompleted) {
          const completion = await this.options.complete?.({
            ...(intent.barrierId ? { barrierId: intent.barrierId } : {}),
            projection: published,
            framesThroughSequence,
          });
          if (!this.isIntentCurrent(intent)) return "superseded";
          if (completionStatus(completion) === "retry") {
            intent.completeRetries = (intent.completeRetries ?? 0) + 1;
            if (intent.completeRetries > this.maxCompleteRetries) {
              throw new ResyncRetryLimitError("Resync completion exceeded its bounded retry budget");
            }
            await this.waitBeforeRetry();
            continue;
          }
          intent.releaseCompleted = true;
          // Main may synchronously release held envelopes before the complete
          // IPC promise resolves. Rehydrate once more while mutations remain
          // suppressed so queried agent/input state includes those envelopes.
          if (this.framesAfter(framesThroughSequence).length > 0) continue;
        }
        this.syncing = false;
        this.currentBarrier = undefined;
        this.notifyStatus();
        return "completed";
      }
      return "superseded";
    } catch (error) {
      if (!this.isIntentCurrent(intent)) return "superseded";
      throw error;
    }
  }

  private async hydrate(intent: BarrierIntent): Promise<{
    projection: CoordinatedProjection<State, Session, Snapshot>;
    framesThroughSequence: number;
    rehydrateRequired: boolean;
  } | undefined> {
    if (!this.isIntentCurrent(intent)) return undefined;
    const hydrationStartSequence = this.latestSequence;

    const state = await this.options.loadState();
    if (!this.isIntentCurrent(intent)) return undefined;
    const authority = this.options.authorityKey(state);

    const listedSessions = this.options.canListSessions?.(state) === false
      ? []
      : await this.options.listSessions(state);
    if (!this.isIntentCurrent(intent)) return undefined;
    const sessions = listedSessions.filter((session) => this.options.isSessionActive(session));
    const selectedId = this.selectSession(sessions, this.options.preferredSessionId?.(state) ?? intent.preferredSessionId);

    let snapshot: Snapshot | undefined;
    if (selectedId) {
      snapshot = await this.options.loadSnapshot(selectedId, state);
      if (!this.isIntentCurrent(intent)) return undefined;
      this.assertSnapshotIdentity(snapshot, selectedId);
    }

    let projection: CoordinatedProjection<State, Session, Snapshot> = {
      epoch: intent.epoch,
      diffRevision: this.diffRevision + 1,
      state,
      sessions,
      ...(selectedId ? { selectedId } : {}),
      ...(snapshot ? { snapshot } : {}),
    };
    const frames = this.framesAfter(intent.sequence);
    projection = this.options.applyFrames(projection, this.dedupeProjectionFrames(projection, frames));
    if (!this.isIntentCurrent(intent)) return undefined;
    this.validateRecoveredProjection(projection, authority);
    return {
      projection,
      framesThroughSequence: frames.at(-1)?.sequence ?? intent.sequence,
      rehydrateRequired: frames.some((input) => (
        input.sequence > hydrationStartSequence && this.options.frameRequiresRehydrate?.(input.frame) === true
      )),
    };
  }

  private validateRecoveredProjection(
    projection: CoordinatedProjection<State, Session, Snapshot>,
    authority: string | number | undefined,
  ): void {
    if (this.options.authorityKey(projection.state) !== authority) {
      throw new RecoveryInvalidatedError("Projection authority changed while the barrier was hydrating");
    }
    const selectedId = projection.selectedId;
    if (!selectedId) {
      if (projection.snapshot) throw new RecoveryInvalidatedError("Unselected projection must not retain a snapshot");
      return;
    }
    const selected = projection.sessions.find((session) => this.options.sessionId(session) === selectedId);
    if (!selected || !this.options.isSessionActive(selected)) {
      throw new RecoveryInvalidatedError("Selected session is no longer active after buffered frames were applied");
    }
    if (!projection.snapshot || this.options.snapshotSessionId(projection.snapshot) !== selectedId) {
      throw new RecoveryInvalidatedError("Selected session and recovered snapshot do not match");
    }
  }

  private selectSession(sessions: readonly Session[], preferredSessionId?: string): string | undefined {
    if (preferredSessionId) {
      const preferred = sessions.find((session) => this.options.sessionId(session) === preferredSessionId);
      if (preferred) return this.options.sessionId(preferred);
    }
    const first = sessions[0];
    return first ? this.options.sessionId(first) : undefined;
  }

  private assertSnapshotIdentity(snapshot: Snapshot, expectedSessionId: string): void {
    const actualSessionId = this.options.snapshotSessionId(snapshot);
    if (actualSessionId !== expectedSessionId) {
      throw new SnapshotIdentityMismatchError(
        `Snapshot for ${JSON.stringify(expectedSessionId)} returned ${JSON.stringify(actualSessionId)}`,
      );
    }
  }

  private replaySnapshot(
    snapshot: Snapshot,
    sessionId: string,
    frames: readonly SequencedProjectionFrame<Frame>[],
  ): Snapshot {
    let next = snapshot;
    const eventIds = new Set(this.options.snapshotEventIds(snapshot));
    for (const input of frames) {
      if (!this.options.frameRelatedToSnapshot(input.frame, next, sessionId)) continue;
      const eventId = this.options.frameEventId(input.frame);
      if (eventId && eventIds.has(eventId)) continue;
      next = this.options.applyFrameToSnapshot(next, input.frame);
      if (eventId) eventIds.add(eventId);
    }
    return next;
  }

  private dedupeProjectionFrames(
    projection: CoordinatedProjection<State, Session, Snapshot>,
    frames: readonly SequencedProjectionFrame<Frame>[],
  ): SequencedProjectionFrame<Frame>[] {
    const eventIds = new Set(projection.snapshot ? this.options.snapshotEventIds(projection.snapshot) : []);
    return frames.filter((input) => {
      const eventId = this.options.frameEventId(input.frame);
      if (!eventId) return true;
      if (eventIds.has(eventId)) return false;
      eventIds.add(eventId);
      return true;
    });
  }

  private framesAfter(sequence: number): SequencedProjectionFrame<Frame>[] {
    if (this.droppedThroughSequence > sequence) {
      throw new ProjectionReplayWindowError("Projection frames required by this request fell outside the replay window");
    }
    return this.frames
      .slice(this.frameHead)
      .filter((frame): frame is SequencedProjectionFrame<Frame> & { order: number; bytes: number } => (
        frame !== undefined && frame.sequence > sequence
      ))
      .sort(compareFrames)
      .map(({ sequence: frameSequence, frame }) => ({ sequence: frameSequence, frame }));
  }

  private isIntentCurrent(intent: BarrierIntent): boolean {
    return !this.disposed && this.syncing
      && this.currentBarrier?.epoch === intent.epoch && this.epoch === intent.epoch;
  }

  private waitBeforeRetry(): Promise<void> {
    if (this.retryDelayMs === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.resolveRetryDelay = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.resolveRetryDelay = undefined;
        resolve();
      }, this.retryDelayMs);
    });
  }

  private cancelRetryDelay(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const resolve = this.resolveRetryDelay;
    this.resolveRetryDelay = undefined;
    resolve?.();
  }

  private requireActive(): void {
    if (this.disposed) throw new ResyncCoordinatorDisposedError("Resync coordinator is disposed");
  }

  private notifyStatus(): void {
    this.options.statusChanged?.(this.status());
  }
}

function compareFrames<Frame>(
  left: SequencedProjectionFrame<Frame> & { order?: number },
  right: SequencedProjectionFrame<Frame> & { order?: number },
): number {
  return left.sequence - right.sequence || (left.order ?? 0) - (right.order ?? 0);
}

function requireSequence(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
}

function completionStatus(value: ResyncCompletion): "completed" | "retry" {
  if (value === "retry" || (value && typeof value === "object" && value.status === "retry")) return "retry";
  return "completed";
}
