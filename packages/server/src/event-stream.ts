import { compactRuntimeEvent, isTransientEvent, type ChiliEvent, type SessionId } from "@chili/protocol";
import { EventPageTooLargeError, UnknownEventCursorError, type EventPublisher, type EventQuery, type EventStore } from "@chili/store";

export interface EventStreamOptions {
  store: EventStore & EventPublisher;
  request: Request;
  sessionId?: SessionId;
  afterEventId?: string;
  fromStart?: boolean;
  maxBacklogEvents: number;
  /** Optional operational overrides; healthy connections do not rotate by default. */
  maxDurableEvents?: number;
  maxAgeMs?: number;
  maxBufferedBytes: number;
  maxTransientBytes: number;
  maxPageBytes: number;
  pollIntervalMs: number;
  stallTimeoutMs: number;
}

const MAX_SSE_FRAME_BYTES = 4_000_000;
const MAX_SSE_RESYNC_FRAME_BYTES = 4_096;
const PAGE_EVENTS = 64;
const HEARTBEAT = Buffer.from(": heartbeat\n\n");

/**
 * Durable notifications are hints. Only a serial, strictly-after-cursor store
 * read supplies durable frames. The cursor here means enqueued, not delivered:
 * clients always resume with the last durable frame they actually consumed.
 *
 * Resident transport data is bounded by the stream's byte high-water mark,
 * one byte-bounded database page, one encoded frame, the transient byte budget,
 * and at most one small terminal control frame. Node/Bun/socket buffers belong
 * to the HTTP transport; pull/desiredSize is the pressure boundary exposed here.
 */
