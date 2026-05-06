import { CodeRenderable, RGBA, SyntaxStyle, type RenderNodeContext, type StyleDefinition } from "@opentui/core";
import type { Token } from "marked";
import type { TuiTheme } from "../theme/index.js";
import { fileLinksForText } from "./file-links.js";
import { TranscriptLines, type TranscriptLineModel } from "./lines.js";
import type { MarkdownLineTone } from "./markdown.js";
import { historyRenderModel } from "./render-model.js";

export function AssistantTextCell(props: { lines: readonly TranscriptLineModel[] }) {
  return <TranscriptLines lines={props.lines} />;
}

export function AssistantMarkdownCell(props: {
  cellKey: string;
  text: string;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
  fallbackLines: readonly TranscriptLineModel[];
}) {
  const content = props.text.trim().length === 0 ? "..." : props.text;
  const width = Math.max(1, Number.isFinite(props.width) ? Math.floor(props.width) : 80);
  if (content.trim().length === 0) return <AssistantTextCell lines={props.fallbackLines} />;
  return (
    <box width={width} maxWidth={width} flexDirection="row" overflow="hidden">
      <text fg={props.theme.colors.text.secondary} wrapMode="none">{"🌶️: "}</text>
      <box flexGrow={1} flexShrink={1} minWidth={1} flexDirection="column" overflow="hidden">
        <markdown
          content={content}
          width="100%"
          maxWidth="100%"
          fg={props.theme.colors.text.secondary}
          syntaxStyle={assistantMarkdownSyntaxStyle(props.theme)}
          conceal
          concealCode={false}
          streaming={props.streaming}
          renderNode={renderAssistantMarkdownNode}
          internalBlockMode="top-level"
          tableOptions={{
            style: "grid",
            widthMode: "content",
            columnFitter: "balanced",
            wrapMode: "word",
            cellPadding: 0,
            borders: true,
            outerBorder: true,
            borderStyle: "single",
            borderColor: props.theme.colors.border.default,
            selectable: true,
          }}
        />
      </box>
    </box>
  );
}

export function assistantTextCellLines(input: {
  key: string;
  text: string;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
  cwd?: string | undefined;
  prefix?: string | undefined;
  hangingIndent?: string | undefined;
}): TranscriptLineModel[] {
  return historyRenderModel.assistantTextLines({
    key: input.key,
    text: input.text,
    streaming: input.streaming,
    width: input.width,
    prefix: input.prefix ?? "🌶️: ",
    hangingIndent: input.hangingIndent ?? "    ",
  }).map((line) => ({
    key: line.key,
    text: line.text,
    fg: markdownFg(line.tone, input.theme),
    ...(input.cwd === undefined ? {} : { fileLinks: fileLinksForText(line.text, input.cwd) }),
  }));
}

function renderAssistantMarkdownNode(_token: Token, context: RenderNodeContext) {
  const renderable = context.defaultRender();
  if (renderable instanceof CodeRenderable) renderable.drawUnstyledText = true;
  return renderable;
}

const assistantMarkdownSyntaxStyleCache = new Map<string, SyntaxStyle>();

function assistantMarkdownSyntaxStyle(theme: TuiTheme): SyntaxStyle {
  const cacheKey = [
    theme.id,
    theme.colors.text.primary,
    theme.colors.text.secondary,
    theme.colors.text.muted,
    theme.colors.text.disabled,
    theme.colors.accent.secondary,
    theme.colors.status.success,
    theme.colors.status.error,
    theme.colors.status.info,
    theme.colors.status.warning,
  ].join("\0");
  const cached = assistantMarkdownSyntaxStyleCache.get(cacheKey);
  if (cached) return cached;

  const styles: Record<string, StyleDefinition> = {
    default: { fg: markdownRgba(theme.colors.text.secondary) },
    conceal: { fg: markdownRgba(theme.colors.text.disabled), dim: true },
    "markup.heading": { fg: markdownRgba(theme.colors.text.primary), bold: true },
    "markup.strong": { fg: markdownRgba(theme.colors.text.primary), bold: true },
    "markup.italic": { fg: markdownRgba(theme.colors.text.secondary), italic: true },
    "markup.strikethrough": { fg: markdownRgba(theme.colors.text.muted), dim: true },
    "markup.raw": { fg: markdownRgba(theme.colors.accent.secondary) },
    "markup.raw.block": { fg: markdownRgba(theme.colors.accent.secondary) },
    "markup.link": { fg: markdownRgba(theme.colors.accent.secondary) },
    "markup.link.label": { fg: markdownRgba(theme.colors.accent.secondary), underline: true },
    "markup.link.url": { fg: markdownRgba(theme.colors.text.muted), underline: true },
    "markup.quote": { fg: markdownRgba(theme.colors.text.muted), dim: true },
    comment: { fg: markdownRgba(theme.colors.text.muted), dim: true },
    keyword: { fg: markdownRgba(theme.colors.status.info) },
    string: { fg: markdownRgba(theme.colors.status.success) },
    number: { fg: markdownRgba(theme.colors.status.warning) },
    function: { fg: markdownRgba(theme.colors.accent.secondary) },
    variable: { fg: markdownRgba(theme.colors.text.secondary) },
    operator: { fg: markdownRgba(theme.colors.text.muted) },
    punctuation: { fg: markdownRgba(theme.colors.text.muted) },
  };
  const syntaxStyle = SyntaxStyle.fromStyles(styles);
  assistantMarkdownSyntaxStyleCache.set(cacheKey, syntaxStyle);
  return syntaxStyle;
}

function markdownRgba(color: string): RGBA {
  return RGBA.fromHex(color);
}

function markdownFg(tone: MarkdownLineTone, theme: TuiTheme): string {
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "quote" || tone === "code" || tone === "muted") return theme.colors.text.muted;
  return theme.colors.text.secondary;
}
