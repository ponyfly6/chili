import type { MouseEvent, Renderable } from "@opentui/core";
import type { LineInfo } from "@opentui/core";

export interface TextClickState {
  targetKey: string;
  x: number;
  y: number;
  timeMs: number;
  count: number;
}

interface TextSelectionHost {
  startSelection: (renderable: Renderable, x: number, y: number) => void;
  updateSelection: (renderable: Renderable | undefined, x: number, y: number, options?: { finishDragging?: boolean }) => void;
  getSelection: () => { getSelectedText: () => string } | null;
  emit: (event: string, ...args: unknown[]) => boolean;
}

interface TextSelectionRange {
  startColumn: number;
  endColumn: number;
  startLineOffset: number;
  endLineOffset: number;
  selectedText?: string;
}

interface TextRenderableInfo {
  lineInfo?: LineInfo;
  plainText?: string;
  scrollY?: number;
  conceal?: boolean;
  filetype?: string;
}

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_MAX_DISTANCE = 1;

export function selectTextOnMultiClick(
  renderer: TextSelectionHost,
  lastClickRef: { current: TextClickState | null },
  input: { event: MouseEvent; key?: string; text?: string },
): boolean {
  const event = input.event;
  if (event.button !== 0 || event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift) {
    lastClickRef.current = null;
    return false;
  }

  const target = resolveSelectionTarget(event.target, event);
  if (!target || target.isDestroyed) {
    lastClickRef.current = null;
    return false;
  }

  const targetKey = input.key ?? `${target.num}:${target.id}`;
  const now = Date.now();
  const previous = lastClickRef.current;
  const nearLast = previous
    && previous.targetKey === targetKey
    && Math.abs(previous.x - event.x) <= DOUBLE_CLICK_MAX_DISTANCE
    && Math.abs(previous.y - event.y) <= DOUBLE_CLICK_MAX_DISTANCE
    && now - previous.timeMs <= DOUBLE_CLICK_MS;
  const count = nearLast ? Math.min(previous.count + 1, 3) : 1;
  lastClickRef.current = { targetKey, x: event.x, y: event.y, timeMs: now, count };
  if (count < 2) return false;

  const range = count === 2
    ? wordSelectionRangeForEvent(target, event, input.text)
    : lineSelectionRangeForEvent(target, event, input.text);
  if (!range) return false;

  renderer.startSelection(target, target.x + range.startColumn, event.y + range.startLineOffset);
  renderer.updateSelection(target, target.x + range.endColumn, event.y + range.endLineOffset, {
    finishDragging: true,
  });
  const selection = range.selectedText === undefined
    ? renderer.getSelection()
    : { getSelectedText: () => range.selectedText ?? "" };
  if (selection) renderer.emit("selection", selection);
  return true;
}

function resolveSelectionTarget(target: Renderable | null, event: MouseEvent): Renderable | undefined {
  if (!target || target.isDestroyed) return undefined;
  const nested = textRenderableAt(target, event.x, event.y);
  return nested ?? target;
}

function textRenderableAt(renderable: Renderable, x: number, y: number): Renderable | undefined {
  const children = renderable.getChildren();
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!isRenderableLike(child) || !containsPoint(child, x, y)) continue;
    const nested = textRenderableAt(child, x, y);
    if (nested) return nested;
    if (isSelectableTextRenderable(child, x, y)) return child;
  }
  return isSelectableTextRenderable(renderable, x, y) ? renderable : undefined;
}

function isRenderableLike(value: unknown): value is Renderable {
  return value !== null
    && typeof value === "object"
    && "x" in value
    && "y" in value
    && "width" in value
    && "height" in value
    && "shouldStartSelection" in value
    && "getChildren" in value;
}

function containsPoint(renderable: Renderable, x: number, y: number): boolean {
  return x >= renderable.x && x < renderable.x + renderable.width && y >= renderable.y && y < renderable.y + renderable.height;
}

