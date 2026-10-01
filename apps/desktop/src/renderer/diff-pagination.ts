/** Keep raw mode bounded without discarding or modifying any source text. */
export function splitRawDiff(text: string, maxChars = 64 * 1024): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new RangeError("Raw diff page size must be at least 2");
  if (!text) return [""];
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const newline = text.slice(start, end).lastIndexOf("\n");
      if (newline >= 0) end = start + newline + 1;
      // A single very long line still needs a bound. Preserve Unicode pairs.
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages;
}
