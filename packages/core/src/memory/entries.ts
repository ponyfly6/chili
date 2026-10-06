import { SqliteMemoryRepository, type MemoryRecord, type MemoryScope } from "@chili/store";
import { CHILI_MEMORY_SECTION_HEADER, DEFAULT_MAX_MEMORY_ENTRY_CHARS } from "./constants.js";
import { memoryPathForScope, resolveChiliMemoryPaths } from "./project-instructions.js";
import type {
  ChiliMemoryLoadOptions,
  ChiliMemoryPaths,
  ChiliMemoryScope,
  ChiliMemoryAddInput,
  ChiliMemoryAddResult,
  ChiliMemoryEntry,
  ChiliMemoryListInput,
  ChiliMemoryRemoveInput,
  ChiliMemoryRemoveResult,
} from "./types.js";
import { readTextIfExists } from "./utils.js";

/** Opens only the selected profile; migration and every mutation use SQLite transactions. */
async function withMemoryRepository<T>(
  options: ChiliMemoryLoadOptions,
  action: (repository: SqliteMemoryRepository, paths: ChiliMemoryPaths) => T,
  scopes: readonly ChiliMemoryScope[] = options.memoryScopes ?? ["user", "project"],
): Promise<T> {
  const paths = await resolveChiliMemoryPaths(options, false);
  await options.assertCurrentAuthorization?.();
  const repository = new SqliteMemoryRepository(paths.databasePath);
  try {
    for (const scope of scopes) {
      const address = memoryScope(paths, scope);
      if (repository.hasLegacyImport(address)) continue;
      const path = memoryPathForScope(paths, scope);
      const content = await readTextIfExists(path);
      const entries = legacyMemoryEntries(content);
      await options.assertCurrentAuthorization?.();
      repository.importLegacy(address, path, content, entries);
    }
    await options.assertCurrentAuthorization?.();
    return action(repository, paths);
  } finally {
    repository.close();
  }
}

function memoryScope(paths: ChiliMemoryPaths, scope: ChiliMemoryScope): MemoryScope {
  return { kind: scope, id: scope === "user" ? "profile" : paths.projectId };
}

export async function addChiliMemoryEntry(input: ChiliMemoryAddInput): Promise<ChiliMemoryAddResult> {
  const scope = input.scope ?? "project";
  const text = sanitizeMemoryEntry(input.text, input.maxEntryChars);
  return withMemoryRepository(input, (repository, paths) => {
    const entry = repository.put({ scope: memoryScope(paths, scope), text, source: input.source ?? "memory-api" });
    return { id: entry.id, revision: entry.revision, scope, path: paths.databasePath, text, created: true };
  }, [scope]);
}

function selectedScopes(input: ChiliMemoryListInput): ChiliMemoryScope[] {
  const requested = input.scope === "all" || input.scope === undefined ? (["user", "project"] as const) : [input.scope];
  return requested.filter((scope) => input.memoryScopes === undefined || input.memoryScopes.includes(scope));
}

export async function listChiliMemoryEntries(input: ChiliMemoryListInput): Promise<ChiliMemoryEntry[]> {
  const scopes = selectedScopes(input);
  if (scopes.length === 0) return [];
  return withMemoryRepository(input, (repository, paths) =>
    scopes.flatMap((scope) => repository.list(memoryScope(paths, scope)).map((entry) => memoryEntry(entry, paths))), scopes);
}

export async function searchChiliMemoryEntries(input: ChiliMemoryListInput): Promise<ChiliMemoryEntry[]> {
  const scopes = selectedScopes(input);
  if (scopes.length === 0) return [];
  return withMemoryRepository(input, (repository, paths) =>
    scopes.flatMap((scope) => repository.search(memoryScope(paths, scope), input.query, input.maxMemoryEntries ?? 24)
      .map((entry) => memoryEntry(entry, paths))), scopes);
}

export async function getChiliMemoryEntry(input: ChiliMemoryLoadOptions & { scope: ChiliMemoryScope; id: string }): Promise<ChiliMemoryEntry | undefined> {
  return withMemoryRepository(input, (repository, paths) => {
    const entry = repository.get(memoryScope(paths, input.scope), input.id);
    return entry ? memoryEntry(entry, paths) : undefined;
  }, [input.scope]);
}

export async function putChiliMemoryEntry(input: ChiliMemoryAddInput & { id: string; expectedRevision: number }): Promise<ChiliMemoryEntry> {
  return withMemoryRepository(input, (repository, paths) => memoryEntry(repository.put({
    id: input.id, expectedRevision: input.expectedRevision, scope: memoryScope(paths, input.scope ?? "project"),
    text: sanitizeMemoryEntry(input.text, input.maxEntryChars), source: input.source ?? "memory-api",
  }), paths), [input.scope ?? "project"]);
}

export async function exportChiliMemory(input: ChiliMemoryLoadOptions & { scope: ChiliMemoryScope }): Promise<string> {
  return withMemoryRepository(input, (repository, paths) => repository.exportMarkdown(memoryScope(paths, input.scope)), [input.scope]);
}

export async function removeChiliMemoryEntry(input: ChiliMemoryRemoveInput): Promise<ChiliMemoryRemoveResult> {
  const scope = input.scope ?? "project";
  if (!input.id && (!Number.isInteger(input.index) || (input.index ?? 0) <= 0)) throw new Error("Memory removal requires an ID or positive stable ordinal");
  if (input.id && !Number.isInteger(input.expectedRevision)) throw new Error("Memory removal by ID requires expectedRevision");
  return withMemoryRepository(input, (repository, paths) => {
    const address = memoryScope(paths, scope);
    const current = input.id ? repository.get(address, input.id) : repository.getByOrdinal(address, input.index!);
    if (!current) throw new Error(`Memory entry not found: ${input.id ?? `#${input.index}`}`);
    const removed = repository.delete(address, current.id, input.expectedRevision ?? current.revision);
    return { id: removed.id, revision: removed.revision, scope, path: paths.databasePath, index: removed.ordinal, text: removed.text };
  }, [scope]);
}

function memoryEntry(entry: MemoryRecord, paths: ChiliMemoryPaths): ChiliMemoryEntry {
  return {
    id: entry.id, revision: entry.revision, source: entry.source, updatedAt: entry.updatedAt,
    scope: entry.scope.kind, path: paths.databasePath, index: entry.ordinal, text: entry.text,
  };
}

function legacyMemoryEntries(content: string | undefined): string[] {
  if (!content?.trim()) return [];
  const entries = parseMemoryEntries(content);
  if (entries.length === 0) return [content.trim()];
  const lines = contentLines(content);
  const removedLines = new Set(entries.map((entry) => entry.lineIndex));
  const remainder = lines.filter((line, index) => !removedLines.has(index)
    && line.trim() !== CHILI_MEMORY_SECTION_HEADER && line.trim() !== "# Chili Memory").join("\n").trim();
  return [...entries.map((entry) => entry.text), ...(remainder ? [remainder] : [])];
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
  return entries.map((entry) => `[${entry.scope} #${entry.index}] ${entry.text}\nID: ${entry.id}; revision: ${entry.revision}\n${entry.path}`).join("\n\n");
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
