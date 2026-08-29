import { describe, expect, test } from "bun:test";
import { isMenuNavigationKey, menuNavigationTarget, trappedTabTarget } from "./keyboard-navigation.js";

describe("dialog focus wrapping", () => {
  test("wraps only at the focus boundary and recovers focus that escaped", () => {
    expect(trappedTabTarget(2, 3, false)).toBe(0);
    expect(trappedTabTarget(0, 3, true)).toBe(2);
    expect(trappedTabTarget(1, 3, false)).toBeUndefined();
    expect(trappedTabTarget(1, 3, true)).toBeUndefined();
    expect(trappedTabTarget(-1, 3, false)).toBe(0);
    expect(trappedTabTarget(-1, 3, true)).toBe(2);
    expect(trappedTabTarget(-1, 0, false)).toBeUndefined();
  });
});

describe("task menu keyboard navigation", () => {
  test("wraps arrows and supports Home and End", () => {
    expect(menuNavigationTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuNavigationTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuNavigationTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuNavigationTarget("ArrowUp", -1, 3)).toBe(2);
    expect(menuNavigationTarget("Home", 2, 3)).toBe(0);
    expect(menuNavigationTarget("End", 0, 3)).toBe(2);
    expect(menuNavigationTarget("ArrowDown", 0, 0)).toBeUndefined();
  });

  test("recognizes only the supported composite-navigation keys", () => {
    expect(isMenuNavigationKey("ArrowDown")).toBe(true);
    expect(isMenuNavigationKey("End")).toBe(true);
    expect(isMenuNavigationKey("Escape")).toBe(false);
    expect(isMenuNavigationKey("Tab")).toBe(false);
  });
});
