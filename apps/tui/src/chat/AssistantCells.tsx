import { Lexer, type Token, type Tokens } from "marked";
import type { TuiTheme } from "../theme/index.js";
import { TranscriptLines, type TranscriptLineModel } from "./lines.js";
import { markdownTableToTerminalLines, textContentHash, wrapTerminalText, type MarkdownLineTone } from "./markdown.js";
import { historyRenderModel } from "./render-model.js";
import { splitStreamingMarkdown } from "./streaming.js";

export type AssistantMarkdownBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "diff"
  | "blockquote"
  | "table"
  | "hr"
  | "fallback";

export interface AssistantMarkdownBlock {
  key: string;
  kind: AssistantMarkdownBlockKind;
  lines: TranscriptLineModel[];
}

export interface AssistantMarkdownBlockCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface CachedAssistantMarkdownBlocks {
  source: string;
  blocks: AssistantMarkdownBlock[];
}

const MAX_RICH_MARKDOWN_CACHE_ENTRIES = 120;
const richMarkdownBlockCache = new Map<string, CachedAssistantMarkdownBlocks>();
let richMarkdownBlockCacheHits = 0;
let richMarkdownBlockCacheMisses = 0;
let richMarkdownBlockCacheEvictions = 0;

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
  const blocks = assistantMarkdownBlocks({
    cellKey: props.cellKey,
    text: props.text,
    streaming: props.streaming,
    width: props.width,
    theme: props.theme,
  });
  if (blocks.length === 0) return <AssistantTextCell lines={props.fallbackLines} />;
  return (
    <box flexDirection="column">
      {blocks.map((block) => <AssistantMarkdownBlockView key={block.key} block={block} />)}
    </box>
  );
}

export function assistantTextCellLines(input: {
  key: string;
  text: string;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
}): TranscriptLineModel[] {
  return historyRenderModel.assistantTextLines({
    key: input.key,
    text: input.text,
    streaming: input.streaming,
    width: input.width,
    prefix: "🌶️: ",
    hangingIndent: "    ",
  }).map((line) => ({
    key: line.key,
    text: line.text,
    fg: markdownFg(line.tone, input.theme),
  }));
}

export function assistantMarkdownBlocks(input: {
  cellKey: string;
  text: string;
  streaming: boolean;
  width: number;
  theme: TuiTheme;
}): AssistantMarkdownBlock[] {
  if (input.streaming) {
    const renderer = new AssistantRichMarkdownRenderer(input.cellKey, input.width, input.theme);
    const { stableText, activeTail } = splitStreamingMarkdown(input.text);
    if (stableText.length > 0) renderer.renderMarkdown(stableText);
    if (activeTail.length > 0 || renderer.isEmpty()) renderer.renderActiveTail(activeTail || "...");
    return renderer.blocks;
  }

  const source = input.text || "...";
  const cacheKey = richMarkdownBlockCacheKey(input, source);
  const cached = richMarkdownBlockCache.get(cacheKey);
  if (cached) {
    if (cached.source !== source) {
      richMarkdownBlockCache.delete(cacheKey);
      richMarkdownBlockCacheMisses += 1;
    } else {
      richMarkdownBlockCache.delete(cacheKey);
      richMarkdownBlockCache.set(cacheKey, cached);
      richMarkdownBlockCacheHits += 1;
      return cached.blocks;
    }
  } else {
    richMarkdownBlockCacheMisses += 1;
  }

  const renderer = new AssistantRichMarkdownRenderer(input.cellKey, input.width, input.theme);
  renderer.renderMarkdown(source);
  richMarkdownBlockCache.set(cacheKey, { source, blocks: renderer.blocks });
  evictRichMarkdownBlockCache();
  return renderer.blocks;
}

export function assistantMarkdownBlockCacheStats(): AssistantMarkdownBlockCacheStats {
  return {
    hits: richMarkdownBlockCacheHits,
    misses: richMarkdownBlockCacheMisses,
    evictions: richMarkdownBlockCacheEvictions,
    size: richMarkdownBlockCache.size,
  };
}

