import { describe, expect, test } from "bun:test";
import { focusedScrollDelta, readViewportFrame } from "./use-app-viewport.js";

describe("keyboard viewport", () => {
  test("uses the layout viewport when no visual viewport is available", () => {
    expect(readViewportFrame(852, null)).toEqual({ height: 852, top: 0, bottom: 0 });
  });

  test("keeps both the visible origin and keyboard inset after keyboard pan", () => {
    expect(readViewportFrame(852, { height: 430, offsetTop: 110, scale: 1 }))
      .toEqual({ height: 430, top: 110, bottom: 312 });
    expect(readViewportFrame(852, { height: 430, offsetTop: 0, scale: 1 }))
      .toEqual({ height: 430, top: 0, bottom: 422 });
  });

  test("does not resize the application around pinch zoom or invalid geometry", () => {
    expect(readViewportFrame(852, { height: 400, offsetTop: 100, scale: 2 })).toBeNull();
    expect(readViewportFrame(852, { height: 0, offsetTop: 0, scale: 1 })).toBeNull();
    expect(readViewportFrame(Number.NaN, null)).toBeNull();
  });

  test("brings a keyboard-covered field into its inner scroller", () => {
    const frame = { height: 430, top: 110, bottom: 312 };
    expect(focusedScrollDelta(frame, { top: 160, bottom: 540 }, { top: 540, bottom: 590 })).toBe(62);
    expect(focusedScrollDelta(frame, { top: 160, bottom: 540 }, { top: 130, bottom: 180 })).toBe(-42);
  });

  test("preserves the reading position when the field is already visible", () => {
    const frame = { height: 430, top: 110, bottom: 312 };
    expect(focusedScrollDelta(frame, { top: 160, bottom: 540 }, { top: 300, bottom: 350 })).toBe(0);
    expect(focusedScrollDelta(frame, { top: 600, bottom: 700 }, { top: 620, bottom: 670 })).toBe(0);
  });
});
