export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface ReadSseEventsOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000;

interface NormalizedReadSseEventsOptions {
  signal?: AbortSignal;
  idleTimeoutMs: number;
}

type SseReaderReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  options?: AbortSignal | ReadSseEventsOptions,
): AsyncIterable<SseEvent> {
  const { signal, idleTimeoutMs } = normalizeOptions(options);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancelReader = (): void => {
    void reader.cancel(abortError()).catch(() => {
      // Reader cancellation is best-effort; the next read will surface abort.
    });
  };

  try {
    if (signal?.aborted) throw abortError();
    signal?.addEventListener("abort", cancelReader, { once: true });
    while (true) {
      if (signal?.aborted) throw abortError();
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (chunk.done) break;
      buffer += normalizeNewlines(decoder.decode(chunk.value, { stream: true }));
      yield* drainEvents(buffer, (next) => {
        buffer = next;
      });
    }

    buffer += normalizeNewlines(decoder.decode());
    if (buffer.trim().length > 0) {
      yield parseSseEvent(buffer);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function normalizeOptions(options: AbortSignal | ReadSseEventsOptions | undefined): NormalizedReadSseEventsOptions {
  if (isAbortSignal(options)) {
    return { signal: options, idleTimeoutMs: DEFAULT_SSE_IDLE_TIMEOUT_MS };
  }
  const normalized: NormalizedReadSseEventsOptions = {
    idleTimeoutMs: options?.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS,
  };
  if (options?.signal) normalized.signal = options.signal;
  return normalized;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<SseReaderReadResult> {
  if (idleTimeoutMs <= 0) return reader.read();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = idleTimeoutError(idleTimeoutMs);
          reject(error);
          void reader.cancel(error).catch(() => undefined);
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function"
  );
}

function* drainEvents(buffer: string, updateBuffer: (next: string) => void): Iterable<SseEvent> {
  let cursor = buffer.indexOf("\n\n");
  while (cursor !== -1) {
    const raw = buffer.slice(0, cursor);
    buffer = buffer.slice(cursor + 2);
    if (raw.trim().length > 0) yield parseSseEvent(raw);
    cursor = buffer.indexOf("\n\n");
  }
  updateBuffer(buffer);
}

function parseSseEvent(raw: string): SseEvent {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + (line[separator + 1] === " " ? 2 : 1));
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }

  const parsed: SseEvent = { data: data.join("\n") };
  if (event !== undefined) parsed.event = event;
  if (id !== undefined) parsed.id = id;
  return parsed;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function abortError(): Error {
  const error = new Error("Model stream aborted");
  error.name = "AbortError";
  return error;
}

function idleTimeoutError(idleTimeoutMs: number): Error {
  const error = new Error(`SSE stream timed out after ${idleTimeoutMs}ms without data`);
  error.name = "SseIdleTimeoutError";
  return error;
}
