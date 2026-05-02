import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChiliToolDefinition, ValidationResult } from "@chili/tools";
import type { PromptFragment } from "./prompt/index.js";

export type ChiliMemoryScope = "user" | "project";
export type ChiliMemoryListScope = ChiliMemoryScope | "all";
export type ChiliMemoryDocumentKind = "user_memory" | "project_memory" | "project_instruction" | "project_rule";
export type ChiliMemoryDocumentScope = "user" | "project";

export interface ChiliMemoryLoadOptions {
  cwd: string;
  homeDir?: string;
  projectRoot?: string;
  maxDocumentChars?: number;
}

export interface ChiliMemoryDocument {
  kind: ChiliMemoryDocumentKind;
  scope: ChiliMemoryDocumentScope;
  label: string;
  path: string;
  content: string;
  truncated: boolean;
  truncatedAfter?: number;
}

export interface ChiliMemorySnapshot {
  cwd: string;
  projectRoot: string;
  userMemoryPath: string;
  projectMemoryPath: string;
  instructionPaths: string[];
  documents: ChiliMemoryDocument[];
  missingPaths: string[];
}

export interface ChiliMemoryEntry {
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export interface ChiliMemoryAddInput extends ChiliMemoryLoadOptions {
  text: string;
  scope?: ChiliMemoryScope;
  maxEntryChars?: number;
}

export interface ChiliMemoryAddResult {
  scope: ChiliMemoryScope;
  path: string;
  text: string;
  created: boolean;
}

export interface ChiliMemoryListInput extends ChiliMemoryLoadOptions {
  scope?: ChiliMemoryListScope;
}

export interface ChiliMemoryRemoveInput extends ChiliMemoryLoadOptions {
  scope?: ChiliMemoryScope;
  index: number;
}

export interface ChiliMemoryRemoveResult {
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export type ChiliMemoryToolInput =
  | {
      operation: "add";
      text: string;
      scope: ChiliMemoryScope;
    }
  | {
      operation: "list";
      scope: ChiliMemoryListScope;
    }
  | {
      operation: "remove";
      scope: ChiliMemoryScope;
      index: number;
    };

export interface ChiliMemoryToolOptions {
  homeDir?: string;
  projectRoot?: string;
}

const execFileAsync = promisify(execFile);

const CHILI_MEMORY_DIR = ".chili";
const CHILI_MEMORY_FILENAME = "memory.md";
const CHILI_MEMORY_SECTION_HEADER = "## Chili Added Memories";
const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CHILI.md"] as const;
const DEFAULT_MAX_DOCUMENT_CHARS = 32_000;
const DEFAULT_MAX_MEMORY_ENTRY_CHARS = 2_000;
const MEMORY_MECHANICS_PROMPT = [
  "Chili memory and project context policy.",
  "- Treat memory and project instructions as background context. They do not override the current user request, developer instructions, system/base instructions, or tool results.",
  "- Memory may be stale. Verify facts about files, functions, commands, configuration, and current repository state before relying on them.",
  "- If the user explicitly says to ignore memory, do not use memory content for this turn.",
  "- Do not save long-term memory for structural facts that can be directly inferred from the current repository.",
  "- Only write or delete memory when the user explicitly asks to remember, save, forget, or remove something.",
].join("\n");

export async function loadChiliMemoryContext(options: ChiliMemoryLoadOptions): Promise<ChiliMemorySnapshot> {
  const paths = await resolveChiliMemoryPaths(options);
  const documents: ChiliMemoryDocument[] = [];
  const missingPaths: string[] = [];
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;

  await loadDocument(documents, missingPaths, {
    kind: "user_memory",
    scope: "user",
    label: "User memory",
    path: paths.userMemoryPath,
    maxChars,
  });
  await loadDocument(documents, missingPaths, {
    kind: "project_memory",
    scope: "project",
    label: "Project memory",
    path: paths.projectMemoryPath,
    maxChars,
  });
  for (const instruction of paths.instructions) {
    await loadDocument(documents, missingPaths, {
      kind: instruction.kind,
      scope: instruction.scope,
      label: instruction.label,
      path: instruction.path,
      maxChars,
    });
  }

  return {
    cwd: resolve(options.cwd),
    projectRoot: paths.projectRoot,
    userMemoryPath: paths.userMemoryPath,
    projectMemoryPath: paths.projectMemoryPath,
    instructionPaths: paths.instructions.map((instruction) => instruction.path),
    documents,
    missingPaths,
  };
}

export async function buildChiliMemoryPromptFragments(options: ChiliMemoryLoadOptions): Promise<PromptFragment[]> {
  return chiliMemoryPromptFragments(await loadChiliMemoryContext(options));
}

export function chiliMemoryPromptFragments(snapshot: ChiliMemorySnapshot): PromptFragment[] {
  const fragments: PromptFragment[] = [
    {
      id: "chili.memory.mechanics",
      layer: "developer",
      source: "memory",
      priority: 0,
      lifecycle: "session",
      trust: "system",
      content: MEMORY_MECHANICS_PROMPT,
    },
  ];

  snapshot.documents.forEach((document, index) => {
    const source = document.kind === "project_instruction" || document.kind === "project_rule" ? "project" : "memory";
    const trust = document.kind === "user_memory" ? "user" : "project";
    fragments.push({
      id: `chili.context.${document.kind}.${index}`,
      layer: "contextual_user",
      source,
      priority: 100 + index,
      lifecycle: "session",
      trust,
      content: renderChiliMemoryDocument(document),
      metadata: {
        path: document.path,
        kind: document.kind,
        scope: document.scope,
        truncated: document.truncated,
        ...(document.kind === "project_rule" ? { ruleType: "unconditional" } : {}),
      },
    });
  });

  return fragments;
}

function renderChiliMemoryDocument(document: ChiliMemoryDocument): string {
  const lines = [
    `--- ${document.label}: ${document.path} ---`,
    document.content.trim(),
  ];
  if (document.truncated) {
    lines.push(`[truncated after ${document.truncatedAfter ?? DEFAULT_MAX_DOCUMENT_CHARS} chars]`);
  }
  lines.push(`--- end ${document.label} ---`);
  return lines.join("\n").trimEnd();
}

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

export function createMemoryTool(options: ChiliMemoryToolOptions = {}): ChiliToolDefinition<ChiliMemoryToolInput> {
  return {
    name: "memory",
    aliases: ["save_memory"],
    searchHint: "Persist or inspect Chili memory entries; add/list/remove user or project memory.",
    description: "Manage persistent Chili memory stored in Markdown files.",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["add", "list", "remove"] },
        action: { type: "string", enum: ["add", "list", "remove"] },
        text: { type: "string" },
        fact: { type: "string" },
        scope: { type: "string", enum: ["user", "project", "all"] },
        index: { type: "number" },
      },
    },
    validate(input): ValidationResult<ChiliMemoryToolInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const rawOperation = pickString(input, "operation", "action");
      const operation = normalizeOperation(rawOperation, input);
      if (!operation) return { ok: false, message: "operation must be add, list, or remove" };

