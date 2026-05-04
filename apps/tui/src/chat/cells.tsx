import type { ReactNode } from "react";
import { TranscriptLines, type TranscriptLineModel } from "./lines.js";

export type TranscriptCellModel = LineBackedTranscriptCellModel | ComponentBackedTranscriptCellModel;
export type TranscriptCellLineSliceRenderer = (range: { startLine: number; endLine: number }) => ReactNode;

export interface LineBackedTranscriptCellModel {
  kind: "lines";
  key: string;
  lineCount: number;
  lines: TranscriptLineModel[];
}

type ComponentBackedTranscriptCellBase = {
  kind: "component";
  key: string;
  lineCount: number;
  render: () => ReactNode;
};

type ComponentBackedTranscriptCellWithFallback = ComponentBackedTranscriptCellBase & {
  fallbackLines: TranscriptLineModel[];
  renderLineSlice?: TranscriptCellLineSliceRenderer | undefined;
};

type ComponentBackedTranscriptCellWithLineSlice = ComponentBackedTranscriptCellBase & {
  renderLineSlice: TranscriptCellLineSliceRenderer;
  fallbackLines?: undefined;
};

export type ComponentBackedTranscriptCellModel =
  | ComponentBackedTranscriptCellWithFallback
  | ComponentBackedTranscriptCellWithLineSlice;

type ComponentBackedCellBaseInput = {
  key: string;
  render: () => ReactNode;
};

export type ComponentBackedCellInput =
  | (ComponentBackedCellBaseInput & {
      fallbackLines: readonly TranscriptLineModel[];
      renderLineSlice?: TranscriptCellLineSliceRenderer | undefined;
    })
  | (ComponentBackedCellBaseInput & {
      lineCount: number;
      renderLineSlice: TranscriptCellLineSliceRenderer;
      fallbackLines?: undefined;
    });

export interface TranscriptCellSlice {
  key: string;
  cell: TranscriptCellModel;
  startLine: number;
  endLine: number;
}

export interface TranscriptCellWindow {
  totalLineCount: number;
  contentLimit: number;
  maxOffset: number;
  offset: number;
  startLine: number;
  endLine: number;
  slices: TranscriptCellSlice[];
}

export function lineBackedCell(key: string, lines: readonly TranscriptLineModel[]): TranscriptCellModel {
  return {
    kind: "lines",
    key,
    lineCount: lines.length,
    lines: [...lines],
  };
}

export function componentBackedCell(input: ComponentBackedCellInput): TranscriptCellModel {
  if (input.fallbackLines !== undefined) {
    const fallbackLines = [...input.fallbackLines];
    return {
      kind: "component",
      key: input.key,
      lineCount: fallbackLines.length,
      render: input.render,
      fallbackLines,
      ...(input.renderLineSlice === undefined ? {} : { renderLineSlice: input.renderLineSlice }),
    };
  }
  return {
    kind: "component",
    key: input.key,
    lineCount: input.lineCount,
    render: input.render,
    renderLineSlice: input.renderLineSlice,
  };
}

export function windowTranscriptCells(
  cells: readonly TranscriptCellModel[],
  input: { visibleLimit: number; scrollOffset?: number | undefined },
): TranscriptCellWindow {
  const totalLineCount = cells.reduce((count, cell) => count + cell.lineCount, 0);
  const limit = Math.max(1, input.visibleLimit);
  const contentLimit = totalLineCount > limit ? Math.max(1, limit - 1) : limit;
  const maxOffset = Math.max(0, totalLineCount - contentLimit);
  const offset = Math.min(Math.max(0, input.scrollOffset ?? 0), maxOffset);
  const endLine = totalLineCount - offset;
  const startLine = Math.max(0, endLine - contentLimit);
  const slices = cellSlices(cells, startLine, endLine);
  return {
    totalLineCount,
    contentLimit,
    maxOffset,
    offset,
    startLine,
    endLine,
    slices,
  };
}

export function TranscriptCellSliceView(props: { slice: TranscriptCellSlice }) {
  const { cell, startLine, endLine } = props.slice;
  if (cell.kind === "lines") {
    return <TranscriptLines lines={cell.lines.slice(startLine, endLine)} />;
  }

  if (startLine === 0 && endLine === cell.lineCount) {
    return <>{cell.render()}</>;
  }
  if (cell.renderLineSlice) {
    return <>{cell.renderLineSlice({ startLine, endLine })}</>;
  }
  if (cell.fallbackLines === undefined) {
    throw new Error("component-backed transcript cell requires renderLineSlice or fallbackLines for partial slices");
  }
  return <TranscriptLines lines={cell.fallbackLines.slice(startLine, endLine)} />;
}

export function TranscriptCellView(props: { cell: TranscriptCellModel }) {
  if (props.cell.kind === "lines") {
    return <TranscriptLines lines={props.cell.lines} />;
  }
  return <>{props.cell.render()}</>;
}

function cellSlices(cells: readonly TranscriptCellModel[], startLine: number, endLine: number): TranscriptCellSlice[] {
  const slices: TranscriptCellSlice[] = [];
  let cursor = 0;
  for (const cell of cells) {
    const cellStart = cursor;
    const cellEnd = cursor + cell.lineCount;
    cursor = cellEnd;
    if (cell.lineCount === 0 || cellEnd <= startLine || cellStart >= endLine) continue;
    const sliceStart = Math.max(0, startLine - cellStart);
    const sliceEnd = Math.min(cell.lineCount, endLine - cellStart);
    if (sliceStart >= sliceEnd) continue;
    slices.push({
      key: `${cell.key}:slice:${sliceStart}:${sliceEnd}`,
      cell,
      startLine: sliceStart,
      endLine: sliceEnd,
    });
  }
  return slices;
}
