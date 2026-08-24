import { expect, test } from "bun:test";
import { ProviderBackpressureCoordinator } from "./provider-backpressure.js";
import {
  PROVIDER_PUBLIC_ERROR_MAX_BYTES,
  PROVIDER_RETRY_AFTER_MAX_MS,
  ProviderError,
  classifyProviderError,
  providerHttpError,
  providerPayloadError,
} from "./provider-error.js";

const scope = {
  provider: "minimax",
  endpoint: "https://api.minimaxi.com/anthropic/",
  credential: "key-a",
};

test("classifies MiniMax plan and quota codes as non-retryable circuit errors", () => {
  expect(classifyProviderError({ provider: "minimax", status: 429, code: 2062 })).toEqual({
    category: "plan_capacity",
    retryable: false,
    opensCircuit: true,
  });
  expect(classifyProviderError({ provider: "minimax", code: 2056 }).category).toBe("quota_exhausted");
  expect(classifyProviderError({ provider: "minimax", code: 1008 }).retryable).toBe(false);
});

test("classifies transient MiniMax and generic rate limits as retryable", () => {
  expect(classifyProviderError({ provider: "minimax", code: 1002 })).toEqual({
    category: "rate_limit",
    retryable: true,
    opensCircuit: false,
  });
  expect(classifyProviderError({ provider: "minimax", status: 429 })).toEqual({
    category: "rate_limit",
    retryable: true,
    opensCircuit: false,
  });
});

test("quota semantics take precedence over an HTTP 429 status", () => {
  expect(classifyProviderError({
    provider: "other",
    status: 429,
    type: "insufficient_quota",
    message: "Quota has been exhausted",
  })).toEqual({
    category: "quota_exhausted",
    retryable: false,
    opensCircuit: true,
  });
});

test("classifies ChatGPT usage limits as non-retryable quota errors", () => {
  for (const code of ["usage_limit_reached", "usage_not_included"]) {
    expect(classifyProviderError({ provider: "openai-codex", status: 429, code })).toEqual({
      category: "quota_exhausted",
      retryable: false,
      opensCircuit: true,
    });
  }
});

test("short-circuits sibling requests sharing a provider credential", async () => {
  let now = 1_000;
  const coordinator = new ProviderBackpressureCoordinator({
    circuitOpenMs: 5_000,
    now: () => now,
  });
  const planError = new ProviderError("Traffic is currently high (2062)", {
    provider: "minimax",
    status: 429,
    code: 2062,
  });

  coordinator.recordError(scope, planError);

  expect(coordinator.snapshot({ ...scope, endpoint: "https://api.minimaxi.com/anthropic" })).toMatchObject({
    mode: "circuit_open",
    blockedUntil: 6_000,
    error: planError,
  });
  await expect(coordinator.beforeRequest(scope)).rejects.toMatchObject({
    name: "ProviderError",
    category: "plan_capacity",
    retryable: false,
    code: "2062",
  });
  await expect(coordinator.beforeRequest({ ...scope, credential: "key-b" })).resolves.toBeUndefined();

  now = 6_000;
  await expect(coordinator.beforeRequest(scope)).resolves.toBeUndefined();
});

test("stores only a SHA-256 credential fingerprint in coordinator keys", () => {
  const credential = "sk-minimax-raw-secret-marker";
  const coordinator = new ProviderBackpressureCoordinator();
  const planError = new ProviderError("Traffic is currently high (2062)", {
    provider: "minimax",
    status: 429,
    code: 2062,
  });

  coordinator.recordError({ ...scope, credential }, planError);

  const states = (coordinator as unknown as { states: Map<string, unknown> }).states;
  const keys = [...states.keys()];
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toContain(credential);
  expect(keys[0]?.split("\u0000").at(-1)).toMatch(/^[0-9a-f]{64}$/);
});