function isSelectableTextRenderable(renderable: Renderable, x: number, y: number): boolean {
  return renderable.shouldStartSelection(x, y) && typeof textInfo(renderable).plainText === "string";
}

function wordSelectionRangeForEvent(target: Renderable, event: MouseEvent, explicitText: string | undefined): TextSelectionRange | undefined {
  const localX = Math.max(0, event.x - target.x);
  if (explicitText !== undefined) return withCurrentLine(wordSelectionRangeAtColumn(explicitText, localX), explicitText);

  const info = textInfo(target);
  if (typeof info.plainText !== "string" || info.plainText.length === 0) return undefined;
  const normalizedText = info.plainText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  const localY = Math.max(0, event.y - target.y);
  const lineInfo = info.lineInfo;
  if (lineInfo && lineInfo.lineSources.length > 0) {
    const visualLine = Math.max(0, (info.scrollY ?? 0) + localY);
    const sourceLine = lineInfo.lineSources[visualLine] ?? localY;
    const line = lines[sourceLine] ?? lines[localY] ?? "";
    const visibleLine = visibleLineForSelection(line, isMarkdownConcealTarget(info));
    const lineStartColumn = visualLineStartColumn(lineInfo, visualLine, sourceLine);
    const range = wordSelectionRangeAtColumn(visibleLine.text, visibleLine.sourceColumnToVisible(lineStartColumn) + localX);
    if (!range) return undefined;
    const start = visualPositionForVisibleColumn(lineInfo, sourceLine, visibleLine, range.startColumn, "start") ?? {
      visualLine,
      column: Math.max(0, range.startColumn - visibleLine.sourceColumnToVisible(lineStartColumn)),
    };
    const end = visualPositionForVisibleColumn(lineInfo, sourceLine, visibleLine, range.endColumn, "end") ?? {
      visualLine,
      column: Math.max(0, range.endColumn - visibleLine.sourceColumnToVisible(lineStartColumn)),
    };
    return {
      startColumn: start.column,
      endColumn: end.column,
      startLineOffset: start.visualLine - visualLine,
      endLineOffset: end.visualLine - visualLine,
      selectedText: displayColumnSlice(visibleLine.text, range.startColumn, range.endColumn),
    };
  }

  const line = lines[localY] ?? lines[0] ?? "";
  return withCurrentLine(wordSelectionRangeAtColumn(line, localX), line);
}

function lineSelectionRangeForEvent(target: Renderable, event: MouseEvent, explicitText: string | undefined): TextSelectionRange | undefined {
  if (explicitText !== undefined) {
    const width = terminalDisplayWidth(explicitText);
    return currentLineRange(0, Math.max(1, width), explicitText);
  }

  const info = textInfo(target);
  const localY = Math.max(0, event.y - target.y);
  const visualLine = Math.max(0, (info.scrollY ?? 0) + localY);
  const lineInfo = info.lineInfo;
  if (lineInfo && lineInfo.lineWidthCols.length > 0) {
    const sourceLine = lineInfo.lineSources[visualLine] ?? localY;
    const line = typeof info.plainText === "string"
      ? info.plainText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[sourceLine] ?? ""
      : "";
    const visibleLine = visibleLineForSelection(line, isMarkdownConcealTarget(info));
    const sourceStart = visualLineStartColumn(lineInfo, visualLine, sourceLine);
    const sourceWidth = lineInfo.lineWidthCols[visualLine] ?? target.width;
    const visibleStart = visibleLine.sourceColumnToVisible(sourceStart);
    const visibleEnd = visibleLine.sourceColumnToVisible(sourceStart + sourceWidth);
    const width = visibleEnd - visibleStart;
    return currentLineRange(0, Math.max(1, width), displayColumnSlice(visibleLine.text, visibleStart, visibleEnd));
  }

  if (typeof info.plainText !== "string") {
    return currentLineRange(0, Math.max(1, target.width));
  }
  const line = info.plainText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[localY] ?? info.plainText;
  return currentLineRange(0, Math.max(1, terminalDisplayWidth(line)), line);
}

