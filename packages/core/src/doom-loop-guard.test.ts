import { expect, test } from "bun:test";
import { DoomLoopGuard } from "./doom-loop-guard.js";

test("counts equivalent tool inputs across turns while resetting each turn's total", () => {
  const guard = new DoomLoopGuard({ maxRepeatedToolCalls: 1, maxToolCallsPerTurn: 1 });
  expect(guard.check({ toolName: "read", input: { path: "a", offset: 1 } })).toEqual({ ok: true, count: 1, total: 1 });
  guard.beginTurn();
  expect(guard.check({ toolName: "read", input: { offset: 1, path: "a" } })).toEqual({
    ok: false, reason: "repeated_tool_call", count: 2, total: 1,
  });
});

test("enforces the total tool limit only within a model turn", () => {
  const guard = new DoomLoopGuard({ maxToolCallsPerTurn: 1 });
  expect(guard.check({ toolName: "read", input: { path: "a" } }).ok).toBe(true);
  expect(guard.check({ toolName: "read", input: { path: "b" } })).toMatchObject({
    ok: false, reason: "tool_call_limit", total: 2,
  });
  guard.beginTurn();
  expect(guard.check({ toolName: "read", input: { path: "b" } })).toEqual({ ok: true, count: 1, total: 1 });
});

test("detects short repeated cycles in the recent call window", () => {
  const guard = new DoomLoopGuard({ maxRepeatedToolCalls: 2, repetitionWindowSize: 6 });
  for (const path of ["a", "b", "a", "b"]) {
    guard.beginTurn();
    expect(guard.check({ toolName: "read", input: { path } }).ok).toBe(true);
  }
  guard.beginTurn();
  expect(guard.check({ toolName: "read", input: { path: "a" } })).toMatchObject({
    ok: false, reason: "repeated_tool_call", count: 3,
  });
});

test("expires old repetition counts after intervening distinct calls", () => {
  const guard = new DoomLoopGuard({ maxRepeatedToolCalls: 1, repetitionWindowSize: 3 });
  for (const path of ["a", "b", "c", "d", "a"]) {
    guard.beginTurn();
    expect(guard.check({ toolName: "read", input: { path } })).toEqual({ ok: true, count: 1, total: 1 });
  }
});