test("shares Retry-After backpressure without opening a hard circuit", async () => {
  let now = 2_000;
  const waits: number[] = [];
  const coordinator = new ProviderBackpressureCoordinator({
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const rateLimit = new ProviderError("Too many requests", {
    provider: "minimax",
    status: 429,
    retryAfterMs: 1_250,
  });

  coordinator.recordError(scope, rateLimit);
  await coordinator.beforeRequest(scope);

  expect(waits).toEqual([1_250]);
  expect(coordinator.snapshot(scope)).toBeUndefined();
});

test("keeps Retry-After waits abortable", async () => {
  const coordinator = new ProviderBackpressureCoordinator();
  coordinator.recordError(scope, new ProviderError("Too many requests", {
    provider: "minimax",
    status: 429,
    retryAfterMs: 60_000,
  }));
  const controller = new AbortController();
  controller.abort();

  await expect(coordinator.beforeRequest(scope, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
    message: "Provider backpressure wait aborted",
  });
});

test("uses a bounded Retry-After hint for circuit duration", async () => {
  let now = 3_000;
  const coordinator = new ProviderBackpressureCoordinator({
    circuitOpenMs: 5_000,
    now: () => now,
  });
  const error = new ProviderError("Quota exhausted", {
    provider: "minimax",
    status: 429,
    retryAfterMs: 9_000,
  });

  coordinator.recordError(scope, error);
  expect(coordinator.snapshot(scope)?.blockedUntil).toBe(12_000);
  now = 11_999;
  await expect(coordinator.beforeRequest(scope)).rejects.toMatchObject({ category: "quota_exhausted" });
  now = 12_000;
  await expect(coordinator.beforeRequest(scope)).resolves.toBeUndefined();
});

test("sweeps expired state and bounds one-off backpressure keys", () => {
  let now = 1_000;
  const coordinator = new ProviderBackpressureCoordinator({ maxStates: 2, now: () => now });
  const error = new ProviderError("Quota exhausted", { provider: "minimax", status: 429 });
  coordinator.recordError({ ...scope, credential: "key-1" }, error);
  coordinator.recordError({ ...scope, credential: "key-2" }, error);
  coordinator.recordError({ ...scope, credential: "key-3" }, error);
  const states = (coordinator as unknown as { states: Map<string, unknown> }).states;
  expect(states.size).toBe(2);

  now = 40_000;
  coordinator.recordError({ ...scope, credential: "key-4" }, error);
  expect(states.size).toBe(1);
});

test("preserves safe metadata without exposing structured supplier text", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: {
      message: "Traffic high at 10.20.30.40, 2001:db8::1234, and ::ffff:192.0.2.1 with Bearer bearer-secret-123, api_key=api-secret-456, API key is SUPERSECRET12345, sk-live-secret-789, and eyJheaderlong.eyJpayloadlong.signaturelong",
      code: 2062,
      type: "rate_limit_error",
      param: "input",
      request_id: "req_json_1",
    },
  }), {
    status: 429,
    headers: { "retry-after": String(10 * 24 * 60 * 60) },
  }), { provider: "minimax", label: "Model request" });

  expect(error).toMatchObject({
    name: "ProviderError",
    provider: "minimax",
    status: 429,
    code: "2062",
    type: "rate_limit_error",
    param: "input",
    requestId: "req_json_1",
    retryAfterMs: PROVIDER_RETRY_AFTER_MAX_MS,
    category: "plan_capacity",
    retryable: false,
    opensCircuit: true,
    message: "Model request failed with HTTP 429 Too Many Requests (request id: req_json_1)",
  });
  expect(error.message).not.toContain("Traffic high");
  expect(error.message).not.toContain("10.20.30.40");
  expect(error.message).not.toContain("2001:db8::1234");
  expect(error.message).not.toContain("192.0.2.1");
  expect(error.message).not.toContain("bearer-secret-123");
  expect(error.message).not.toContain("api-secret-456");
  expect(error.message).not.toContain("SUPERSECRET12345");
  expect(error.message).not.toContain("live-secret-789");
  expect(error.message).not.toContain("eyJpayloadlong");
  expect("details" in error).toBe(false);
  expect("cause" in error).toBe(false);
});

test("bounds public messages by UTF-8 bytes", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: { message: "provider-private-message" },
  }), { status: 400 }), {
    provider: "openai",
    label: "Model request",
    selectJson: () => ({ publicMessage: "界".repeat(1_000) }),
  });

  expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(PROVIDER_PUBLIC_ERROR_MAX_BYTES);
  expect(error.message.endsWith("…")).toBe(true);
});

test("classifies from structured fields before truncating the public message", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: { message: `${"x".repeat(1_100)} quota exhausted` },
  }), { status: 429 }), { provider: "openai", label: "Model request" });

  expect(error).toMatchObject({
    category: "quota_exhausted",
    retryable: false,
    opensCircuit: true,
  });
  expect(error.message).not.toContain("quota exhausted");
  expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(PROVIDER_PUBLIC_ERROR_MAX_BYTES);
});