function textInfo(renderable: Renderable): TextRenderableInfo {
  return renderable as Renderable & TextRenderableInfo;
}

interface VisibleLineForSelection {
  text: string;
  sourceColumnToVisible: (sourceColumn: number) => number;
}

function isMarkdownConcealTarget(info: TextRenderableInfo): boolean {
  return info.conceal === true && (info.filetype === "markdown" || info.filetype === "markdown_inline");
}

function visibleLineForSelection(line: string, markdownConceal: boolean): VisibleLineForSelection {
  if (!markdownConceal) return identityVisibleLine(line);
  const ranges = markdownConcealRanges(line);
  if (ranges.length === 0) return identityVisibleLine(line);
  return concealedVisibleLine(line, ranges);
}

function identityVisibleLine(line: string): VisibleLineForSelection {
  return {
    text: line,
    sourceColumnToVisible: (sourceColumn) => Math.max(0, Math.min(terminalDisplayWidth(line), sourceColumn)),
  };
}

interface ConcealRange {
  startIndex: number;
  endIndex: number;
  replacement: string;
}

function concealedVisibleLine(line: string, ranges: ConcealRange[]): VisibleLineForSelection {
  const sourceToVisible: number[] = [0];
  let text = "";
  let sourceColumn = 0;
  let visibleColumn = 0;
  let index = 0;

  const appendVisible = (segment: string) => {
    for (const part of textSegments(segment)) {
      const width = terminalDisplayWidth(part);
      text += part;
      for (let offset = 0; offset <= width; offset += 1) {
        sourceToVisible[sourceColumn + offset] = visibleColumn + offset;
      }
      sourceColumn += width;
      visibleColumn += width;
    }
  };

  const appendConcealed = (source: string, replacement: string) => {
    const sourceWidth = terminalDisplayWidth(source);
    const replacementWidth = terminalDisplayWidth(replacement);
    for (let offset = 0; offset < sourceWidth; offset += 1) {
      sourceToVisible[sourceColumn + offset] = visibleColumn;
    }
    sourceColumn += sourceWidth;
    text += replacement;
    visibleColumn += replacementWidth;
    sourceToVisible[sourceColumn] = visibleColumn;
  };

  for (const range of ranges) {
    if (range.startIndex < index) continue;
    appendVisible(line.slice(index, range.startIndex));
    appendConcealed(line.slice(range.startIndex, range.endIndex), range.replacement);
    index = range.endIndex;
  }
  appendVisible(line.slice(index));

  return {
    text,
    sourceColumnToVisible: (sourceColumnInput) => {
      const sourceWidth = terminalDisplayWidth(line);
      const clamped = Math.max(0, Math.min(sourceWidth, sourceColumnInput));
      return sourceToVisible[clamped] ?? visibleColumn;
    },
  };
}

