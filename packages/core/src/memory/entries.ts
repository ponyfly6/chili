import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CHILI_MEMORY_SECTION_HEADER, DEFAULT_MAX_MEMORY_ENTRY_CHARS } from "./constants.js";
import { memoryPathForScope, resolveChiliMemoryPaths } from "./project-instructions.js";
import type {
  ChiliMemoryAddInput,
  ChiliMemoryAddResult,
  ChiliMemoryEntry,
  ChiliMemoryListInput,
  ChiliMemoryRemoveInput,
  ChiliMemoryRemoveResult,
} from "./types.js";
import { readTextIfExists } from "./utils.js";

export async function addChiliMemoryEntry(input: ChiliMemoryAddInput): Promise<ChiliMemoryAddResult> {
  const paths = await resolveChiliMemoryPaths(input);
  const scope = input.scope ?? "project";
  const path = memoryPathForScope(paths, scope);
  const current = await readTextIfExists(path);
  const text = sanitizeMemoryEntry(input.text, input.maxEntryChars);
  const next = appendMemoryContent(current ?? "", text);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");

  return {
    scope,
    path,
    text,
    created: current === undefined,
  };
}

export async function listChiliMemoryEntries(input: ChiliMemoryListInput): Promise<ChiliMemoryEntry[]> {
  const paths = await resolveChiliMemoryPaths(input);
  const scopes = input.scope === "all" || input.scope === undefined ? (["user", "project"] as const) : [input.scope];
  const entries: ChiliMemoryEntry[] = [];

  for (const scope of scopes) {
    const path = memoryPathForScope(paths, scope);
    const current = await readTextIfExists(path);
    if (!current) continue;
    for (const entry of parseMemoryEntries(current)) {
      entries.push({
        scope,
        path,
        index: entry.index,
        text: entry.text,
      });
    }
  }

  return entries;
}

export async function removeChiliMemoryEntry(input: ChiliMemoryRemoveInput): Promise<ChiliMemoryRemoveResult> {
  if (!Number.isInteger(input.index) || input.index <= 0) {
    throw new Error("Memory index must be a positive integer");
  }

  const paths = await resolveChiliMemoryPaths(input);
  const scope = input.scope ?? "project";
  const path = memoryPathForScope(paths, scope);
  const current = await readTextIfExists(path);
  if (current === undefined) {
    throw new Error(`No ${scope} memory file exists: ${path}`);
  }

  const removed = removeMemoryLine(current, input.index);
  await writeFile(path, removed.content, "utf8");

  return {
    scope,
    path,
    index: input.index,
    text: removed.text,
  };
}

export function sanitizeMemoryEntry(input: string, maxChars = DEFAULT_MAX_MEMORY_ENTRY_CHARS): string {
  const marker = " [truncated]";
  let text = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > maxChars) {
    const sliceLength = Math.max(0, maxChars - marker.length);
    text = `${text.slice(0, sliceLength).trimEnd()}${marker}`;
  }

  if (!text) {
    throw new Error("Memory text is empty after sanitization");
  }

  return text;
}

export function appendMemoryContent(currentContent: string, sanitizedText: string): string {
  const newMemoryItem = `- ${sanitizedText}`;
  if (currentContent.trim().length === 0) {
    return `# Chili Memory\n\n${CHILI_MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`;
  }

  const lines = contentLines(currentContent);
  const section = findManagedMemorySection(lines);
  if (!section) {
    return `${currentContent}${newlineSeparation(currentContent)}${CHILI_MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`;
  }

  const before = lines.slice(0, section.endLineExclusive).join("\n").trimEnd();
  const after = lines.slice(section.endLineExclusive).join("\n").trimStart();
  return `${before}\n${newMemoryItem}${after ? `\n${after}` : ""}\n`;
}

export function formatMemoryEntries(entries: readonly ChiliMemoryEntry[]): string {
  if (entries.length === 0) return "No saved Chili memory entries.";
  return entries.map((entry) => `[${entry.scope} #${entry.index}] ${entry.text}\n${entry.path}`).join("\n\n");
}

function parseMemoryEntries(content: string): ChiliMemoryEntryLine[] {
  const lines = contentLines(content);
  const section = findManagedMemorySection(lines);
  if (!section) return [];

  const entries: ChiliMemoryEntryLine[] = [];
  for (let lineIndex = section.startLine + 1; lineIndex < section.endLineExclusive; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    entries.push({
      lineIndex,
      index: entries.length + 1,
      text: match[1],
    });
  }
  return entries;
}

function removeMemoryLine(content: string, index: number): { content: string; text: string } {
  const lines = contentLines(content);
  const entries = parseMemoryEntries(content);
  const target = entries.find((entry) => entry.index === index);
  if (!target) throw new Error(`Memory entry not found: #${index}`);

  lines.splice(target.lineIndex, 1);
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return {
    content: `${next.replace(/\n*$/, "")}\n`,
    text: target.text,
  };
}

function contentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.endsWith("\n")) return normalized.slice(0, -1).split("\n");
  return normalized.split("\n");
}

function findManagedMemorySection(lines: readonly string[]): { startLine: number; endLineExclusive: number } | undefined {
  const startLine = lines.findIndex((line) => line.trim() === CHILI_MEMORY_SECTION_HEADER);
  if (startLine < 0) return undefined;

  let endLineExclusive = lines.length;
  for (let index = startLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line && /^##\s+/.test(line.trimStart())) {
      endLineExclusive = index;
      break;
    }
  }

  return { startLine, endLineExclusive };
}

interface ChiliMemoryEntryLine {
  lineIndex: number;
  index: number;
  text: string;
}

function newlineSeparation(content: string): string {
  if (content.length === 0) return "";
  if (content.endsWith("\n\n") || content.endsWith("\r\n\r\n")) return "";
  if (content.endsWith("\n") || content.endsWith("\r\n")) return "\n";
  return "\n\n";
}