test("merges provider selectors over generic allowlisted fields", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: { message: "Raw safe detail", code: 2062, request_id: "req_merge_1" },
  }), { status: 429 }), {
    provider: "minimax",
    label: "Model request",
    selectJson: () => ({ publicMessage: "Friendly capacity message" }),
  });

  expect(error).toMatchObject({
    message: "Friendly capacity message",
    code: "2062",
    requestId: "req_merge_1",
    category: "plan_capacity",
  });
});

test("fails closed when a curated public-message override is unsafe", () => {
  const error = providerPayloadError({
    error: {
      message: "provider private quota detail",
      code: "usage_limit_reached",
      request_id: "req_curated_1",
    },
  }, {
    provider: "openai-codex",
    label: "Model response failed",
    details: { publicMessage: "<script>unsafe override</script>" },
  });

  expect(error.message).toBe("Model response failed (request id: req_curated_1)");
  expect(error.message).not.toContain("provider private quota detail");
  expect(error).toMatchObject({ category: "quota_exhausted", retryable: false, opensCircuit: true });
});

test("never exposes opaque HTML or plaintext HTTP bodies and cancels at the ingress limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(32 * 1024).fill(97));
    },
    cancel() {
      cancelled = true;
    },
  });
  const htmlError = await providerHttpError(new Response(
    "<!DOCTYPE html><html><body>origin 10.2.3.4 private-token</body></html>",
    { status: 502, headers: { "x-request-id": "req_header_1" } },
  ), { provider: "minimax", label: "Model request" });
  const boundedError = await providerHttpError(new Response(body, { status: 503 }), {
    provider: "minimax",
    label: "Model request",
  });

  expect(htmlError).toMatchObject({
    message: "Model request failed with HTTP 502 Bad Gateway (request id: req_header_1)",
    category: "server_error",
    retryable: true,
  });
  expect(htmlError.message).not.toContain("10.2.3.4");
  expect(boundedError.message).toBe("Model request failed with HTTP 503 Service Unavailable");
  expect(cancelled).toBe(true);
});

test("handles malformed structured fields without bypassing typed classification", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: { message: { secret: true }, type: 123, code: 1002 },
  }), { status: 429 }), { provider: "minimax", label: "Model request" });

  expect(error).toMatchObject({
    code: "1002",
    category: "rate_limit",
    retryable: true,
  });
});

test("sanitizes and bounds SSE payload errors", () => {
  const error = providerPayloadError({
    error: {
      message: `<script>private-stream-token</script>${"界".repeat(1_000)}`,
      code: "stream_failed",
      request_id: "req_stream_1",
    },
  }, { provider: "openai", label: "Model stream failed" });

  expect(error.message).toBe("Model stream failed (request id: req_stream_1)");
  expect(error.message).not.toContain("private-stream-token");
  expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(PROVIDER_PUBLIC_ERROR_MAX_BYTES);
});

test("rejects sensitive and non-machine structured fields from the public error object", () => {
  const error = providerPayloadError({
    publicMessage: "payload-controlled public message",
    error: {
      message: "credential=hunter2 password=swordfish client_secret=private-client",
      code: "credential",
      type: "client_secret",
      param: "session_cookie",
      request_id: "password:private-request-id",
    },
  }, { provider: "openai", label: "Model response failed" });

  expect(error.message).toBe("Model response failed");
  expect(error.code).toBeUndefined();
  expect(error.type).toBeUndefined();
  expect(error.param).toBeUndefined();
  expect(error.requestId).toBeUndefined();
  const serialized = `${error.message} ${JSON.stringify(error)}`;
  for (const probe of [
    "payload-controlled public message",
    "hunter2",
    "swordfish",
    "private-client",
    "private-request-id",
    "credential",
    "client_secret",
    "session_cookie",
  ]) {
    expect(serialized).not.toContain(probe);
  }
});

test("drops non-machine code, type, and param values while retaining classification", async () => {
  const error = await providerHttpError(new Response(JSON.stringify({
    error: {
      message: "Quota exhausted",
      code: "quota exhausted / credential=private",
      type: "rate limit error with password",
      param: "input field with spaces",
    },
  }), { status: 429 }), { provider: "openai", label: "Model request" });

  expect(error).toMatchObject({ category: "quota_exhausted", retryable: false, opensCircuit: true });
  expect(error.code).toBeUndefined();
  expect(error.type).toBeUndefined();
  expect(error.param).toBeUndefined();
  expect(error.message).toBe("Model request failed with HTTP 429 Too Many Requests");
});