export function clearAssistantMarkdownBlockCache(): void {
  richMarkdownBlockCache.clear();
  richMarkdownBlockCacheHits = 0;
  richMarkdownBlockCacheMisses = 0;
  richMarkdownBlockCacheEvictions = 0;
}

function AssistantMarkdownBlockView(props: { block: AssistantMarkdownBlock }) {
  return <TranscriptLines lines={props.block.lines} />;
}

function markdownFg(tone: MarkdownLineTone, theme: TuiTheme): string {
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "quote" || tone === "code" || tone === "muted") return theme.colors.text.muted;
  return theme.colors.text.secondary;
}

function richMarkdownBlockCacheKey(input: { cellKey: string; width: number; theme: TuiTheme }, source: string): string {
  return [
    input.cellKey,
    "streaming:false",
    String(input.width),
    input.theme.id,
    input.theme.colors.text.primary,
    input.theme.colors.text.secondary,
    input.theme.colors.text.muted,
    input.theme.colors.text.disabled,
    input.theme.colors.accent.secondary,
    input.theme.colors.status.success,
    input.theme.colors.status.error,
    input.theme.colors.status.info,
    textContentHash(source),
  ].join("\0");
}

function evictRichMarkdownBlockCache(): void {
  while (richMarkdownBlockCache.size > MAX_RICH_MARKDOWN_CACHE_ENTRIES) {
    const oldest = richMarkdownBlockCache.keys().next().value;
    if (oldest === undefined) break;
    richMarkdownBlockCache.delete(oldest);
    richMarkdownBlockCacheEvictions += 1;
  }
}

class AssistantRichMarkdownRenderer {
  readonly blocks: AssistantMarkdownBlock[] = [];
  private blockIndex = 0;
  private usedPrefix = false;

  constructor(
    private readonly cellKey: string,
    private readonly width: number,
    private readonly theme: TuiTheme,
  ) {}

  isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  renderMarkdown(source: string): void {
    let tokens: Token[];
    try {
      tokens = Lexer.lex(source || "...");
    } catch {
      this.emitWrappedBlock("fallback", source || "...", this.theme.colors.text.secondary, "    ");
      return;
    }
    for (const token of tokens) this.renderToken(token);
  }

  renderActiveTail(tail: string): void {
    const fence = parseOpeningFence(tail);
    if (fence) {
      this.renderFenceTail(fence);
      return;
    }
    this.emitWrappedBlock("paragraph", tail || "...", this.theme.colors.text.secondary, "    ");
  }

  private renderToken(token: Token): void {
    if (token.type === "space" || token.type === "def") return;
    if (token.type === "heading") {
      this.emitWrappedBlock("heading", `${"#".repeat(Math.min(token.depth, 3))} ${inlineText(token.tokens, token.text)}`, this.theme.colors.text.primary, "    ");
      return;
    }
    if (token.type === "paragraph") {
      this.emitWrappedBlock("paragraph", inlineText(token.tokens, token.text), this.theme.colors.text.secondary, "    ");
      return;
    }
    if (token.type === "blockquote") {
      this.renderBlockquote(token as Tokens.Blockquote);
      return;
    }
    if (token.type === "list") {
      this.renderList(token as Tokens.List);
      return;
    }
    if (token.type === "code") {
      this.renderCode(token as Tokens.Code, true);
      return;
    }
    if (token.type === "table") {
      this.renderTable(token as Tokens.Table);
      return;
    }
    if (token.type === "hr") {
      this.emitWrappedBlock("hr", "-----", this.theme.colors.text.disabled, "    ");
      return;
    }
    if (token.type === "html") {
      this.emitWrappedBlock("paragraph", stripHtml(token.text || token.raw), this.theme.colors.text.muted, "    ");
      return;
    }
    this.emitWrappedBlock("fallback", token.raw ?? "", this.theme.colors.text.secondary, "    ");
  }

