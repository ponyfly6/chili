import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeCommandDiagnostic } from "@chili/protocol";
import { createPromptNamespace, createPromptRoot, normalizeCommandSegment } from "./prompt-tree.js";
import { defineCommand } from "./registry.js";
import { expandPromptTemplate } from "./template.js";
import type { CommandDefinition, PromptCommandMetadata } from "./types.js";

export interface LoadProjectCommandsOptions {
  cwd: string;
  commandsDir?: string;
}

export interface LoadUserCommandsOptions {
  chiliHome?: string;
  commandsDir?: string;
}

export interface LoadCommandDirectoryOptions {
  directory: string;
  source: "project" | "user";
}

export interface ProjectCommandsLoadResult {
  commands: readonly CommandDefinition[];
  diagnostics: readonly ProjectCommandDiagnostic[];
  directory: string;
}

export type ProjectCommandDiagnostic = RuntimeCommandDiagnostic;

export interface ProjectCommandFrontmatter {
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: readonly string[];
  writeScope?: readonly string[];
  executeScope?: readonly string[];
  subtask?: boolean | string;
  hidden?: boolean;
}

interface ParsedMarkdownCommand {
  frontmatter: ProjectCommandFrontmatter;
  body: string;
}

interface LoadedMarkdownCommand extends ParsedMarkdownCommand {
  filePath: string;
}

interface MutablePromptNode {
  segment: string;
  children: Map<string, MutablePromptNode>;
  command?: LoadedMarkdownCommand;
}

export async function loadProjectCommands(options: LoadProjectCommandsOptions): Promise<ProjectCommandsLoadResult> {
  const directory = path.resolve(options.cwd, options.commandsDir ?? ".chili/commands");
  return loadCommandDirectory({ directory, source: "project" });
}

export async function loadUserCommands(options: LoadUserCommandsOptions = {}): Promise<ProjectCommandsLoadResult> {
  const chiliHome = options.chiliHome ?? path.join(homedir(), ".chili");
  const directory = path.resolve(chiliHome, options.commandsDir ?? "commands");
  return loadCommandDirectory({ directory, source: "user" });
}

export async function loadCommandDirectory(options: LoadCommandDirectoryOptions): Promise<ProjectCommandsLoadResult> {
  const directory = path.resolve(options.directory);
  const diagnostics: ProjectCommandDiagnostic[] = [];
  const tree: MutablePromptNode = { segment: options.source, children: new Map() };

  let files: string[];
  try {
    files = await markdownFiles(directory);
  } catch (error) {
    if (isNotFoundError(error)) return { commands: [], diagnostics, directory };
    throw error;
  }

  for (const filePath of files) {
    const segments = commandSegmentsFromPath(directory, filePath);
    if (segments.length === 0) {
      diagnostics.push({
        level: "error",
        code: "invalid_command_path",
        message: `Skipped ${path.relative(directory, filePath)} because it does not produce a command path.`,
        filePath,
      });
      continue;
    }

    const content = await readFile(filePath, "utf8");
    const parsed = parseMarkdownCommand(content);
    if (parsed.status === "error") {
      diagnostics.push({
        level: "error",
        code: parsed.code,
        message: parsed.message,
        filePath,
      });
      continue;
    }

    insertPrompt(tree, segments, { ...parsed.command, filePath }, options.source, diagnostics);
  }

  if (tree.children.size === 0) return { commands: [], diagnostics, directory };
  const children = [...tree.children.values()].map((node) => promptNodeDefinition(node, options.source, []));
  return {
    commands: [createPromptRoot([createPromptNamespace(options.source, children)])],
    diagnostics,
    directory,
  };
}

export function parseMarkdownCommand(content: string):
  | { status: "ok"; command: ParsedMarkdownCommand }
  | { status: "error"; code: string; message: string } {
  if (!content.startsWith("---")) {
    return { status: "ok", command: { frontmatter: {}, body: content } };
  }

  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {
      status: "error",
      code: "malformed_frontmatter",
      message: "Frontmatter starts with --- but has no closing --- delimiter.",
    };
  }

  const parsed = parseFrontmatter(match[1] ?? "");
  if (parsed.status === "error") return parsed;
  return {
    status: "ok",
    command: {
      frontmatter: parsed.frontmatter,
      body: content.slice(match[0].length),
    },
  };
}

async function markdownFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await markdownFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      output.push(filePath);
    }
  }
  return output;
}

function commandSegmentsFromPath(directory: string, filePath: string): string[] {
  const relative = path.relative(directory, filePath).replace(/\.md$/i, "");
  const rawSegments = relative.split(path.sep);
  const segments = rawSegments.map((segment) => normalizeCommandSegment(segment));
  return segments.some((segment) => !segment) ? [] : segments;
}

