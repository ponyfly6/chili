import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  componentBackedCell,
  lineBackedCell,
  TranscriptCellView,
  TranscriptCellSliceView,
  windowTranscriptCells,
  type TranscriptCellModel,
  type TranscriptCellSlice,
} from "./cells.js";
import type { TranscriptLineModel } from "./lines.js";

test("line-backed cells slice a window across multiple cells", () => {
  const cells = [
    lineBackedCell("a", [line("a:1", "a1"), line("a:2", "a2")]),
    lineBackedCell("b", [line("b:1", "b1"), line("b:2", "b2"), line("b:3", "b3")]),
    lineBackedCell("c", [line("c:1", "c1")]),
  ];

  const window = windowTranscriptCells(cells, { visibleLimit: 4 });

  expect(window.totalLineCount).toBe(6);
  expect(window.contentLimit).toBe(3);
  expect(window.offset).toBe(0);
  expect(window.startLine).toBe(3);
  expect(window.endLine).toBe(6);
  expect(sliceTexts(window.slices)).toEqual(["b2", "b3", "c1"]);
});

test("scrollOffset is a rendered line offset from the bottom", () => {
  const cells = [
    lineBackedCell("a", [line("a:1", "a1"), line("a:2", "a2")]),
    lineBackedCell("b", [line("b:1", "b1"), line("b:2", "b2"), line("b:3", "b3")]),
    lineBackedCell("c", [line("c:1", "c1")]),
  ];

  const window = windowTranscriptCells(cells, { visibleLimit: 4, scrollOffset: 2 });

  expect(window.totalLineCount).toBe(6);
  expect(window.offset).toBe(2);
  expect(window.startLine).toBe(1);
  expect(window.endLine).toBe(4);
  expect(sliceTexts(window.slices)).toEqual(["a2", "b1", "b2"]);
});

test("component-backed cells use render() when the whole cell is visible", async () => {
  const cell = componentBackedCell({
    key: "component-full",
    render: () => <text fg="#ffffff" wrapMode="none">FULL_COMPONENT</text>,
    fallbackLines: [line("fallback", "FALLBACK_LINE")],
  });

  const window = windowTranscriptCells([cell], { visibleLimit: 4 });
  const frame = await renderSlice(window.slices[0]!);

  expect(window.slices[0]).toMatchObject({ startLine: 0, endLine: 1 });
  expect(frame).toContain("FULL_COMPONENT");
  expect(frame).not.toContain("FALLBACK_LINE");
});

test("full cell view always renders component-backed cells with render()", async () => {
  const cell = componentBackedCell({
    key: "component-full-view",
    render: () => <text fg="#ffffff" wrapMode="none">FULL_COMPONENT</text>,
    fallbackLines: [
      line("fallback:1", "fallback 1"),
      line("fallback:2", "fallback 2"),
      line("fallback:3", "fallback 3"),
    ],
  });

  const frame = await renderCell(cell);

  expect(frame).toContain("FULL_COMPONENT");
  expect(frame).not.toContain("fallback 1");
});

test("component-backed partial slices fall back to fallbackLines", async () => {
  const cell = componentBackedCell({
    key: "component-fallback",
    render: () => <text fg="#ffffff" wrapMode="none">FULL_COMPONENT</text>,
    fallbackLines: [
      line("fallback:1", "fallback 1"),
      line("fallback:2", "fallback 2"),
      line("fallback:3", "fallback 3"),
    ],
  });

  const window = windowTranscriptCells([cell], { visibleLimit: 2 });
  const frame = await renderSlice(window.slices[0]!);

  expect(window.slices[0]).toMatchObject({ startLine: 2, endLine: 3 });
  expect(frame).toContain("fallback 3");
  expect(frame).not.toContain("FULL_COMPONENT");
});

test("component-backed partial slices prefer renderLineSlice", async () => {
  const cell = componentBackedCell({
    key: "component-slice",
    render: () => <text fg="#ffffff" wrapMode="none">FULL_COMPONENT</text>,
    fallbackLines: [
      line("slice-fallback:1", "fallback 1"),
      line("slice-fallback:2", "fallback 2"),
      line("slice-fallback:3", "fallback 3"),
    ],
    renderLineSlice: ({ startLine, endLine }) => (
      <text fg="#ffffff" wrapMode="none">{`SLICE ${startLine}-${endLine}`}</text>
    ),
  });

  const window = windowTranscriptCells([cell], { visibleLimit: 2 });
  const frame = await renderSlice(window.slices[0]!);

  expect(window.slices[0]).toMatchObject({ startLine: 2, endLine: 3 });
  expect(frame).toContain("SLICE 2-3");
  expect(frame).not.toContain("fallback 3");
  expect(frame).not.toContain("FULL_COMPONENT");
});

test("component fallbackLines determine lineCount", () => {
  const cell = componentBackedCell({
    key: "component-count",
    render: () => <text fg="#ffffff" wrapMode="none">FULL_COMPONENT</text>,
    fallbackLines: [
      line("count:1", "one"),
      line("count:2", "two"),
    ],
  });

  expect(cell.lineCount).toBe(2);
});

async function renderSlice(slice: TranscriptCellSlice): Promise<string> {
  const app = await testRender(
    <box flexDirection="column">
      <TranscriptCellSliceView slice={slice} />
    </box>,
    { width: 80, height: 8, exitOnCtrlC: false },
  );

  try {
    await act(async () => {
      await app.renderOnce();
    });
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

async function renderCell(cell: TranscriptCellModel): Promise<string> {
  const app = await testRender(
    <box flexDirection="column">
      <TranscriptCellView cell={cell} />
    </box>,
    { width: 80, height: 8, exitOnCtrlC: false },
  );

  try {
    await act(async () => {
      await app.renderOnce();
    });
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

function sliceTexts(slices: readonly TranscriptCellSlice[]): string[] {
  const texts: string[] = [];
  for (const slice of slices) {
    const lines = sliceLines(slice.cell).slice(slice.startLine, slice.endLine);
    texts.push(...lines.map((line) => line.text));
  }
  return texts;
}

function sliceLines(cell: TranscriptCellModel): readonly TranscriptLineModel[] {
  if (cell.kind === "lines") return cell.lines;
  if (cell.fallbackLines) return cell.fallbackLines;
  throw new Error("component slice has no fallback lines");
}

function line(key: string, text: string): TranscriptLineModel {
  return { key, text, fg: "#ffffff" };
}
