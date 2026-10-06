import { expect, test } from "bun:test";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { createRuntimeHttpHandler, type RuntimeHttpService } from "./runtime-http.js";

test("HTTP JSON rejects an over-budget chunked body before draining or parsing it", async () => {
  const sqlite = new SqliteEventStore(":memory:");
  let created = 0;
  let pulls = 0;
  let cancelled = false;
  const handler = createRuntimeHttpHandler({
    store: new ObservableEventStore(sqlite),
    service: { createSession: async () => { created += 1; } } as unknown as RuntimeHttpService,
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Buffer.alloc(1_000_000, 32));
      if (pulls >= 100) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  try {
    const response = await handler(new Request("http://chili.test/sessions", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "1" },
      body, duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThan(35);
    expect(cancelled).toBe(true);
    expect(created).toBe(0);
  } finally { sqlite.close(); }
});

test("HTTP JSON reconstructs UTF-8 split between chunks before validating the request", async () => {
  const sqlite = new SqliteEventStore(":memory:");
  const inputs: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    store: new ObservableEventStore(sqlite),
    service: { createSession: async (input: unknown) => { inputs.push(input); return { sessionId: "ok" }; } } as unknown as RuntimeHttpService,
  });
  const bytes = new TextEncoder().encode('{"sessionId":"恢复"}');
  try {
    const response = await handler(new Request("http://chili.test/sessions", {
      method: "POST", body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }), duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(201);
    expect(inputs).toEqual([{ sessionId: "恢复" }]);
  } finally { sqlite.close(); }
});
