export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<SseEvent> {
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
      const chunk = await reader.read();
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
