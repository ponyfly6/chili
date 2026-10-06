import type { ChiliToolDefinition } from "./types.js";

const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "to", "for", "of", "with", "tool", "tools"]);

function tokens(text: string): string[] {
  const words = text.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.flatMap((word) => {
    // Preserve full CJK terms and overlapping pairs without an English-only tokenizer.
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      return [word, ...chars.slice(1).map((char, index) => chars[index]! + char)];
    }
    if (STOP_WORDS.has(word)) return [];
    return [word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y`
      : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word];
  });
}

/** Deterministic lexical ranking; exact names/aliases always precede capability matches. */
export function searchTools(
  tools: readonly ChiliToolDefinition[], query: string, limit: number,
): ChiliToolDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.startsWith("select:")) {
    const names = normalized.slice(7).split(",").map((name) => name.trim()).filter(Boolean);
    return [...new Set(names.flatMap((name) => {
      const tool = tools.find((candidate) => candidate.name.toLowerCase() === name
        || candidate.aliases?.some((alias) => alias.toLowerCase() === name));
      return tool ? [tool] : [];
    }))].slice(0, limit);
  }
  const terms = [...new Set(tokens(query))];
  const identifier = /^[\p{L}\p{N}]+(?:[_:.]+[\p{L}\p{N}]+)+$/u.test(normalized);
  const documents = tools.filter((tool) => tool.name !== "tool_search")
    .filter((tool) => !identifier || [tool.name, ...(tool.aliases ?? []), tool.description, tool.searchHint ?? ""]
      .some((text) => text.toLowerCase().includes(normalized)))
    .map((tool) => {
      const counts = new Map<string, number>();
      const words = tokens([tool.name, ...(tool.aliases ?? []), tool.description, tool.searchHint ?? ""].join(" "));
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      return { tool, counts, length: words.length };
    });
  const average = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const inverseFrequency = new Map(terms.map((term) => {
    const frequency = documents.filter((document) => document.counts.has(term)).length;
    return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  return documents.map(({ tool, counts, length }) => {
    const exact = tool.name.toLowerCase() === normalized || tool.aliases?.some((alias) => alias.toLowerCase() === normalized);
    let score = 0;
    for (const term of terms) {
      const count = counts.get(term) ?? 0;
      score += (inverseFrequency.get(term) ?? 0) * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * length / average));
    }
    return { tool, exact: Boolean(exact), score };
  }).filter((entry) => entry.exact || entry.score > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit).map((entry) => entry.tool);
}