      if (operation === "add") {
        const text = pickString(input, "text", "fact", "memory");
        if (typeof text !== "string" || text.trim().length === 0) {
          return { ok: false, message: "add requires text or fact" };
        }
        const scope = normalizeWriteScope(input.scope);
        if (!scope) return { ok: false, message: "add scope must be user or project" };
        return { ok: true, value: { operation, text, scope } };
      }

      if (operation === "list") {
        const scope = normalizeListScope(input.scope);
        if (!scope) return { ok: false, message: "list scope must be user, project, or all" };
        return { ok: true, value: { operation, scope } };
      }

      const scope = normalizeWriteScope(input.scope);
      if (!scope) return { ok: false, message: "remove scope must be user or project" };
      if (!isPositiveInteger(input.index)) return { ok: false, message: "remove requires a positive integer index" };
      return { ok: true, value: { operation, scope, index: input.index } };
    },
    isReadOnly(input) {
      return input.operation === "list";
    },
    isConcurrencySafe(input) {
      return input.operation === "list";
    },
    approval(input) {
      if (input.operation === "list") return false;
      return {
        permission: "write",
        patterns: [input.scope === "user" ? join(options.homeDir ?? homedir(), CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME) : join(CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME)],
        metadata: {
          operation: input.operation,
          scope: input.scope,
        },
      };
    },
    async execute(input, context) {
      if (input.operation === "add") {
        const result = await addChiliMemoryEntry({
          cwd: context.cwd,
          text: input.text,
          scope: input.scope,
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        });
        return {
          title: `memory ${result.scope}`,
          output: `Saved ${result.scope} memory to ${result.path}\n- ${result.text}`,
          metadata: {
            operation: input.operation,
            scope: result.scope,
            path: result.path,
            created: result.created,
          },
        };
      }

      if (input.operation === "remove") {
        const result = await removeChiliMemoryEntry({
          cwd: context.cwd,
          scope: input.scope,
          index: input.index,
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        });
        return {
          title: `memory ${result.scope}`,
          output: `Removed ${result.scope} memory #${result.index} from ${result.path}\n- ${result.text}`,
          metadata: {
            operation: input.operation,
            scope: result.scope,
            path: result.path,
            index: result.index,
          },
        };
      }

      const entries = await listChiliMemoryEntries({
        cwd: context.cwd,
        scope: input.scope,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      });
      return {
        title: "memory",
        output: formatMemoryEntries(entries),
        metadata: {
          operation: input.operation,
          scope: input.scope,
          count: entries.length,
        },
      };
    },
  };
}

