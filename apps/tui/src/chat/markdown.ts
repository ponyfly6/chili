import { Lexer, type Token, type Tokens } from "marked";

export type MarkdownLineTone =
  | "text"
  | "heading"
  | "quote"
  | "code"
  | "muted";

export interface MarkdownTerminalLine {
  key: string;
  text: string;
  tone: MarkdownLineTone;
}

export interface MarkdownRenderOptions {
  key: string;
  width: number;
  prefix?: string;
  hangingIndent?: string;
}

const MAX_CACHE_ENTRIES = 80;
const markdownLineCache = new Map<string, { source: string; lines: MarkdownTerminalLine[] }>();

export function markdownToTerminalLines(text: string, options: MarkdownRenderOptions): MarkdownTerminalLine[] {
  const source = text.length > 0 ? text : "...";
  const cacheKey = markdownCacheKey(source, options);
  const cached = markdownLineCache.get(cacheKey);
  if (cached?.source === source) {
    markdownLineCache.delete(cacheKey);
    markdownLineCache.set(cacheKey, cached);
    return cached.lines;
  }
  if (cached) markdownLineCache.delete(cacheKey);

  let tokens: Token[];
  try {
    tokens = Lexer.lex(source);
  } catch {
    const fallback = wrapTerminalText(source, {
      key: options.key,
      width: options.width,
      tone: "text",
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
    });
    remember(cacheKey, source, fallback);
    return fallback;
  }

  const renderer = new MarkdownLineRenderer(options);
  renderer.render(tokens);
  const lines = renderer.lines.length > 0
    ? renderer.lines
    : wrapTerminalText(source, {
      key: options.key,
      width: options.width,
      tone: "text",
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
    });
  remember(cacheKey, source, lines);
  return lines;
}

export function textContentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (code >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (code >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

export function wrapTerminalText(text: string, options: {
  key: string;
  width: number;
  tone?: MarkdownLineTone;
  prefix?: string;
  hangingIndent?: string;
}): MarkdownTerminalLine[] {
  const lines: MarkdownTerminalLine[] = [];
  const paragraphs = text.split("\n");
  const width = Math.max(8, options.width);
  const tone = options.tone ?? "text";

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const prefix = paragraphIndex === 0 ? options.prefix ?? "" : "";
    const source = `${prefix}${paragraph.length > 0 ? paragraph : " "}`;
    let current = "";
    let currentWidth = 0;
    let lineIndex = 0;
    const push = () => {
      const linePrefix = lineIndex === 0 ? "" : options.hangingIndent ?? "";
      lines.push({
        key: `${options.key}:${paragraphIndex}:${lineIndex}`,
        text: `${linePrefix}${current || " "}`,
        tone,
      });
      current = "";
      currentWidth = 0;
      lineIndex += 1;
    };

    for (const char of source) {
      const nextWidth = charDisplayWidth(char);
      if (current && currentWidth + nextWidth > width) push();
      current += char;
      currentWidth += nextWidth;
    }
    push();
  }

  return lines;
}

export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}

class MarkdownLineRenderer {
  readonly lines: MarkdownTerminalLine[] = [];
  private usedPrefix = false;
  private blockIndex = 0;

  constructor(private readonly options: MarkdownRenderOptions) {}

  render(tokens: readonly Token[]): void {
    for (const token of tokens) this.renderToken(token);
  }

  private renderToken(token: Token): void {
    if (token.type === "space" || token.type === "def") return;
    if (token.type === "heading") {
      this.emit(`${"#".repeat(Math.min(token.depth, 3))} ${inlineText(token.tokens, token.text)}`, "heading");
      return;
    }
    if (token.type === "paragraph") {
      this.emit(inlineText(token.tokens, token.text), "text");
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
      this.renderCode(token as Tokens.Code);
      return;
    }
    if (token.type === "table") {
      this.renderTable(token as Tokens.Table);
      return;
    }
    if (token.type === "hr") {
      this.emit("-----", "muted");
      return;
    }
    if (token.type === "html") {
      this.emit(stripHtml(token.text || token.raw), "muted");
      return;
    }
    this.emit(token.raw ?? "", "text");
  }

  private renderBlockquote(token: Tokens.Blockquote): void {
    const quoteLines = token.tokens.length > 0
      ? token.tokens.flatMap((item) => blockPlainLines(item))
      : token.text.split("\n");
    for (const line of quoteLines) this.emit(`> ${line}`, "quote", "> ");
  }

  private renderList(token: Tokens.List): void {
    const start = typeof token.start === "number" ? token.start : 1;
    for (const [index, item] of token.items.entries()) {
      const marker = token.ordered ? `${start + index}. ` : "- ";
      const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
      const text = inlineText(item.tokens, item.text).replace(/\s+/g, " ").trim();
      this.emit(`${marker}${checkbox}${text || " "}`, "text", "  ");
    }
  }

  private renderCode(token: Tokens.Code): void {
    const fence = token.lang ? `\`\`\`${token.lang}` : "```";
    this.emit(fence, "code", "    ");
    for (const line of token.text.split("\n")) {
      this.emit(line.length > 0 ? `  ${line}` : "  ", "code", "    ");
    }
    this.emit("```", "code", "    ");
  }

  private renderTable(token: Tokens.Table): void {
    const header = token.header.map((cell) => inlineText(cell.tokens, cell.text));
    this.emit(tableRow(header), "text");
    this.emit(tableRow(header.map((cell) => "-".repeat(Math.max(3, Math.min(12, cell.length))))), "muted");
    for (const row of token.rows) {
      this.emit(tableRow(row.map((cell) => inlineText(cell.tokens, cell.text))), "text");
    }
  }

  private emit(text: string, tone: MarkdownLineTone, hangingIndent = this.options.hangingIndent ?? ""): void {
    const prefix = this.usedPrefix ? "" : this.options.prefix ?? "";
    const key = `${this.options.key}:md:${this.blockIndex}`;
    this.blockIndex += 1;
    this.lines.push(...wrapTerminalText(text, {
      key,
      width: this.options.width,
      tone,
      prefix,
      ...(hangingIndent === undefined ? {} : { hangingIndent }),
    }));
    this.usedPrefix = true;
  }
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

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\s+/g, " ").trim()).join(" | ")} |`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function markdownCacheKey(source: string, options: MarkdownRenderOptions): string {
  return [
    options.key,
    String(options.width),
    options.prefix ?? "",
    options.hangingIndent ?? "",
    textContentHash(source),
  ].join("\0");
}

function remember(cacheKey: string, source: string, lines: MarkdownTerminalLine[]): void {
  markdownLineCache.set(cacheKey, { source, lines });
  while (markdownLineCache.size > MAX_CACHE_ENTRIES) {
    const oldest = markdownLineCache.keys().next().value;
    if (oldest === undefined) break;
    markdownLineCache.delete(oldest);
  }
}
