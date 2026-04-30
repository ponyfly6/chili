import { Lexer, type Token } from "marked";

export interface StreamingMarkdownSplit {
  stableText: string;
  activeTail: string;
}

const BLOCK_MARKDOWN_SYNTAX_RE = /(^|\n)[ \t]{0,3}(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|>[ \t]?|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|\|.*\|)/m;
const INLINE_MARKDOWN_SYNTAX_RE = /(`[^`\n]+`|!?\[[^\]\n]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/;

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  if (text.length === 0) return { stableText: "", activeTail: "" };
  const fenceStart = unfinishedFenceStart(text);
  if (fenceStart !== undefined) {
    return {
      stableText: text.slice(0, fenceStart),
      activeTail: text.slice(fenceStart),
    };
  }

  if (!mightHaveMarkdownSyntax(text)) return splitAtLastNewline(text);

  const markdownSplit = splitAtMarkdownBoundary(text);
  if (markdownSplit) return markdownSplit;

  return splitAtLastNewline(text);
}

function mightHaveMarkdownSyntax(text: string): boolean {
  return BLOCK_MARKDOWN_SYNTAX_RE.test(text) || INLINE_MARKDOWN_SYNTAX_RE.test(text);
}

function splitAtMarkdownBoundary(text: string): StreamingMarkdownSplit | undefined {
  let tokens: Token[];
  try {
    tokens = Lexer.lex(text);
  } catch {
    return undefined;
  }

  let offset = 0;
  let hasMarkdownSyntax = false;
  let lastMeaningful: { token: Token; start: number } | undefined;

  for (const token of tokens) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === "space") continue;
    if (token.type === "def") {
      hasMarkdownSyntax = true;
      continue;
    }

    lastMeaningful = { token, start };
    if (tokenHasMarkdownSyntax(token)) hasMarkdownSyntax = true;
  }

  if (!hasMarkdownSyntax || !lastMeaningful) return undefined;
  if (isSafeBlockBoundary(text, lastMeaningful.token)) return { stableText: text, activeTail: "" };

  return {
    stableText: text.slice(0, lastMeaningful.start),
    activeTail: text.slice(lastMeaningful.start),
  };
}

function splitAtLastNewline(text: string): StreamingMarkdownSplit {
  if (text.endsWith("\n")) return { stableText: text, activeTail: "" };

  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { stableText: "", activeTail: text };

  return {
    stableText: text.slice(0, lastNewline + 1),
    activeTail: text.slice(lastNewline + 1),
  };
}

function tokenHasMarkdownSyntax(token: Token): boolean {
  if (token.type !== "paragraph") return true;
  return token.tokens?.some((inlineToken) => inlineToken.type !== "text") === true;
}

function isSafeBlockBoundary(text: string, token: Token): boolean {
  if (hasTrailingBlankLine(text)) return true;
  if (!hasTrailingLineEnd(text)) return false;
  if (token.type === "heading" || token.type === "hr") return true;
  if (token.type !== "code") return false;
  return (token as { codeBlockStyle?: string }).codeBlockStyle !== "indented";
}

function hasTrailingLineEnd(text: string): boolean {
  return /\r?\n[ \t]*$/.test(text);
}

function hasTrailingBlankLine(text: string): boolean {
  return /\r?\n[ \t]*\r?\n[ \t]*$/.test(text);
}

function unfinishedFenceStart(text: string): number | undefined {
  let open: { char: "`" | "~"; length: number; start: number } | undefined;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (!open && fence?.[1]) {
      const marker = fence[1];
      open = { char: marker[0] as "`" | "~", length: marker.length, start: lineStart };
    } else if (open) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      const marker = closing?.[1];
      if (marker && marker[0] === open.char && marker.length >= open.length) open = undefined;
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  return open?.start;
}