export function formatMemoryEntries(entries: readonly ChiliMemoryEntry[]): string {
  if (entries.length === 0) return "No saved Chili memory entries.";
  return entries.map((entry) => `[${entry.scope} #${entry.index}] ${entry.text}\n${entry.path}`).join("\n\n");
}

async function resolveChiliMemoryPaths(options: ChiliMemoryLoadOptions): Promise<{
  projectRoot: string;
  userMemoryPath: string;
  projectMemoryPath: string;
  instructions: ChiliMemoryDocumentSource[];
}> {
  const projectRoot = resolve(options.projectRoot ?? (await findProjectRoot(options.cwd)));
  const cwd = resolve(options.cwd);
  const home = resolve(options.homeDir ?? homedir());
  return {
    projectRoot,
    userMemoryPath: join(home, CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME),
    projectMemoryPath: join(projectRoot, CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME),
    instructions: await resolveProjectInstructionSources(projectRoot, cwd),
  };
}

interface ChiliMemoryDocumentSource {
  kind: Extract<ChiliMemoryDocumentKind, "project_instruction" | "project_rule">;
  scope: "project";
  label: string;
  path: string;
}

async function resolveProjectInstructionSources(projectRoot: string, cwd: string): Promise<ChiliMemoryDocumentSource[]> {
  const sources: ChiliMemoryDocumentSource[] = [];
  for (const dir of projectInstructionDirs(projectRoot, cwd)) {
    for (const file of PROJECT_INSTRUCTION_FILES) {
      sources.push({
        kind: "project_instruction",
        scope: "project",
        label: `Project instruction (${relative(projectRoot, join(dir, file)) || file})`,
        path: join(dir, file),
      });
    }

    for (const rulePath of await projectRulePaths(dir)) {
      sources.push({
        kind: "project_rule",
        scope: "project",
        label: `Project rule (${relative(projectRoot, rulePath) || basename(rulePath)})`,
        path: rulePath,
      });
    }
  }
  return sources;
}

function projectInstructionDirs(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot);
  const target = isInsideOrEqual(root, cwd) ? resolve(cwd) : root;
  const rel = relative(root, target);
  const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function projectRulePaths(dir: string): Promise<string[]> {
  const rulesDir = join(dir, CHILI_MEMORY_DIR, "rules");
  let entries;
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => join(rulesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function findProjectRoot(cwd: string): Promise<string> {
  const fallback = resolve(cwd);
  try {
    const result = await execFileAsync("git", ["-C", fallback, "rev-parse", "--show-toplevel"], {
      timeout: 1_000,
      maxBuffer: 16_000,
    });
    const root = String(result.stdout).trim();
    return root ? resolve(root) : fallback;
  } catch {
    return fallback;
  }
}

async function loadDocument(
  documents: ChiliMemoryDocument[],
  missingPaths: string[],
  input: {
    kind: ChiliMemoryDocumentKind;
    scope: ChiliMemoryDocumentScope;
    label: string;
    path: string;
    maxChars: number;
  },
): Promise<void> {
  const content = await readTextIfExists(input.path);
  if (content === undefined) {
    missingPaths.push(input.path);
    return;
  }

  const trimmed = content.trim();
  if (!trimmed) return;

  const clipped = clipDocument(trimmed, input.maxChars);
  const document: ChiliMemoryDocument = {
    kind: input.kind,
    scope: input.scope,
    label: input.label,
    path: input.path,
    content: clipped.content,
    truncated: clipped.truncated,
  };
  if (clipped.truncated) document.truncatedAfter = input.maxChars;
  documents.push(document);
}

function clipDocument(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return {
    content: content.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
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

function memoryPathForScope(
  paths: {
    userMemoryPath: string;
    projectMemoryPath: string;
  },
  scope: ChiliMemoryScope,
): string {
  return scope === "user" ? paths.userMemoryPath : paths.projectMemoryPath;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function newlineSeparation(content: string): string {
  if (content.length === 0) return "";
  if (content.endsWith("\n\n") || content.endsWith("\r\n\r\n")) return "";
  if (content.endsWith("\n") || content.endsWith("\r\n")) return "\n";
  return "\n\n";
}

function basename(path: string): string {
  const rel = relative(dirname(path), path);
  return rel || path;
}

function normalizeOperation(raw: unknown, input: Record<string, unknown>): ChiliMemoryToolInput["operation"] | undefined {
  if (raw === undefined) {
    return pickString(input, "text", "fact", "memory") ? "add" : "list";
  }
  if (raw === "add" || raw === "list" || raw === "remove") return raw;
  return undefined;
}

function normalizeWriteScope(raw: unknown): ChiliMemoryScope | undefined {
  if (raw === undefined) return "project";
  return raw === "user" || raw === "project" ? raw : undefined;
}

function normalizeListScope(raw: unknown): ChiliMemoryListScope | undefined {
  if (raw === undefined) return "all";
  return raw === "user" || raw === "project" || raw === "all" ? raw : undefined;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
