import { expect, test } from "bun:test";
import { goalTokenDelta } from "./goal.js";

test("goal token accounting prefers complete provider totals", () => {
  expect(goalTokenDelta({
    inputTokens: 4,
    outputTokens: 1,
    cacheReadInputTokens: 11_963,
    totalTokens: 11_968,
  })).toBe(11_968);
});

test("goal token accounting includes cache usage when totals are unavailable", () => {
  expect(goalTokenDelta({
    inputTokens: 4,
    outputTokens: 1,
    cacheReadInputTokens: 11,
    cacheCreationInputTokens: 3,
  })).toBe(19);
});
