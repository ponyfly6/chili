import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { FileLinkTarget } from "./file-links.js";
import {
  clipTranscriptRows,
  detailPreviewLines,
  TranscriptLine,
  wrapLine,
  type TranscriptLineModel,
} from "./lines.js";

const baseFg = "#c7c7c7";
const accentFg = "#ff4d4f";

test("wrapLine applies a leading accent only to the first visual line", () => {
  const lines = wrapLine("• Ran a command with enough text to wrap", {
    key: "accent:wrapped",
    fg: baseFg,
    width: 8,
    leadingAccent: { length: 1, fg: accentFg },
  });

  expect(lines.length).toBeGreaterThan(1);
  expect(lines[0]?.leadingAccent).toEqual({ length: 1, fg: accentFg });
  expect(lines.slice(1).every((line) => line.leadingAccent === undefined)).toBe(true);
});

test("clipped detail rows point to the full Ctrl+T transcript", () => {
  const rows = Array.from({ length: 8 }, (_, index): TranscriptLineModel => ({
    key: `row:${index}`,
    text: `    line ${index + 1}`,
    fg: baseFg,
  }));

  const clipped = clipTranscriptRows(rows, 5, "rows", baseFg);

  expect(clipped.truncated).toBe(true);
  expect(clipped.lines).toHaveLength(5);
  expect(clipped.lines[2]?.text).toBe("    … +4 lines (Ctrl+T for transcript)");
});

test("narrow rendered omission rows keep the Ctrl+T entry point visible", async () => {
  const rows = Array.from({ length: 3 }, (_, index): TranscriptLineModel => ({
    key: `narrow:${index}`,
    text: `    line ${index + 1}`,
    fg: baseFg,
  }));
  const [line] = clipTranscriptRows(rows, 1, "narrow", baseFg, 20).lines;

  expect(line?.text).toBe("    … +3 (Ctrl+T)");
  const rendered = await renderLine(line!, undefined, 20);
  expect(rendered.frame).toContain("… +3 (Ctrl+T)");
});

test("a second visual clip does not invent an exact count for an already truncated preview", () => {
  const logicalLines = [
    "A".repeat(36),
    "B".repeat(36),
    "… +3 lines (Ctrl+T for transcript)",
    "F".repeat(36),
    "G".repeat(36),
  ];

  const lines = detailPreviewLines("double-clip", "output", logicalLines, true, 24, baseFg);

  expect(lines.map((line) => line.text)).toContain("    … more (Ctrl+T)");
  expect(lines.some((line) => line.text.includes("… +9"))).toBe(false);
});

test("caller-known source truncation makes a later visual clip use a generic omission", () => {
  const rows = Array.from({ length: 8 }, (_, index): TranscriptLineModel => ({
    key: `source-truncated:${index}`,
    text: `    line ${index + 1}`,
    fg: baseFg,
  }));

  const clipped = clipTranscriptRows(rows, 5, "source-truncated", baseFg, 80, true);

  expect(clipped.lines[2]?.text).toBe("    … output truncated (Ctrl+T for transcript)");
});

test("a second visual clip replaces a leading omission instead of rendering two hints", () => {
  const rows: TranscriptLineModel[] = [
    { key: "leading-omission", text: "    … +2 (Ctrl+T)", fg: baseFg },
    ...Array.from({ length: 8 }, (_, index): TranscriptLineModel => ({
      key: `leading-omission:${index}`,
      text: `    latest line ${index + 1}`,
      fg: baseFg,
    })),
  ];

  const clipped = clipTranscriptRows(rows, 5, "leading-omission", baseFg, 20, true);

  expect(clipped.lines[0]?.text).toBe("    … more (Ctrl+T)");
  expect(clipped.lines.filter((line) => line.text.includes("Ctrl+T"))).toHaveLength(1);
  expect(clipped.lines.map((line) => line.text)).toEqual([
    "    … more (Ctrl+T)",
    "    latest line 5",
    "    latest line 6",
    "    latest line 7",
    "    latest line 8",
  ]);
});

test("TranscriptLine renders the accent separately from its base color alongside a file link", async () => {
  const [line] = wrapLine("• Ran src/main.ts:42", {
    key: "accent:linked",
    fg: baseFg,
    width: 80,
    cwd: "/repo",
    leadingAccent: { length: 1, fg: accentFg },
  });

  expect(line).toBeDefined();
  expect(line?.fileLinks?.map((link) => link.target)).toEqual([
    { path: "/repo/src/main.ts", line: 42 },
  ]);

  let openedTarget: FileLinkTarget | undefined;
  const rendered = await renderLine(line!, (target) => {
    openedTarget = target;
  });
  const position = frameTextPosition(rendered.frame, "• Ran src/main.ts:42");

  expect(foregroundMatches(rendered.fg, rendered.width, position.x, position.y, accentFg)).toBe(true);
  expect(foregroundMatches(rendered.fg, rendered.width, position.x + 2, position.y, baseFg)).toBe(true);
  expect(openedTarget).toEqual({ path: "/repo/src/main.ts", line: 42 });
});

async function renderLine(
  line: TranscriptLineModel,
  onOpenFile?: (target: FileLinkTarget) => void,
  width = 80,
): Promise<{
  frame: string;
  fg: Float32Array;
  width: number;
}> {
  const app = await testRender(
    <TranscriptLine line={line} onOpenFile={onOpenFile} />,
    { width, height: 4, exitOnCtrlC: false },
  );

  try {
    await act(async () => {
      await app.renderOnce();
    });
    const frame = app.captureCharFrame();
    if (onOpenFile) {
      const linkPosition = frameTextPosition(frame, "src/main.ts:42");
      await act(async () => {
        await app.mockMouse.click(linkPosition.x, linkPosition.y, 0, { modifiers: { ctrl: true } });
      });
    }
    return {
      frame,
      fg: app.renderer.currentRenderBuffer.buffers.fg.slice(),
      width: app.renderer.currentRenderBuffer.width,
    };
  } finally {
    app.renderer.destroy();
  }
}

function frameTextPosition(frame: string, text: string): { x: number; y: number } {
  for (const [y, line] of frame.split("\n").entries()) {
    const index = line.indexOf(text);
    if (index >= 0) return { x: Bun.stringWidth(line.slice(0, index)), y };
  }
  throw new Error(`Frame did not include ${text}`);
}

function foregroundMatches(
  buffer: Float32Array,
  width: number,
  x: number,
  y: number,
  color: string,
): boolean {
  const offset = (y * width + x) * 4;
  const value = color.replace(/^#/, "");
  const expected = [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    1,
  ];
  return expected.every((channel, index) => Math.abs((buffer[offset + index] ?? 0) - channel) < 0.001);
}
