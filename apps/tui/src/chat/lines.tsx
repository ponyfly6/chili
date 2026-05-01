import { wrapTerminalText } from "./markdown.js";

export interface TranscriptLineModel {
  key: string;
  text: string;
  fg: string;
}

export function TranscriptLine(props: { line: TranscriptLineModel }) {
  return (
    <text fg={props.line.fg} wrapMode="none" truncate>
      {props.line.text}
    </text>
  );
}

export function TranscriptLines(props: { lines: readonly TranscriptLineModel[] }) {
  return (
    <box flexDirection="column">
      {props.lines.map((line) => <TranscriptLine key={line.key} line={line} />)}
    </box>
  );
}

export function wrapLine(text: string, options: { key: string; fg: string; width: number; hangingIndent?: string }): TranscriptLineModel[] {
  return wrapTerminalText(text, {
    key: options.key,
    width: options.width,
    ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
  }).map((line) => ({ key: line.key, text: line.text, fg: options.fg }));
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