export async function eventStream(options: EventStreamOptions): Promise<Response> {
  let active = true;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let stalled: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let terminalFrame: Uint8Array | undefined;
  let terminalError: Error | undefined;
  let durableCursor = options.afterEventId;
  let durableSent = 0;
  let rotationDue = false;
  let dirty = true;
  let running = false;
  let initialized = false;
  let page: ChiliEvent[] = [];
  const transients: Uint8Array[] = [];
  let transientBytes = 0;

  const finishController = (): void => {
    if (!controller) return;
    try {
      if (terminalError) controller.error(terminalError);
      else {
        if (terminalFrame) controller.enqueue(terminalFrame);
        controller.close();
      }
    } catch { /* A consumer may already have cancelled. */ }
    terminalFrame = undefined;
    controller = undefined;
  };

  const end = (frame?: Uint8Array, error?: Error): void => {
    if (!active) return;
    active = false;
    terminalFrame = frame;
    terminalError = error;
    unsubscribe?.();
    unsubscribe = undefined;
    options.request.signal.removeEventListener("abort", abort);
    if (heartbeat) clearInterval(heartbeat);
    if (poll) clearInterval(poll);
    if (rotation) clearTimeout(rotation);
    if (stalled) clearTimeout(stalled);
    heartbeat = poll = rotation = stalled = undefined;
    transients.length = 0;
    transientBytes = 0;
    page.length = 0;
    dirty = false;
    wake?.();
    wake = undefined;
    finishController();
  };
  const abort = (): void => end();
  const resync = (reason: "event_transport_limit" | "transient_buffer_overflow", afterEventId?: string): void => {
    try { end(formatSseResync(reason, afterEventId)); }
    catch { end(); }
  };

  const query = (extra: EventQuery): EventQuery => ({
    compactRequests: true,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...extra,
  });

  const waitForCapacity = async (bytes: number): Promise<boolean> => {
    if (bytes > options.maxBufferedBytes) {
      resync("event_transport_limit", durableCursor);
      return false;
    }
    while (active && controller && (controller.desiredSize ?? 0) < bytes) {
      if (!stalled) {
        stalled = setTimeout(() => end(undefined, new Error("SSE consumer exceeded the buffer stall timeout")), options.stallTimeoutMs);
        stalled.unref?.();
      }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (stalled) clearTimeout(stalled);
    stalled = undefined;
    return active && !!controller;
  };

  const enqueue = async (frame: Uint8Array): Promise<boolean> => {
    if (!await waitForCapacity(frame.byteLength)) return false;
    try { controller!.enqueue(frame); return true; }
    catch { end(); return false; }
  };

  const readPage = async (): Promise<ChiliEvent[]> => {
    const input = query({
      ...(durableCursor ? { afterEventId: durableCursor } : {}),
      limit: PAGE_EVENTS,
      maxBytes: options.maxPageBytes,
    });
    try { return await options.store.events(input) as ChiliEvent[]; }
    catch (error) {
      if (!(error instanceof EventPageTooLargeError)) throw error;
      // A legal large event gets its own page; poison rows never get decoded.
      if (error.bytes > MAX_SSE_FRAME_BYTES) {
        resync("event_transport_limit", error.eventId);
        return [];
      }
      try {
        return await options.store.events({ ...input, limit: 1, maxBytes: MAX_SSE_FRAME_BYTES }) as ChiliEvent[];
      } catch (retryError) {
        if (!(retryError instanceof EventPageTooLargeError)) throw retryError;
        resync("event_transport_limit", retryError.eventId);
        return [];
      }
    }
  };

  const pump = (): void => {
    if (!active || !initialized || running) return;
    running = true;
    void (async () => {
      try {
        while (active) {
          if (dirty) {
            // Do not fetch a new page while the outgoing queue is full.
            if (!await waitForCapacity(1)) break;
            dirty = false;
            page = await readPage();
            if (!active) break;
            let advanced = false;
            for (const event of page) {
              if (isTransientEvent(event)) continue;
              let frame: Uint8Array;
              try { frame = formatSse(event); }
              catch (error) {
                if (isRuntimeEventTransportLimitError(error)) resync("event_transport_limit", event.id);
                else end();
                break;
              }
              if (!await enqueue(frame)) break;
              durableCursor = event.id;
              durableSent += 1;
              advanced = true;
              if ((options.maxDurableEvents && durableSent >= options.maxDurableEvents) || rotationDue) {
                end();
                break;
              }
            }
            page.length = 0;
            // A byte-limited page can be short without reaching the tip.
            // Always query through an empty page before releasing live deltas.
            if (advanced) dirty = true;
            if (dirty) continue;
          }
          const transient = transients.shift();
          if (!transient) break;
          transientBytes -= transient.byteLength;
          if (!await enqueue(transient)) break;
        }
      } catch {
        // Resume revalidates the consumer's cursor and uses snapshot recovery
        // if retention, store replacement, or backlog limits invalidated it.
        end();
      } finally {
        page.length = 0;
        running = false;
        if (active && (dirty || transients.length)) pump();
      }
    })();
  };

  if (options.request.signal.aborted) end();
  else {
    options.request.signal.addEventListener("abort", abort, { once: true });
    unsubscribe = options.store.subscribe((event) => {
      if (!active || (options.sessionId && event.sessionId !== options.sessionId)) return;
      if (isTransientEvent(event)) {
        let frame: Uint8Array;
        try { frame = formatSse(event); }
        catch { resync("transient_buffer_overflow", durableCursor); return; }
        if (transientBytes + frame.byteLength > options.maxTransientBytes) {
          resync("transient_buffer_overflow", durableCursor);
          return;
        }
        transients.push(frame);
        transientBytes += frame.byteLength;
      }
      // Even transient notifications trigger catchup: their durable tool/turn
      // anchors may have committed before their notifications were delivered.
      dirty = true;
      pump();
    });
  }

  if (active) {
    try {
      const resumed = !!options.afterEventId || !!options.fromStart;
      const boundaryQuery = {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.afterEventId ? { afterEventId: options.afterEventId } : {}),
        limit: options.maxBacklogEvents + (resumed ? 1 : 0),
        tail: !resumed,
      };
      const boundary = options.store.eventReplayBoundary
        ? await options.store.eventReplayBoundary(boundaryQuery)
        : await fallbackReplayBoundary(options.store, boundaryQuery, options.request.signal);
      if (resumed && boundary.count > options.maxBacklogEvents) {
        throw {
          status: 409,
          message: `Event backlog exceeds the ${options.maxBacklogEvents}-event replay limit. Restore /events/snapshot, then resume from its cursor.`,
        };
      }
      if (!resumed) durableCursor = boundary.afterEventId;
    } catch (error) {
      end();
      if (error instanceof UnknownEventCursorError) {
        throw {
          status: 409,
          message: `Unknown event cursor ${JSON.stringify(error.eventId)}. Restore /events/snapshot, then resume from its cursor.`,
        };
      }
      throw error;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (!active) { finishController(); return; }
      initialized = true;
      heartbeat = setInterval(() => {
        if (!active || running || !controller || (controller.desiredSize ?? 0) < HEARTBEAT.byteLength) return;
        try { controller.enqueue(HEARTBEAT); } catch { end(); }
      }, 5_000);
      poll = setInterval(() => { dirty = true; pump(); }, options.pollIntervalMs);
      heartbeat.unref?.();
      poll.unref?.();
      if (options.maxAgeMs) {
        rotation = setTimeout(() => {
          rotationDue = true;
          if (durableCursor) end();
        }, options.maxAgeMs);
        rotation.unref?.();
      }
      pump();
    },
    pull() { wake?.(); wake = undefined; },
    cancel() { end(); },
  }, { highWaterMark: options.maxBufferedBytes, size: (frame) => frame?.byteLength ?? 0 });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

