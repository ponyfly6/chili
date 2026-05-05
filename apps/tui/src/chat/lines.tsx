import { StyledText, type MouseEvent, type TextChunk } from "@opentui/core";
import { fileLinksForText, fileUrlWithPosition, type FileLinkRange, type FileLinkTarget } from "./file-links.js";
import { wrapTerminalText } from "./markdown.js";

export interface TranscriptLineModel {
  key: string;
  text: string;
  fg: string;
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
  const content = linkedLineContent(props.line);
  return (
    <text
      fg={props.line.fg}
      content={content}
      wrapMode="none"
      truncate
      {...(props.selectionColors?.selectionBg === undefined ? {} : { selectionBg: props.selectionColors.selectionBg })}
      {...(props.selectionColors?.selectionFg === undefined ? {} : { selectionFg: props.selectionColors.selectionFg })}
      onMouseDown={(event: MouseEvent) => {
        const link = fileLinkAtMouseColumn(props.line.fileLinks, event);
        if (!link || !props.onOpenFile) return;
        event.preventDefault();
        event.stopPropagation();
        props.onOpenFile(link.target);
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

export function wrapLine(text: string, options: { key: string; fg: string; width: number; hangingIndent?: string; cwd?: string }): TranscriptLineModel[] {
  return wrapTerminalText(text, {
    key: options.key,
    width: options.width,
    ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
  }).map((line) => ({
    key: line.key,
    text: line.text,
    fg: options.fg,
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
): TranscriptLineModel[] {
  const output: TranscriptLineModel[] = [];
  const suffix = truncated ? " (truncated)" : "";
  output.push(...wrapLine(`  ${label}${suffix}:`, {
    key: `${key}:label`,
    fg,
    width,
    hangingIndent: "    ",
  }));
  for (const [index, line] of lines.entries()) {
    output.push(...wrapLine(`    ${line || " "}`, {
      key: `${key}:line:${index}`,
      fg,
      width,
      hangingIndent: "    ",
    }));
  }
  return output;
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
