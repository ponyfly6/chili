export interface StreamingMarkdownSplit {
  stableText: string;
  activeTail: string;
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  if (text.length === 0) return { stableText: "", activeTail: "" };
  const fenceStart = unfinishedFenceStart(text);
  if (fenceStart !== undefined) {
    return {
      stableText: text.slice(0, fenceStart),
      activeTail: text.slice(fenceStart),
    };
  }
  if (text.endsWith("\n")) return { stableText: text, activeTail: "" };

  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { stableText: "", activeTail: text };

  return {
    stableText: text.slice(0, lastNewline + 1),
    activeTail: text.slice(lastNewline + 1),
  };
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
