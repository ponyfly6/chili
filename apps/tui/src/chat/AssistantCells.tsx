import { CodeRenderable, RGBA, SyntaxStyle, type MouseEvent, type RenderNodeContext, type StyleDefinition } from "@opentui/core";
import type { AssistantMessagePhase } from "@chili/protocol";
import type { Token } from "marked";
import type { TuiTheme } from "../theme/index.js";
import { fileLinksForText } from "./file-links.js";
import { TranscriptLines, type TranscriptLineModel } from "./lines.js";
import type { MarkdownLineTone } from "./markdown.js";
import { historyRenderModel } from "./render-model.js";
import { selectTextOnMultiClick, type TextClickState } from "./text-selection.js";

const assistantMarkdownClickRef: { current: TextClickState | null } = { current: null };

type AssistantTextTone = "normal" | "muted";

interface AssistantTextPresentation {
  prefix: string;
  hangingIndent: string;
  tone: AssistantTextTone;
}

export function assistantTextPresentation(phase: AssistantMessagePhase | undefined): AssistantTextPresentation {
  if (phase === "commentary") return { prefix: "↳ ", hangingIndent: "  ", tone: "muted" };
  if (phase === "final_answer") return { prefix: "🌶️: ", hangingIndent: "    ", tone: "normal" };
  return { prefix: "Assistant: ", hangingIndent: "           ", tone: "normal" };
}

export function AssistantTextCell(props: { lines: readonly TranscriptLineModel[] }) {
  return <TranscriptLines lines={props.lines} />;
}

export function AssistantMarkdownCell(props: {
  cellKey: string;
  text: string;
  phase?: AssistantMessagePhase | undefined;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
  fallbackLines: readonly TranscriptLineModel[];
}) {
  const presentation = assistantTextPresentation(props.phase);
  const renderNode = assistantMarkdownRenderNode(props.theme);
  const content = props.text.trim().length === 0 ? "..." : props.text;
  const width = Math.max(1, Number.isFinite(props.width) ? Math.floor(props.width) : 80);
  if (content.trim().length === 0) return <AssistantTextCell lines={props.fallbackLines} />;
  return (
    <box
      width={width}
      maxWidth={width}
      flexDirection="row"
      overflow="hidden"
      onMouseDown={(event: MouseEvent) => {
        const renderer = event.target?.ctx;
        if (!renderer || !selectTextOnMultiClick(renderer, assistantMarkdownClickRef, { event })) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <text fg={assistantTextFg(presentation.tone, props.theme)} flexShrink={0} wrapMode="none">{presentation.prefix}</text>
      <box flexGrow={1} flexShrink={1} minWidth={1} flexDirection="column" overflow="hidden">
        <markdown
          content={content}
          width="100%"
          maxWidth="100%"
          fg={assistantTextFg(presentation.tone, props.theme)}
          syntaxStyle={assistantMarkdownSyntaxStyle(props.theme, presentation.tone)}
          conceal
          concealCode={false}
          streaming={props.streaming}
          renderNode={renderNode}
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
            borderColor: presentation.tone === "muted"
              ? props.theme.colors.text.muted
              : props.theme.colors.border.default,
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
  phase?: AssistantMessagePhase | undefined;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
  cwd?: string | undefined;
}): TranscriptLineModel[] {
  const presentation = assistantTextPresentation(input.phase);
  return historyRenderModel.assistantTextLines({
    key: input.key,
    text: input.text,
    streaming: input.streaming,
    width: input.width,
    prefix: presentation.prefix,
    hangingIndent: presentation.hangingIndent,
  }).map((line) => ({
    key: line.key,
    text: line.text,
    fg: markdownFg(line.tone, input.theme, presentation.tone),
    ...(input.cwd === undefined ? {} : { fileLinks: fileLinksForText(line.text, input.cwd) }),
  }));
}

function assistantMarkdownRenderNode(theme: TuiTheme): (token: Token, context: RenderNodeContext) => ReturnType<RenderNodeContext["defaultRender"]> {
  return (_token: Token, context: RenderNodeContext) => {
    const renderable = context.defaultRender();
    if (renderable instanceof CodeRenderable) {
      renderable.drawUnstyledText = true;
      renderable.selectionBg = theme.colors.menu.selectedBackground;
      renderable.selectionFg = theme.colors.menu.selectedText;
    }
    return renderable;
  };
}

const assistantMarkdownSyntaxStyleCache = new Map<string, SyntaxStyle>();

function assistantMarkdownSyntaxStyle(theme: TuiTheme, tone: AssistantTextTone): SyntaxStyle {
  const cacheKey = [
    theme.id,
    tone,
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

  const color = (normal: string) => tone === "muted" ? theme.colors.text.muted : normal;

  const styles: Record<string, StyleDefinition> = {
    default: { fg: markdownRgba(color(theme.colors.text.secondary)) },
    conceal: { fg: markdownRgba(color(theme.colors.text.disabled)), dim: true },
    "markup.heading": { fg: markdownRgba(color(theme.colors.text.primary)), bold: true },
    "markup.strong": { fg: markdownRgba(color(theme.colors.text.primary)), bold: true },
    "markup.italic": { fg: markdownRgba(color(theme.colors.text.secondary)), italic: true },
    "markup.strikethrough": { fg: markdownRgba(color(theme.colors.text.muted)), dim: true },
    "markup.raw": { fg: markdownRgba(color(theme.colors.accent.secondary)) },
    "markup.raw.block": { fg: markdownRgba(color(theme.colors.accent.secondary)) },
    "markup.link": { fg: markdownRgba(color(theme.colors.accent.secondary)) },
    "markup.link.label": { fg: markdownRgba(color(theme.colors.accent.secondary)), underline: true },
    "markup.link.url": { fg: markdownRgba(color(theme.colors.text.muted)), underline: true },
    "markup.quote": { fg: markdownRgba(color(theme.colors.text.muted)), dim: true },
    comment: { fg: markdownRgba(color(theme.colors.text.muted)), dim: true },
    keyword: { fg: markdownRgba(color(theme.colors.status.info)) },
    string: { fg: markdownRgba(color(theme.colors.status.success)) },
    number: { fg: markdownRgba(color(theme.colors.status.warning)) },
    function: { fg: markdownRgba(color(theme.colors.accent.secondary)) },
    variable: { fg: markdownRgba(color(theme.colors.text.secondary)) },
    operator: { fg: markdownRgba(color(theme.colors.text.muted)) },
    punctuation: { fg: markdownRgba(color(theme.colors.text.muted)) },
  };
  const syntaxStyle = SyntaxStyle.fromStyles(styles);
  assistantMarkdownSyntaxStyleCache.set(cacheKey, syntaxStyle);
  return syntaxStyle;
}

function markdownRgba(color: string): RGBA {
  return RGBA.fromHex(color);
}

function markdownFg(tone: MarkdownLineTone, theme: TuiTheme, assistantTone: AssistantTextTone): string {
  if (assistantTone === "muted") return theme.colors.text.muted;
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "quote" || tone === "code" || tone === "muted") return theme.colors.text.muted;
  return theme.colors.text.secondary;
}

function assistantTextFg(tone: AssistantTextTone, theme: TuiTheme): string {
  return tone === "muted" ? theme.colors.text.muted : theme.colors.text.secondary;
}
