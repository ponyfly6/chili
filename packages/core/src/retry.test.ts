import { expect, test } from "bun:test";
import { isRetryableTransientError, normalizeRetryPolicy } from "./retry.js";

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
