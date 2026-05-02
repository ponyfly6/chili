import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { CHILI_MEMORY_DIR } from "./constants.js";
import type { ChiliMemoryDocumentSource, ChiliProjectRuleMetadata } from "./types.js";
import { isNotFound, readTextIfExists } from "./utils.js";

export async function projectRuleSources(dir: string, projectRoot: string): Promise<ChiliMemoryDocumentSource[]> {
  const rulesDir = join(dir, CHILI_MEMORY_DIR, "rules");
  let entries;
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => join(rulesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const sources: ChiliMemoryDocumentSource[] = [];
  for (const path of paths) {
    const ruleMetadata = await readProjectRuleMetadata(path);
    const source: ChiliMemoryDocumentSource = {
      kind: "project_rule",
      scope: "project",
      label: `Project rule (${relative(projectRoot, path) || basename(path)})`,
      path,
    };
    if (ruleMetadata !== undefined) source.ruleMetadata = ruleMetadata;
    sources.push(source);
  }

  return sources.sort(compareProjectRuleSources);
}

export function parseProjectRuleMarkdown(content: string): {
  body: string;
  metadata?: ChiliProjectRuleMetadata;
} {
  if (!content.startsWith("---")) {
    return { body: content };
  }

  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return { body: content };
  }

  const parsed = parseProjectRuleFrontmatter(match[1] ?? "");
  if (parsed.status === "error") {
    return { body: content };
  }

  const frontmatter = parsed.frontmatter;
  const metadata: ChiliProjectRuleMetadata = {
    alwaysApply: frontmatter.alwaysApply ?? true,
  };
  if (frontmatter.paths !== undefined) metadata.paths = frontmatter.paths;
  if (frontmatter.description !== undefined) metadata.description = frontmatter.description;
  if (frontmatter.priority !== undefined) metadata.priority = frontmatter.priority;

  return {
    body: content.slice(match[0].length),
    metadata,
  };
}

async function readProjectRuleMetadata(path: string): Promise<ChiliProjectRuleMetadata | undefined> {
  const content = await readTextIfExists(path);
  if (content === undefined) return undefined;
  return parseProjectRuleMarkdown(content).metadata;
}

function compareProjectRuleSources(left: ChiliMemoryDocumentSource, right: ChiliMemoryDocumentSource): number {
  const leftPriority = left.ruleMetadata?.priority;
  const rightPriority = right.ruleMetadata?.priority;
  if (leftPriority !== undefined && rightPriority !== undefined) {
    const priorityDelta = leftPriority - rightPriority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.path.localeCompare(right.path);
  }
  if (leftPriority !== undefined) return -1;
  if (rightPriority !== undefined) return 1;
  return left.path.localeCompare(right.path);
}

type ProjectRuleFrontmatterValue = string | boolean | number | string[];

interface ProjectRuleFrontmatter {
  paths?: string[];
  alwaysApply?: boolean;
  description?: string;
  priority?: number;
}

function parseProjectRuleFrontmatter(block: string):
  | { status: "ok"; frontmatter: ProjectRuleFrontmatter }
  | { status: "error"; code: string; message: string } {
  const values = new Map<string, ProjectRuleFrontmatterValue>();
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
      values.set(key, parseProjectRuleScalarOrInlineList(rawValue));
      continue;
    }

    const list: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      const listMatch = /^\s+-\s*(.*)$/.exec(next);
      if (!listMatch) break;
      list.push(stripProjectRuleQuotes((listMatch[1] ?? "").trim()));
      index += 1;
    }
    values.set(key, list.length > 0 ? list : "");
  }

  return coerceProjectRuleFrontmatter(values);
}

function coerceProjectRuleFrontmatter(values: ReadonlyMap<string, ProjectRuleFrontmatterValue>):
  | { status: "ok"; frontmatter: ProjectRuleFrontmatter }
  | { status: "error"; code: string; message: string } {
  const frontmatter: ProjectRuleFrontmatter = {};

  for (const [key, value] of values) {
    switch (key) {
      case "paths": {
        const list = coerceProjectRuleStringList(value);
        if (!list) return invalidProjectRuleFrontmatterType(key, "string list");
        frontmatter.paths = list;
        break;
      }
      case "alwaysApply": {
        if (typeof value !== "boolean") return invalidProjectRuleFrontmatterType(key, "boolean");
        frontmatter.alwaysApply = value;
        break;
      }
      case "description": {
        if (typeof value !== "string") return invalidProjectRuleFrontmatterType(key, "string");
        frontmatter.description = value;
        break;
      }
      case "priority": {
        if (typeof value !== "number") return invalidProjectRuleFrontmatterType(key, "number");
        frontmatter.priority = value;
        break;
      }
      default:
        break;
    }
  }

  return { status: "ok", frontmatter };
}

function parseProjectRuleScalarOrInlineList(value: string): ProjectRuleFrontmatterValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((item) => stripProjectRuleQuotes(item.trim()));
  }
  return stripProjectRuleQuotes(trimmed);
}

function stripProjectRuleQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceProjectRuleStringList(value: ProjectRuleFrontmatterValue): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string") {
    if (value.length === 0) return [];
    return value.split(",").map((item) => stripProjectRuleQuotes(item.trim())).filter((item) => item.length > 0);
  }
  return undefined;
}

function invalidProjectRuleFrontmatterType(
  key: string,
  expected: string,
): { status: "error"; code: string; message: string } {
  return {
    status: "error",
    code: "malformed_frontmatter",
    message: `Frontmatter field ${key} must be a ${expected}.`,
  };
}

function basename(path: string): string {
  const rel = relative(dirname(path), path);
  return rel || path;
}
