import { expect, test } from "bun:test";
import { startNodeHttpTransport } from "./node-http-transport.js";

function tlsCredentials(): Bun.TLSOptions {
  return {
    cert: Bun.file(new URL("./fixtures/localhost-test-cert.pem", import.meta.url)),
    key: Bun.file(new URL("./fixtures/localhost-test-key.pem", import.meta.url)),
  };
}

test("HTTP transport accepts a single TLS configuration inside an array", async () => {
  const transport = startNodeHttpTransport({
    tls: [tlsCredentials()],
    handler: () => new Response("encrypted"),
  });
  try {
    expect(new URL(transport.url).protocol).toBe("https:");
    const response = await fetch(transport.url, { tls: { rejectUnauthorized: false } });
    expect(await response.text()).toBe("encrypted");
  } finally {
    await transport.close();
  }
});

test("HTTP transport forwards native TLS cipher settings instead of dropping them", () => {
  expect(() => startNodeHttpTransport({
    tls: { ...tlsCredentials(), ciphers: "invalid-chili-cipher" },
    handler: () => new Response("unexpected"),
  })).toThrow("Failed to bind HTTP transport");
});

test("HTTP transport cancels a pending response read when the client disconnects", async () => {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  let requestSignal: AbortSignal | undefined;
  const transport = startNodeHttpTransport({
    handler: (request) => {
      requestSignal = request.signal;
      return new Response(new ReadableStream<Uint8Array>({
        cancel: resolveCancelled,
      }));
    },
  });
  const abort = new AbortController();
  try {
    await fetch(transport.url, { signal: abort.signal });
    abort.abort();
    await cancelled;
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    abort.abort();
    await transport.close();
  }
});