function insertPrompt(
  root: MutablePromptNode,
  segments: readonly string[],
  command: LoadedMarkdownCommand,
  source: "project" | "user",
  diagnostics: ProjectCommandDiagnostic[],
): void {
  let node = root;
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (!child) {
      child = { segment, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }

  if (node.command) {
    const commandPath = `/prompt ${source} ${segments.join(" ")}`;
    const commandId = `prompt.${source}.${segments.join(".")}`;
    diagnostics.push({
      level: "error",
      code: "duplicate_command_path",
      message: `Rejected ${command.filePath} because ${commandPath} is already defined by ${node.command.filePath}.`,
      path: commandPath,
      commandIds: [commandId, commandId],
      origins: [node.command.filePath, command.filePath],
    });
    return;
  }
  node.command = command;
}

function promptNodeDefinition(
  node: MutablePromptNode,
  source: "project" | "user",
  parentSegments: readonly string[],
): CommandDefinition {
  const segments = [...parentSegments, node.segment];
  const commandId = `prompt.${source}.${segments.join(".")}`;
  const commandPath = `/prompt ${source} ${segments.join(" ")}`;
  const loaded = node.command;
  const children = [...node.children.values()].map((child) => promptNodeDefinition(child, source, segments));
  const definition = defineCommand({
    id: commandId,
    name: node.segment,
    title: loaded?.frontmatter.description ?? humanize(node.segment),
    description: loaded?.frontmatter.description ?? `${source === "user" ? "User" : "Project"} prompt namespace`,
    group: "prompt",
    source,
    argumentMode: loaded ? "variadic" : "none",
    argumentHint: loaded?.frontmatter.argumentHint ?? "",
    selectionMode: loaded ? "execute" : "drilldown",
    hidden: loaded?.frontmatter.hidden ?? false,
    executionTarget: "prompt",
    children,
    ...(loaded ? {
      origin: loaded.filePath,
      metadata: promptMetadata(commandId, commandPath, loaded.filePath, source, loaded.frontmatter),
      run: (_context, args) => ({
        type: "prompt" as const,
        prompt: expandPromptTemplate(loaded.body, args),
        metadata: promptMetadata(commandId, commandPath, loaded.filePath, source, loaded.frontmatter),
      }),
    } : {}),
  });
  return definition;
}

function promptMetadata(
  commandId: string,
  commandPath: string,
  filePath: string,
  source: "project" | "user",
  frontmatter: ProjectCommandFrontmatter,
): PromptCommandMetadata {
  return {
    commandId,
    commandPath,
    source,
    filePath,
    ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
    ...(frontmatter.allowedTools !== undefined ? { allowedTools: frontmatter.allowedTools } : {}),
    ...(frontmatter.writeScope !== undefined ? { writeScope: frontmatter.writeScope } : {}),
    ...(frontmatter.executeScope !== undefined ? { executeScope: frontmatter.executeScope } : {}),
    ...(frontmatter.subtask !== undefined ? { subtask: frontmatter.subtask } : {}),
  };
}

function parseFrontmatter(block: string):
  | { status: "ok"; frontmatter: ProjectCommandFrontmatter }
  | { status: "error"; code: string; message: string } {
  const values = new Map<string, unknown>();
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line)) {
      return malformed(`Unexpected indented line ${index + 1}.`);
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) return malformed(`Could not parse frontmatter line ${index + 1}.`);
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue) {
      values.set(key, parseScalarOrInlineList(rawValue));
      continue;
    }
    const list: string[] = [];
    while (index + 1 < lines.length) {
      const listMatch = /^\s+-\s*(.*)$/.exec(lines[index + 1] ?? "");
      if (!listMatch) break;
      list.push(stripQuotes((listMatch[1] ?? "").trim()));
      index += 1;
    }
    values.set(key, list.length > 0 ? list : "");
  }

  return coerceFrontmatter(values);
}

function coerceFrontmatter(values: ReadonlyMap<string, unknown>):
  | { status: "ok"; frontmatter: ProjectCommandFrontmatter }
  | { status: "error"; code: string; message: string } {
  const frontmatter: ProjectCommandFrontmatter = {};
  for (const [key, value] of values) {
    switch (key) {
      case "description":
      case "argumentHint":
      case "model":
        if (typeof value !== "string") return invalidType(key, "string");
        frontmatter[key] = value;
        break;
      case "allowedTools":
      case "writeScope":
      case "executeScope": {
        const list = coerceStringList(value);
        if (!list) return invalidType(key, "string list");
        frontmatter[key] = list;
        break;
      }
      case "subtask":
        if (typeof value !== "boolean" && typeof value !== "string") return invalidType(key, "boolean or string");
        frontmatter.subtask = value;
        break;
      case "hidden":
        if (typeof value !== "boolean") return invalidType(key, "boolean");
        frontmatter.hidden = value;
        break;
      default:
        return {
          status: "error",
          code: "unsupported_frontmatter_field",
          message: `Unsupported command frontmatter field: ${key}`,
        };
    }
  }
  return { status: "ok", frontmatter };
}

function parseScalarOrInlineList(value: string): string | boolean | string[] {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner ? inner.split(",").map((item) => stripQuotes(item.trim())) : [];
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string") {
    return value ? value.split(",").map((item) => stripQuotes(item.trim())).filter(Boolean) : [];
  }
  return undefined;
}

function invalidType(key: string, expected: string) {
  return malformed(`Frontmatter field ${key} must be a ${expected}.`);
}

function malformed(message: string): { status: "error"; code: string; message: string } {
  return { status: "error", code: "malformed_frontmatter", message };
}

function humanize(segment: string): string {
  return segment.split(/[-_]/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
