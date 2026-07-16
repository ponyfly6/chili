import { StyledText, type MouseEvent, type TextChunk } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useRef } from "react";
import { fileLinksForText, fileUrlWithPosition, type FileLinkRange, type FileLinkTarget } from "./file-links.js";
import { wrapTerminalText } from "./markdown.js";
import { selectTextOnMultiClick, type TextClickState } from "./text-selection.js";

export interface TranscriptLineModel {
  key: string;
  text: string;
  fg: string;
  bg?: string | undefined;
  fileLinks?: FileLinkRange[];
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

export function wrapLine(text: string, options: { key: string; fg: string; bg?: string; width: number; hangingIndent?: string; cwd?: string }): TranscriptLineModel[] {
  return wrapTerminalText(text, {
    key: options.key,
    width: options.width,
    ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
  }).map((line) => ({
    key: line.key,
    text: line.text,
    fg: options.fg,
    ...(options.bg === undefined ? {} : { bg: options.bg }),
    ...(options.cwd === undefined ? {} : { fileLinks: fileLinksForText(line.text, options.cwd) }),
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
  const contentRows = lines.flatMap((line, index) => wrapLine(`    ${line || " "}`, {
    key: `${key}:line:${index}`,
    fg,
    width,
    hangingIndent: "    ",
  }));
  const clipped = clipTranscriptRows(contentRows, maxContentRows, `${key}:rows`, fg);
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
): { lines: TranscriptLineModel[]; truncated: boolean } {
  if (!Number.isFinite(maxRows) || rows.length <= maxRows) return { lines: [...rows], truncated: false };
  const budget = Math.max(1, Math.floor(maxRows));
  if (budget === 1) {
    return {
      lines: [{ key: `${key}:omitted`, text: `    … +${rows.length} lines`, fg }],
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
      { key: `${key}:omitted`, text: `    … +${hiddenCount} lines`, fg },
      ...(tailCount > 0 ? rows.slice(-tailCount) : []),
    ],
    truncated: true,
  };
}

function fileLinkAtMouseColumn(links: readonly FileLinkRange[] | undefined, event: MouseEvent): FileLinkRange | undefined {
  if (!links?.length || !(event.modifiers.ctrl || event.modifiers.alt) || event.button !== 0) return undefined;
  const targetX = event.target?.x ?? 0;
  const column = Math.max(0, event.x - targetX);
  return links.find((link) => column >= link.startColumn && column < link.endColumn);
}

function linkedLineContent(line: TranscriptLineModel): string | StyledText {
  const links = line.fileLinks;
  if (!links?.length) return line.text;

  const chunks: TextChunk[] = [];
  let index = 0;
  for (const link of links) {
    if (link.startIndex < index) continue;
    if (link.startIndex > index) {
      chunks.push({ __isChunk: true, text: line.text.slice(index, link.startIndex) });
    }
    chunks.push({
      __isChunk: true,
      text: line.text.slice(link.startIndex, link.endIndex),
      link: { url: fileUrlWithPosition(link.target) },
    });
    index = link.endIndex;
  }
  if (index < line.text.length) chunks.push({ __isChunk: true, text: line.text.slice(index) });
  return new StyledText(chunks);
}
