import { expect, test } from "bun:test";
import { isRetryableTransientError, normalizeRetryPolicy, retryDelay, sleep } from "./retry.js";

test("classifies Bun socket closure as retryable", () => {
  expect(
    isRetryableTransientError(
      new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"),
    ),
  ).toBe(true);
});

test("classifies operation timeout messages as retryable", () => {
  expect(isRetryableTransientError(new Error("Errno 60 Operation timed out"))).toBe(true);
});

test("classifies nested fetch causes by transient network code", () => {
  const cause = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" });
  const error = new Error("fetch failed") as Error & { cause?: unknown };
  error.cause = cause;

  expect(isRetryableTransientError(error)).toBe(true);
});

test("classifies retryable HTTP status failures", () => {
  expect(isRetryableTransientError(new Error("Model request failed with HTTP 503: overloaded"))).toBe(true);
  expect(isRetryableTransientError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true);
});

test("does not classify non-transient request failures as retryable", () => {
  expect(isRetryableTransientError(new Error("Model request failed with HTTP 400: invalid request"))).toBe(false);
  expect(isRetryableTransientError(new Error("certificate has expired"))).toBe(false);
});

test("default retry policy uses transient classifier", () => {
  const policy = normalizeRetryPolicy(undefined);

  expect(policy.retryable(new Error("The socket connection was closed unexpectedly"))).toBe(true);
});

test("explicit provider retryability overrides status and message heuristics", () => {
  expect(isRetryableTransientError(Object.assign(new Error("Too many requests"), {
    status: 429,
    retryable: false,
  }))).toBe(false);
  expect(isRetryableTransientError(Object.assign(new Error("invalid request"), {
    status: 400,
    retryable: true,
  }))).toBe(true);
});

test("nested non-retryable provider errors override retryable wrapper heuristics", () => {
  const cause = Object.assign(new Error("MiniMax plan capacity reached"), {
    retryable: false,
  });
  const wrapper = new Error("Model request failed with HTTP 429") as Error & { cause?: unknown };
  wrapper.cause = cause;

  expect(isRetryableTransientError(wrapper)).toBe(false);
});

test("nested retryable provider errors override non-retryable wrapper heuristics", () => {
  const cause = Object.assign(new Error("provider throttled"), {
    retryable: true,
  });
  const wrapper = new Error("Model request failed with HTTP 400") as Error & { cause?: unknown };
  wrapper.cause = cause;

  expect(isRetryableTransientError(wrapper)).toBe(true);
});

test("an explicit non-retryable aggregate member vetoes explicit retryable members", () => {
  const aggregate = {
    message: "Multiple provider failures",
    errors: [
      Object.assign(new Error("temporary"), { retryable: true }),
      Object.assign(new Error("quota exhausted"), { retryable: false }),
    ],
  };

  expect(isRetryableTransientError(aggregate)).toBe(false);
});

test("Retry-After is a minimum delay on top of exponential backoff", () => {
  const policy = normalizeRetryPolicy({ initialDelayMs: 100, maxDelayMs: 500, factor: 2 });

  expect(retryDelay(policy, 1)).toBe(100);
  expect(retryDelay(policy, 4)).toBe(500);
  expect(retryDelay(policy, 1, { retryAfterMs: 1_500 })).toBe(1_500);
  expect(retryDelay(policy, 1, { cause: { retryAfterMs: 900 } })).toBe(900);
});

test("retry waits remain abortable when Retry-After is long", async () => {
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal);

  controller.abort();

  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});