  private renderBlockquote(token: Tokens.Blockquote): void {
    const quoteLines = token.tokens.length > 0
      ? token.tokens.flatMap((item) => blockPlainLines(item))
      : token.text.split("\n");
    const lines = quoteLines.flatMap((line, index) => this.wrapText(`> ${line}`, {
      key: `${this.nextBlockKey("blockquote")}:line:${index}`,
      fg: this.theme.colors.text.muted,
      hangingIndent: "> ",
    }));
    this.pushBlock("blockquote", lines);
  }

  private renderList(token: Tokens.List): void {
    const start = typeof token.start === "number" ? token.start : 1;
    const blockKey = this.nextBlockKey("list");
    const lines = token.items.flatMap((item, index) => {
      const marker = token.ordered ? `${start + index}. ` : "- ";
      const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
      const text = inlineText(item.tokens, item.text).replace(/\s+/g, " ").trim();
      return this.wrapText(`${marker}${checkbox}${text || " "}`, {
        key: `${blockKey}:item:${index}`,
        fg: this.theme.colors.text.secondary,
        hangingIndent: "  ",
      });
    });
    this.pushBlock("list", lines);
  }

  private renderCode(token: Tokens.Code, includeClosingFence: boolean): void {
    const lang = (token.lang ?? "").trim();
    const kind = isDiffBlock(lang, token.text) ? "diff" : "code";
    const blockKey = this.nextBlockKey(kind);
    const fence = lang ? `\`\`\`${lang}` : "```";
    const lines: TranscriptLineModel[] = [
      ...this.wrapText(fence, {
        key: `${blockKey}:fence-open`,
        fg: this.theme.colors.text.disabled,
        hangingIndent: "    ",
      }),
    ];
    for (const [index, line] of token.text.split("\n").entries()) {
      lines.push(...this.wrapText(`  ${line || " "}`, {
        key: `${blockKey}:line:${index}`,
        fg: kind === "diff" ? diffLineFg(line, this.theme) : this.theme.colors.accent.secondary,
        hangingIndent: "    ",
      }));
    }
    if (includeClosingFence) {
      lines.push(...this.wrapText("```", {
        key: `${blockKey}:fence-close`,
        fg: this.theme.colors.text.disabled,
        hangingIndent: "    ",
      }));
    }
    this.pushBlock(kind, lines);
  }

  private renderFenceTail(fence: OpeningFence): void {
    const kind = isDiffBlock(fence.lang, fence.body.join("\n")) ? "diff" : "code";
    const blockKey = this.nextBlockKey(kind);
    const label = fence.lang ? `${fence.marker}${fence.lang}` : fence.marker;
    const lines: TranscriptLineModel[] = [
      ...this.wrapText(label, {
        key: `${blockKey}:fence-open`,
        fg: this.theme.colors.text.disabled,
        hangingIndent: "    ",
      }),
    ];
    for (const [index, line] of fence.body.entries()) {
      lines.push(...this.wrapText(`  ${line || " "}`, {
        key: `${blockKey}:line:${index}`,
        fg: kind === "diff" ? diffLineFg(line, this.theme) : this.theme.colors.accent.secondary,
        hangingIndent: "    ",
      }));
    }
    this.pushBlock(kind, lines);
  }

  private renderTable(token: Tokens.Table): void {
    const blockKey = this.nextBlockKey("table");
    const lines = markdownTableToTerminalLines(token, {
      key: blockKey,
      width: this.width,
      ...(this.usedPrefix ? {} : { prefix: "🌶️: " }),
      hangingIndent: "    ",
    }).map((line) => ({
      key: line.key,
      text: line.text,
      fg: markdownFg(line.tone, this.theme),
    }));
    if (lines.length > 0) this.usedPrefix = true;
    this.pushBlock("table", lines);
  }