function markdownConcealRanges(line: string): ConcealRange[] {
  const ranges: ConcealRange[] = [];
  const add = (startIndex: number, endIndex: number, replacement = "") => {
    if (startIndex < 0 || endIndex <= startIndex || endIndex > line.length) return;
    if (ranges.some((range) => startIndex < range.endIndex && endIndex > range.startIndex)) return;
    ranges.push({ startIndex, endIndex, replacement });
  };

  const heading = /^(#{1,6})(?=\s)/u.exec(line);
  if (heading) add(0, heading[1]?.length ?? 0);

  addDelimitedConcealRanges(line, "~~", add);
  addDelimitedConcealRanges(line, "**", add);
  addDelimitedConcealRanges(line, "__", add);
  addDelimitedConcealRanges(line, "`", add);
  addDelimitedConcealRanges(line, "*", add);
  addDelimitedConcealRanges(line, "_", add);
  addInlineLinkConcealRanges(line, add);
  addEntityConcealRanges(line, add);

  return ranges.sort((left, right) => left.startIndex - right.startIndex);
}

function addDelimitedConcealRanges(
  line: string,
  delimiter: string,
  add: (startIndex: number, endIndex: number, replacement?: string) => void,
) {
  let searchFrom = 0;
  while (searchFrom < line.length) {
    const start = line.indexOf(delimiter, searchFrom);
    if (start < 0) break;
    const contentStart = start + delimiter.length;
    const end = line.indexOf(delimiter, contentStart);
    if (end < 0) break;
    if (end > contentStart && shouldConcealDelimiterPair(line, delimiter, start, end)) {
      add(start, contentStart);
      add(end, end + delimiter.length);
    }
    searchFrom = end + delimiter.length;
  }
}

function shouldConcealDelimiterPair(line: string, delimiter: string, start: number, end: number): boolean {
  if (delimiter.length === 1) {
    if (line[start - 1] === delimiter || line[start + 1] === delimiter) return false;
    if (line[end - 1] === delimiter || line[end + 1] === delimiter) return false;
  }
  if (!delimiter.includes("_")) return true;
  const beforeOpen = line[start - 1] ?? "";
  const afterOpen = line[start + delimiter.length] ?? "";
  const beforeClose = line[end - 1] ?? "";
  const afterClose = line[end + delimiter.length] ?? "";
  return !(isAsciiAlphaNumeric(beforeOpen) && isAsciiAlphaNumeric(afterOpen))
    && !(isAsciiAlphaNumeric(beforeClose) && isAsciiAlphaNumeric(afterClose));
}

function isAsciiAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]$/u.test(value);
}

function addInlineLinkConcealRanges(
  line: string,
  add: (startIndex: number, endIndex: number, replacement?: string) => void,
) {
  const linkPattern = /!?\[[^\]\n]*\]\([^) \n]+(?:\s+"[^"\n]*")?\)/gu;
  for (const match of line.matchAll(linkPattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const isImage = raw.startsWith("!");
    const openBracket = start + (isImage ? 1 : 0);
    const closeBracket = start + raw.indexOf("]");
    const openParen = closeBracket + 1;
    const closeParen = start + raw.length - 1;
    if (isImage) {
      add(start, start + 1);
      add(openBracket, openBracket + 1);
      add(closeBracket, closeBracket + 1);
      add(openParen, closeParen + 1);
    } else {
      add(openBracket, openBracket + 1);
      add(closeBracket, closeBracket + 1, " ");
    }
  }
}

function addEntityConcealRanges(
  line: string,
  add: (startIndex: number, endIndex: number, replacement?: string) => void,
) {
  const replacements = new Map<string, string>([
    ["&nbsp;", ""],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&amp;", "&"],
    ["&quot;", "\""],
    ["&ensp;", " "],
    ["&emsp;", " "],
  ]);
  for (const [entity, replacement] of replacements) {
    let index = line.indexOf(entity);
    while (index >= 0) {
      add(index, index + entity.length, replacement);
      index = line.indexOf(entity, index + entity.length);
    }
  }
}

function visualPositionForVisibleColumn(
  lineInfo: LineInfo,
  sourceLine: number,
  visibleLine: VisibleLineForSelection,
  visibleColumn: number,
  edge: "start" | "end",
): { visualLine: number; column: number } | undefined {
  let fallback: { visualLine: number; column: number } | undefined;
  for (let visualLine = 0; visualLine < lineInfo.lineSources.length; visualLine += 1) {
    if (lineInfo.lineSources[visualLine] !== sourceLine) continue;
    const sourceStart = visualLineStartColumn(lineInfo, visualLine, sourceLine);
    const sourceWidth = lineInfo.lineWidthCols[visualLine] ?? 0;
    const start = visibleLine.sourceColumnToVisible(sourceStart);
    const end = visibleLine.sourceColumnToVisible(sourceStart + sourceWidth);
    const width = Math.max(0, end - start);
    fallback = { visualLine, column: Math.max(0, Math.min(width, visibleColumn - start)) };
    if (edge === "start" && visibleColumn >= start && visibleColumn < end) return fallback;
    if (edge === "end" && visibleColumn > start && visibleColumn <= end) return fallback;
  }
  return fallback;
}

