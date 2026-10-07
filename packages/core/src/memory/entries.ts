import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_MAX_MEMORY_ENTRY_CHARS } from "./constants.js";
import { readMemoryMarkdownFiles, writeNewMemoryMarkdown } from "./files.js";
import { resolveChiliMemoryDirectories } from "./paths.js";
import type { ChiliMemoryAddInput, ChiliMemoryAddResult, ChiliMemoryEntry, ChiliMemoryListInput } from "./types.js";

/** CLI convenience: create one ordinary Markdown file, never an indexed record. */
export async function addChiliMemoryEntry(input: ChiliMemoryAddInput): Promise<ChiliMemoryAddResult> {
  validateMemoryText(input.text, input.maxEntryChars);
  const scope = input.scope ?? "project";
  const directories = await resolveChiliMemoryDirectories(input);
  const directory = scope === "user" ? directories.personal : directories.project;
  const path = join(directory, `${randomUUID()}.md`);
  writeNewMemoryMarkdown(directories.root, path, input.text);
  return { scope, path, text: input.text };
}

/** Explicit file inspection; no cached index, implicit import, or database access. */
export async function listChiliMemoryEntries(input: ChiliMemoryListInput): Promise<ChiliMemoryEntry[]> {
  const directories = await resolveChiliMemoryDirectories(input);
  const scopes = input.scope === undefined || input.scope === "all" ? ["user", "project"] as const : [input.scope];
  return scopes.flatMap((scope) => readMemoryMarkdownFiles(directories.root, scope === "user" ? directories.personal : directories.project)
      .map((file) => ({ scope, ...file })));
}

function validateMemoryText(text: string, maxChars = DEFAULT_MAX_MEMORY_ENTRY_CHARS): void {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Memory text limit must be a positive integer");
  if (!text.trim()) throw new Error("Memory text must not be empty");
  if (text.length > maxChars) throw new Error(`Memory text exceeds ${maxChars} UTF-16 characters; no file was created.`);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index++; continue; }
      throw new Error("Memory text contains an unpaired Unicode surrogate; no file was created");
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Memory text contains an unpaired Unicode surrogate; no file was created");
  }
}
