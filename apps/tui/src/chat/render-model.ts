import {
  markdownToTerminalLines,
  textContentHash,
  wrapTerminalText,
  type MarkdownRenderOptions,
  type MarkdownTerminalLine,
} from "./markdown.js";
import { splitStreamingMarkdown } from "./streaming.js";

export interface AssistantTextRenderOptions {
  key: string;
  text: string;
  streaming?: boolean;
  width: number;
  prefix: string;
  hangingIndent: string;
}

export interface HistoryRenderModelStats {
  markdownCacheHits: number;
  markdownCacheMisses: number;
  markdownCacheEvictions: number;
  markdownCacheSize: number;
}

export interface HistoryRenderModelOptions {
  maxMarkdownEntries?: number;
  markdownRenderer?: (text: string, options: MarkdownRenderOptions) => MarkdownTerminalLine[];
}

interface CachedMarkdownLines {
  source: string;
  lines: MarkdownTerminalLine[];
}

const DEFAULT_MAX_MARKDOWN_ENTRIES = 160;

export class HistoryRenderModel {
  private readonly maxMarkdownEntries: number;
  private readonly markdownRenderer: (text: string, options: MarkdownRenderOptions) => MarkdownTerminalLine[];
  private readonly markdownLineCache = new Map<string, CachedMarkdownLines>();
  private markdownCacheHits = 0;
  private markdownCacheMisses = 0;
  private markdownCacheEvictions = 0;

  constructor(options: HistoryRenderModelOptions = {}) {
    this.maxMarkdownEntries = Math.max(1, Math.floor(options.maxMarkdownEntries ?? DEFAULT_MAX_MARKDOWN_ENTRIES));
    this.markdownRenderer = options.markdownRenderer ?? markdownToTerminalLines;
  }

  assistantTextLines(options: AssistantTextRenderOptions): MarkdownTerminalLine[] {
    if (options.streaming === true) return this.streamingAssistantTextLines(options);
    return this.cachedMarkdownLines(options.text || "...", {
      key: options.key,
      width: options.width,
      prefix: options.prefix,
      hangingIndent: options.hangingIndent,
    });
  }

  cacheStats(): HistoryRenderModelStats {
    return {
      markdownCacheHits: this.markdownCacheHits,
      markdownCacheMisses: this.markdownCacheMisses,
      markdownCacheEvictions: this.markdownCacheEvictions,
      markdownCacheSize: this.markdownLineCache.size,
    };
  }

  clear(): void {
    this.markdownLineCache.clear();
    this.markdownCacheHits = 0;
    this.markdownCacheMisses = 0;
    this.markdownCacheEvictions = 0;
  }

  private streamingAssistantTextLines(options: AssistantTextRenderOptions): MarkdownTerminalLine[] {
    const { stableText, activeTail } = splitStreamingMarkdown(options.text);
    const lines = stableText.length > 0
      ? [...this.cachedMarkdownLines(stableText, {
        key: `${options.key}:stable`,
        width: options.width,
        prefix: options.prefix,
        hangingIndent: options.hangingIndent,
      })]
      : [];

    const tail = activeTail || (lines.length === 0 ? "..." : "");
    if (!tail) return lines;

    const prefix = lines.length === 0 ? options.prefix : options.hangingIndent;
    lines.push(...wrapTerminalText(`${prefix}${tail}`, {
      key: `${options.key}:active-tail`,
      width: options.width,
      tone: "text",
      hangingIndent: options.hangingIndent,
    }));
    return lines;
  }

  private cachedMarkdownLines(source: string, options: MarkdownRenderOptions): MarkdownTerminalLine[] {
    const cacheKey = this.markdownCacheKey(source, options);
    const cached = this.markdownLineCache.get(cacheKey);
    if (cached?.source === source) {
      this.markdownLineCache.delete(cacheKey);
      this.markdownLineCache.set(cacheKey, cached);
      this.markdownCacheHits += 1;
      return cached.lines;
    }
    if (cached) this.markdownLineCache.delete(cacheKey);

    this.markdownCacheMisses += 1;
    const lines = this.markdownRenderer(source, options);
    this.markdownLineCache.set(cacheKey, { source, lines });
    this.evictOverflow();
    return lines;
  }

  private markdownCacheKey(source: string, options: MarkdownRenderOptions): string {
    return [
      options.key,
      String(options.width),
      options.prefix ?? "",
      options.hangingIndent ?? "",
      textContentHash(source),
    ].join("\0");
  }

  private evictOverflow(): void {
    while (this.markdownLineCache.size > this.maxMarkdownEntries) {
      const oldest = this.markdownLineCache.keys().next().value;
      if (oldest === undefined) break;
      this.markdownLineCache.delete(oldest);
      this.markdownCacheEvictions += 1;
    }
  }
}

export const historyRenderModel = new HistoryRenderModel();
