import { RGBA, StyledText, type MouseEvent, type TextChunk } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useRef } from "react";
import { fileLinksForText, fileUrlWithPosition, type FileLinkRange, type FileLinkTarget } from "./file-links.js";
import { charDisplayWidth, wrapTerminalText } from "./markdown.js";
import { selectTextOnMultiClick, type TextClickState } from "./text-selection.js";

const TRANSCRIPT_HINT = "Ctrl+T for transcript";
const TRANSCRIPT_OMISSION_PATTERN = /^… (?:\+\d+(?: lines)?|output truncated|more)(?: \(|$)/;

export interface TranscriptLineModel {
  key: string;
  text: string;
  fg: string;
  bg?: string | undefined;
  fileLinks?: FileLinkRange[];
  leadingAccent?: LeadingAccent | undefined;
}

export interface LeadingAccent {
  length: number;
  fg: string;
}

export interface WrapLineOptions {
  key: string;
  fg: string;
  bg?: string | undefined;
  width: number;
  hangingIndent?: string | undefined;
  cwd?: string | undefined;
  leadingAccent?: LeadingAccent | undefined;
}

export type OpenFileLinkHandler = (target: FileLinkTarget) => void;

export interface TranscriptSelectionColors {
  selectionBg?: string | undefined;
  selectionFg?: string | undefined;
}

export function TranscriptLine(props: {
  line: TranscriptLineModel;
  onOpenFile?: OpenFileLinkHandler | undefined;
  selectionColors?: TranscriptSelectionColors | undefined;
}) {
  const renderer = useRenderer();
  const lastClickRef = useRef<TextClickState | null>(null);
  const content = linkedLineContent(props.line);
  return (
    <text
      fg={props.line.fg}
      {...(props.line.bg === undefined ? {} : { bg: props.line.bg, width: "100%" })}
      content={content}
      wrapMode="none"
      truncate
      {...(props.selectionColors?.selectionBg === undefined ? {} : { selectionBg: props.selectionColors.selectionBg })}
      {...(props.selectionColors?.selectionFg === undefined ? {} : { selectionFg: props.selectionColors.selectionFg })}
      onMouseDown={(event: MouseEvent) => {
        const link = fileLinkAtMouseColumn(props.line.fileLinks, event);
        if (link && props.onOpenFile) {
          event.preventDefault();
          event.stopPropagation();
          props.onOpenFile(link.target);
          return;
        }
        if (!selectTextOnMultiClick(renderer, lastClickRef, { key: props.line.key, text: props.line.text, event })) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}

export function TranscriptLines(props: {
  lines: readonly TranscriptLineModel[];
  onOpenFile?: OpenFileLinkHandler | undefined;
  selectionColors?: TranscriptSelectionColors | undefined;
}) {
  return (
    <box flexDirection="column">
      {props.lines.map((line) => (
        <TranscriptLine
          key={line.key}
          line={line}
          onOpenFile={props.onOpenFile}
          selectionColors={props.selectionColors}
        />
      ))}
    </box>
  );
}

export function wrapLine(text: string, options: WrapLineOptions): TranscriptLineModel[] {
  return wrapTerminalText(text, {
    key: options.key,
    width: options.width,
    ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
  }).map((line, index) => ({
    key: line.key,
    text: line.text,
    fg: options.fg,
    ...(options.bg === undefined ? {} : { bg: options.bg }),
    ...(options.cwd === undefined ? {} : { fileLinks: fileLinksForText(line.text, options.cwd) }),
    ...(index !== 0 || options.leadingAccent === undefined
      ? {}
      : { leadingAccent: normalizedLeadingAccent(options.leadingAccent, line.text.length) }),
  }));
}

export function detailPreviewLines(
  key: string,
  label: string,
  lines: readonly string[],
  truncated: boolean,
  width: number,
  fg: string,
  maxContentRows = 5,
): TranscriptLineModel[] {
  const contentRows = lines.flatMap((line, index) => {
    const text = `    ${line || " "}`;
    // The omission row describes hidden logical lines. Keep it to one visual row
    // so its count is not replaced by a second, width-based omission count.
    if (isTranscriptOmissionLine(line)) {
      return [{ key: `${key}:line:${index}`, text: formatTranscriptOmissionLine(line, width), fg }];
    }
    return wrapLine(text, {
      key: `${key}:line:${index}`,
      fg,
      width,
      hangingIndent: "    ",
    });
  });
  const clipped = clipTranscriptRows(contentRows, maxContentRows, `${key}:rows`, fg, width, truncated);
  const suffix = truncated || clipped.truncated ? " (truncated)" : "";
  return [
    ...wrapLine(`  ${label}${suffix}:`, {
    key: `${key}:label`,
    fg,
    width,
    hangingIndent: "    ",
    }),
    ...clipped.lines,
  ];
}

export function clipTranscriptRows(
  rows: readonly TranscriptLineModel[],
  maxRows: number,
  key: string,
  fg: string,
  width?: number,
  sourceTruncated = false,
): { lines: TranscriptLineModel[]; truncated: boolean } {
  if (!Number.isFinite(maxRows) || rows.length <= maxRows) return { lines: [...rows], truncated: false };
  const budget = Math.max(1, Math.floor(maxRows));
  const existingOmissionIndex = rows.findIndex((row) => isTranscriptOmissionLine(row.text));
  const canCountExactly = !sourceTruncated && existingOmissionIndex < 0;
  if (!canCountExactly) {
    return clipPreviouslyTruncatedRows(rows, budget, existingOmissionIndex, key, fg, width);
  }
  if (budget === 1) {
    return {
      lines: [{ key: `${key}:omitted`, text: clippedOmissionText(rows.length, true, width), fg }],
      truncated: true,
    };
  }
  const retainedRows = budget - 1;
  const headCount = Math.ceil(retainedRows / 2);
  const tailCount = retainedRows - headCount;
  const hiddenCount = rows.length - headCount - tailCount;
  return {
    lines: [
      ...rows.slice(0, headCount),
      { key: `${key}:omitted`, text: clippedOmissionText(hiddenCount, true, width), fg },
      ...(tailCount > 0 ? rows.slice(-tailCount) : []),
    ],
    truncated: true,
  };
}

export function isTranscriptOmissionLine(line: string): boolean {
  return TRANSCRIPT_OMISSION_PATTERN.test(line.trimStart());
}

export function formatTranscriptOmissionLine(line: string, width?: number, prefix = "    "): string {
  const full = `${prefix}${line}`;
  if (!isTranscriptOmissionLine(line) || width === undefined || displayWidth(full) <= width) return full;
  const count = line.match(/^… \+(\d+) lines/)?.[1];
  return `${prefix}${count === undefined ? "… more (Ctrl+T)" : `… +${count} (Ctrl+T)`}`;
}

function fileLinkAtMouseColumn(links: readonly FileLinkRange[] | undefined, event: MouseEvent): FileLinkRange | undefined {
  if (!links?.length || !(event.modifiers.ctrl || event.modifiers.alt) || event.button !== 0) return undefined;
  const targetX = event.target?.x ?? 0;
  const column = Math.max(0, event.x - targetX);
  return links.find((link) => column >= link.startColumn && column < link.endColumn);
}

function linkedLineContent(line: TranscriptLineModel): string | StyledText {
  const links = line.fileLinks ?? [];
  const leadingAccent = line.leadingAccent === undefined
    ? undefined
    : normalizedLeadingAccent(line.leadingAccent, line.text.length);
  if (links.length === 0 && leadingAccent === undefined) return line.text;

  const boundaries = new Set([0, line.text.length]);
  if (leadingAccent !== undefined) boundaries.add(leadingAccent.length);
  for (const link of links) {
    boundaries.add(Math.max(0, Math.min(line.text.length, link.startIndex)));
    boundaries.add(Math.max(0, Math.min(line.text.length, link.endIndex)));
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  const chunks: TextChunk[] = [];
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index]!;
    const end = offsets[index + 1]!;
    if (end <= start) continue;
    const link = links.find((candidate) => start >= candidate.startIndex && start < candidate.endIndex);
    chunks.push({
      __isChunk: true,
      text: line.text.slice(start, end),
      ...(leadingAccent !== undefined && start < leadingAccent.length
        ? { fg: RGBA.fromHex(leadingAccent.fg) }
        : {}),
      ...(link === undefined ? {} : { link: { url: fileUrlWithPosition(link.target) } }),
    });
  }
  return new StyledText(chunks);
}

function normalizedLeadingAccent(accent: LeadingAccent, textLength: number): LeadingAccent | undefined {
  if (!Number.isFinite(accent.length)) return undefined;
  const length = Math.max(0, Math.min(textLength, Math.floor(accent.length)));
  return length === 0 ? undefined : { length, fg: accent.fg };
}

function displayWidth(value: string): number {
  return [...value].reduce((total, char) => total + charDisplayWidth(char), 0);
}

function clippedOmissionText(hiddenCount: number, canCountExactly: boolean, width?: number): string {
  const line = canCountExactly
    ? `… +${hiddenCount} lines (${TRANSCRIPT_HINT})`
    : `… output truncated (${TRANSCRIPT_HINT})`;
  return formatTranscriptOmissionLine(line, width);
}

function clipPreviouslyTruncatedRows(
  rows: readonly TranscriptLineModel[],
  budget: number,
  existingOmissionIndex: number,
  key: string,
  fg: string,
  width?: number,
): { lines: TranscriptLineModel[]; truncated: true } {
  const omission = {
    key: `${key}:omitted`,
    text: clippedOmissionText(0, false, width),
    fg,
  };
  if (budget === 1) return { lines: [omission], truncated: true };

  const contentRows = rows.filter((row) => !isTranscriptOmissionLine(row.text));
  const contentBudget = budget - 1;
  if (existingOmissionIndex === 0) {
    return { lines: [omission, ...contentRows.slice(-contentBudget)], truncated: true };
  }
  if (existingOmissionIndex === rows.length - 1) {
    return { lines: [...contentRows.slice(0, contentBudget), omission], truncated: true };
  }

  const headCount = Math.ceil(contentBudget / 2);
  const tailCount = contentBudget - headCount;
  return {
    lines: [
      ...contentRows.slice(0, headCount),
      omission,
      ...(tailCount > 0 ? contentRows.slice(-tailCount) : []),
    ],
    truncated: true,
  };
}