  private emitWrappedBlock(kind: AssistantMarkdownBlockKind, text: string, fg: string, hangingIndent: string): void {
    const key = this.nextBlockKey(kind);
    this.pushBlock(kind, this.wrapText(text || " ", { key, fg, hangingIndent }));
  }

  private wrapText(text: string, input: { key: string; fg: string; hangingIndent: string }): TranscriptLineModel[] {
    const prefix = this.usedPrefix ? undefined : "🌶️: ";
    this.usedPrefix = true;
    return wrapTerminalText(text, {
      key: input.key,
      width: this.width,
      ...(prefix === undefined ? {} : { prefix }),
      hangingIndent: input.hangingIndent,
    }).map((line) => ({
      key: line.key,
      text: line.text,
      fg: input.fg,
    }));
  }

  private nextBlockKey(kind: AssistantMarkdownBlockKind): string {
    const key = `${this.cellKey}:rich:${this.blockIndex}:${kind}`;
    this.blockIndex += 1;
    return key;
  }

  private pushBlock(kind: AssistantMarkdownBlockKind, lines: TranscriptLineModel[]): void {
    if (lines.length === 0) return;
    this.blocks.push({
      key: `${this.cellKey}:rich-block:${this.blocks.length}:${kind}`,
      kind,
      lines,
    });
  }
}

interface OpeningFence {
  marker: string;
  lang: string;
  body: string[];
}

function parseOpeningFence(text: string): OpeningFence | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)?$/);
  if (!opening?.[1]) return undefined;
  return {
    marker: opening[1],
    lang: opening[2]?.trim() ?? "",
    body: lines.slice(1),
  };
}

function inlineText(tokens: readonly Token[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) return fallback;
  return tokens.map((token) => inlineTokenText(token)).join("").replace(/[ \t]+\n/g, "\n").trim();
}

function inlineTokenText(token: Token): string {
  if (token.type === "text" || token.type === "escape") return token.text;
  if (token.type === "codespan") return `\`${token.text}\``;
  if (token.type === "br") return "\n";
  if (token.type === "strong" || token.type === "em" || token.type === "del") return inlineText(token.tokens, token.text);
  if (token.type === "link") {
    const label = inlineText(token.tokens, token.text);
    return token.href && token.href !== label ? `${label} (${token.href})` : label;
  }
  if (token.type === "image") return token.text ? `[image: ${token.text}]` : "[image]";
  if (token.type === "html") return stripHtml(token.text || token.raw);
  if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens, token.raw ?? "");
  if ("text" in token && typeof token.text === "string") return token.text;
  return token.raw ?? "";
}

function blockPlainLines(token: Token): string[] {
  if (token.type === "paragraph" || token.type === "heading") return [inlineText(token.tokens, token.text)];
  if (token.type === "code") return token.text.split("\n");
  if (token.type === "list") {
    const list = token as Tokens.List;
    return list.items.map((item: Tokens.ListItem, index: number) => {
      const marker = list.ordered ? `${(typeof list.start === "number" ? list.start : 1) + index}. ` : "- ";
      return `${marker}${inlineText(item.tokens, item.text).replace(/\s+/g, " ").trim()}`;
    });
  }
  if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens.flatMap((item) => blockPlainLines(item));
  if ("text" in token && typeof token.text === "string") return token.text.split("\n");
  return [token.raw ?? ""];
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function isDiffBlock(lang: string, text: string): boolean {
  const normalized = lang.toLowerCase();
  return normalized === "diff"
    || normalized === "patch"
    || normalized.includes("diff")
    || /^diff --git /m.test(text);
}

function diffLineFg(line: string, theme: TuiTheme): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.colors.status.success;
  if (line.startsWith("-") && !line.startsWith("---")) return theme.colors.status.error;
  if (line.startsWith("@@")) return theme.colors.status.info;
  return theme.colors.text.muted;
}
