import { expect, test } from "bun:test";
import { ProviderBackpressureCoordinator } from "./provider-backpressure.js";
import { ProviderError, classifyProviderError } from "./provider-error.js";

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
