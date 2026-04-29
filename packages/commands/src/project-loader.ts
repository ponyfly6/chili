import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand, normalizeCommandName } from "./registry.js";
import { expandPromptTemplate } from "./template.js";
import type { CommandDefinition, CommandDefinitionInput, PromptCommandMetadata } from "./types.js";

export interface LoadProjectCommandsOptions {
  cwd: string;
  commandsDir?: string;
}

export interface ProjectCommandsLoadResult {
  commands: readonly CommandDefinition[];
  diagnostics: readonly ProjectCommandDiagnostic[];
  directory: string;
}

export interface ProjectCommandDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  filePath?: string;
}

export interface ProjectCommandFrontmatter {
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: readonly string[];
  subtask?: boolean | string;
  category?: string;
  hidden?: boolean;
}

interface ParsedMarkdownCommand {
  frontmatter: ProjectCommandFrontmatter;
  body: string;
}

export async function loadProjectCommands(options: LoadProjectCommandsOptions): Promise<ProjectCommandsLoadResult> {
  const directory = path.resolve(options.cwd, options.commandsDir ?? ".chili/commands");
  const diagnostics: ProjectCommandDiagnostic[] = [];
  const commands: CommandDefinition[] = [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return { commands, diagnostics, directory };
    throw error;
  }

  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    const commandName = normalizeCommandName(path.basename(entry.name, ".md"));
    if (commandName.length === 0) {
      diagnostics.push({
        level: "warning",
        code: "invalid_command_name",
        message: `Skipped ${entry.name} because it does not produce a command name.`,
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

    commands.push(createProjectCommand(commandName, filePath, parsed.command));
  }

  return { commands, diagnostics, directory };
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

  const block = match[1] ?? "";
  const body = content.slice(match[0].length);
  const parsed = parseFrontmatter(block);
  if (parsed.status === "error") return parsed;
  return { status: "ok", command: { frontmatter: parsed.frontmatter, body } };
}

function createProjectCommand(commandName: string, filePath: string, command: ParsedMarkdownCommand): CommandDefinition {
  const metadata = projectMetadata(commandName, filePath, command.frontmatter);
  const input: CommandDefinitionInput = {
    name: commandName,
    category: command.frontmatter.category ?? "project",
    description: command.frontmatter.description ?? `Project command from ${path.basename(filePath)}`,
    source: "project",
    type: "prompt",
    hidden: command.frontmatter.hidden ?? false,
    supportsNonInteractive: true,
    isSafeConcurrent: true,
    metadata: { ...metadata },
    run: (_ctx, args) => ({
      type: "prompt",
      prompt: expandPromptTemplate(command.body, args),
      metadata,
    }),
  };

  if (command.frontmatter.argumentHint !== undefined) input.argumentHint = command.frontmatter.argumentHint;

  return defineCommand(input);
}

function projectMetadata(
  commandName: string,
  filePath: string,
  frontmatter: ProjectCommandFrontmatter,
): PromptCommandMetadata {
  const metadata: PromptCommandMetadata = {
    commandName,
    source: "project",
    filePath,
  };

  if (frontmatter.model !== undefined) metadata.model = frontmatter.model;
  if (frontmatter.allowedTools !== undefined) metadata.allowedTools = frontmatter.allowedTools;
  if (frontmatter.subtask !== undefined) metadata.subtask = frontmatter.subtask;
  return metadata;
}

function parseFrontmatter(block: string):
  | { status: "ok"; frontmatter: ProjectCommandFrontmatter }
  | { status: "error"; code: string; message: string } {
  const values = new Map<string, unknown>();
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line)) {
      return {
        status: "error",
        code: "malformed_frontmatter",
        message: `Unexpected indented line ${index + 1}.`,
      };
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      return {
        status: "error",
        code: "malformed_frontmatter",
        message: `Could not parse frontmatter line ${index + 1}.`,
      };
    }

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue.length > 0) {
      values.set(key, parseScalarOrInlineList(rawValue));
      continue;
    }

    const list: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      const listMatch = /^\s+-\s*(.*)$/.exec(next);
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
      case "category": {
        if (typeof value !== "string") return invalidType(key, "string");
        frontmatter[key] = value;
        break;
      }
      case "allowedTools": {
        const list = coerceStringList(value);
        if (!list) return invalidType(key, "string list");
        frontmatter.allowedTools = list;
        break;
      }
      case "subtask": {
        if (typeof value !== "boolean" && typeof value !== "string") return invalidType(key, "boolean or string");
        frontmatter.subtask = value;
        break;
      }
      case "hidden": {
        if (typeof value !== "boolean") return invalidType(key, "boolean");
        frontmatter.hidden = value;
        break;
      }
      default:
        break;
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
    return inner.length === 0 ? [] : inner.split(",").map((item) => stripQuotes(item.trim()));
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string") {
    if (value.length === 0) return [];
    return value.split(",").map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
  }
  return undefined;
}

function invalidType(key: string, expected: string): { status: "error"; code: string; message: string } {
  return {
    status: "error",
    code: "malformed_frontmatter",
    message: `Frontmatter field ${key} must be a ${expected}.`,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