// Compatibility for custom stores. SQLite supplies a metadata-only boundary;
// this fallback retains at most one small page while locating the same cursor.
async function fallbackReplayBoundary(store: EventStore, query: EventQuery, signal: AbortSignal): Promise<{ afterEventId?: string; count: number }> {
  const target = query.limit ?? 5_000;
  let remaining = target + (query.tail ? 1 : 0);
  let count = 0;
  let cursor = query.afterEventId;
  while (remaining > 0 && !signal.aborted) {
    let batch;
    try {
      batch = await store.events({
        compactRequests: true,
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(cursor ? query.tail ? { beforeEventId: cursor } : { afterEventId: cursor } : {}),
        tail: !!query.tail,
        limit: Math.min(PAGE_EVENTS, remaining),
        maxBytes: MAX_SSE_FRAME_BYTES,
      });
    } catch (error) {
      if (!(error instanceof EventPageTooLargeError)) throw error;
      // The first candidate is too large, but its identity still lets this
      // count-only scan advance; streaming later emits the recovery control.
      cursor = error.eventId;
      count += 1;
      remaining -= 1;
      continue;
    }
    if (!batch.length) break;
    count += batch.length;
    remaining -= batch.length;
    cursor = query.tail ? batch[0]!.id : batch.at(-1)!.id;
  }
  return query.tail
    ? { ...(count > target && cursor ? { afterEventId: cursor } : {}), count: Math.min(count, target) }
    : { ...(query.afterEventId ? { afterEventId: query.afterEventId } : {}), count };
}

function formatSse(event: ChiliEvent): Uint8Array {
  const payload = JSON.stringify(compactRuntimeEvent(event));
  const prefix = `${!isTransientEvent(event) ? `id: ${event.id}\n` : ""}event: chili.event\ndata: `;
  const frameBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(payload, "utf8") + 2;
  if (frameBytes > MAX_SSE_FRAME_BYTES) {
    const error = new Error(`Runtime event ${event.id} exceeds the ${MAX_SSE_FRAME_BYTES}-byte SSE frame boundary`);
    error.name = "RuntimeEventTransportLimitError";
    throw error;
  }
  const frame = Buffer.allocUnsafe(frameBytes);
  let offset = frame.write(prefix, 0, "utf8");
  offset += frame.write(payload, offset, "utf8");
  frame.write("\n\n", offset, "utf8");
  return frame;
}

function formatSseResync(reason: "event_transport_limit" | "transient_buffer_overflow", afterEventId?: string): Uint8Array {
  const frame = `event: chili.resync\ndata: ${JSON.stringify({
    reason,
    ...(afterEventId ? { afterEventId } : {}),
    message: reason === "event_transport_limit"
      ? "A runtime event exceeded the transport byte boundary. An authoritative snapshot is required."
      : "Live output exceeded the transient byte budget. An authoritative snapshot is required; temporary output may be incomplete.",
  })}\n\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_SSE_RESYNC_FRAME_BYTES) throw new Error("Oversized resync control frame");
  return Buffer.from(frame, "utf8");
}

function isRuntimeEventTransportLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "RuntimeEventTransportLimitError";
}