function visualLineStartColumn(lineInfo: LineInfo, visualLine: number, sourceLine: number): number {
  const rawStart = lineInfo.lineStartCols[visualLine] ?? 0;
  return Math.max(0, rawStart - sourceLineBaseColumn(lineInfo, sourceLine));
}

function sourceLineBaseColumn(lineInfo: LineInfo, sourceLine: number): number {
  const visualLine = lineInfo.lineSources.findIndex((line) => line === sourceLine);
  if (visualLine < 0) return 0;
  return lineInfo.lineStartCols[visualLine] ?? 0;
}

function withCurrentLine(range: WordSelectionRange | undefined, text?: string): TextSelectionRange | undefined {
  if (!range) return undefined;
  return currentLineRange(range.startColumn, range.endColumn, text === undefined ? undefined : displayColumnSlice(text, range.startColumn, range.endColumn));
}

function currentLineRange(startColumn: number, endColumn: number, selectedText?: string): TextSelectionRange {
  return { startColumn, endColumn, startLineOffset: 0, endLineOffset: 0, ...(selectedText === undefined ? {} : { selectedText }) };
}

interface WordSelectionRange {
  startColumn: number;
  endColumn: number;
}

function wordSelectionRangeAtColumn(text: string, column: number): WordSelectionRange | undefined {
  const segments = displaySegments(text);
  const hitIndex = segments.findIndex((segment) => column >= segment.startColumn && column < segment.endColumn);
  const hit = segments[hitIndex];
  const hitClass = hit ? segmentClass(hit.text) : undefined;
  if (!hit || hitClass === undefined || hitClass === "space") return undefined;

  let startIndex = hitIndex;
  while (startIndex > 0 && segmentClass(segments[startIndex - 1]?.text ?? "") === hitClass) startIndex -= 1;

  let endIndex = hitIndex + 1;
  while (endIndex < segments.length && segmentClass(segments[endIndex]?.text ?? "") === hitClass) endIndex += 1;

  while (endIndex > startIndex + 1 && isTrailingWordPunctuation(segments[endIndex - 1]?.text ?? "")) endIndex -= 1;

  const start = segments[startIndex];
  const end = segments[endIndex - 1];
  if (!start || !end || start.startColumn >= end.endColumn) return undefined;
  return { startColumn: start.startColumn, endColumn: end.endColumn };
}

function displaySegments(text: string): Array<{ text: string; startColumn: number; endColumn: number }> {
  const segments: Array<{ text: string; startColumn: number; endColumn: number }> = [];
  let column = 0;
  for (const segment of textSegments(text)) {
    const width = terminalDisplayWidth(segment);
    segments.push({ text: segment, startColumn: column, endColumn: column + width });
    column += width;
  }
  return segments;
}

function displayColumnSlice(text: string, startColumn: number, endColumn: number): string {
  let output = "";
  let column = 0;
  for (const segment of textSegments(text)) {
    const width = terminalDisplayWidth(segment);
    const nextColumn = column + width;
    if (nextColumn > startColumn && column < endColumn) output += segment;
    if (nextColumn >= endColumn) break;
    column = nextColumn;
  }
  return output;
}

function textSegments(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}

function terminalDisplayWidth(text: string): number {
  return Bun.stringWidth(text);
}

function segmentClass(segment: string): "word" | "punct" | "space" | undefined {
  if (segment.length === 0) return undefined;
  if (/^\s$/u.test(segment)) return "space";
  if (/^[\p{L}\p{N}_/.\-+~\\:]$/u.test(segment)) return "word";
  return "punct";
}

function isTrailingWordPunctuation(segment: string): boolean {
  return /^[.,!?;]$/u.test(segment);
}
