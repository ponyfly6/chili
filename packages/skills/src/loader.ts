import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  DiscoverSkillsOptions,
  Skill,
  SkillDiagnostic,
  SkillMetadata,
  SkillRoot,
  SkillsLoadResult,
} from "./types.js";
import { isSkillDisabled, loadSkillSettings } from "./settings.js";

const SKILL_FILENAME = "SKILL.md";

type ParsedFrontmatterValue = string | boolean | string[];

interface ParsedSkillMarkdown {
  metadata: SkillMetadata;
  body: string;
}

export async function loadSkills(options: DiscoverSkillsOptions): Promise<SkillsLoadResult> {
  const cwd = path.resolve(options.cwd);
  const home = path.resolve(options.homeDir ?? homedir());
  const includeAgentsAlias = options.includeAgentsAlias ?? true;
  const settings = options.disabledSkills
    ? { disabledSkillNames: [...options.disabledSkills] }
    : await loadSkillSettings({ cwd, homeDir: home });
  const disabledSkillNames = settings.disabledSkillNames;
  const roots = skillRoots({ cwd, homeDir: home, includeAgentsAlias });
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, Skill>();
  const allSkills: Skill[] = [];

  for (const root of roots) {
    for (const skill of await loadSkillsFromRoot(root, diagnostics)) {
      allSkills.push(skill);
      const existing = byName.get(skill.name);
      if (existing) {
        diagnostics.push({
          level: "warning",
          code: "skill_overridden",
          source: skill.source,
          skillName: skill.name,
          filePath: skill.filePath,
          message: `Skill "${skill.name}" from ${skill.filePath} overrides ${existing.source} skill from ${existing.filePath}.`,
        });
      }
      byName.set(skill.name, skill);
    }
  }

  return {
    skills: [...byName.values()]
      .filter((skill) => options.includeDisabled === true || !isSkillDisabled(skill.name, disabledSkillNames))
      .sort((left, right) => left.name.localeCompare(right.name)),
    allSkills: allSkills.sort(compareSkills),
    disabledSkillNames,
    diagnostics,
    roots,
  };
}

function compareSkills(left: Skill, right: Skill): number {
  return left.name.localeCompare(right.name)
    || left.source.localeCompare(right.source)
    || left.filePath.localeCompare(right.filePath);
}

function skillRoots(input: { cwd: string; homeDir: string; includeAgentsAlias: boolean }): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (input.includeAgentsAlias) {
    roots.push({ source: "user", rootDir: path.join(input.homeDir, ".agents", "skills"), compatibilityAlias: true });
  }
  roots.push({ source: "user", rootDir: path.join(input.homeDir, ".chili", "skills"), compatibilityAlias: false });
  if (input.includeAgentsAlias) {
    roots.push({ source: "project", rootDir: path.join(input.cwd, ".agents", "skills"), compatibilityAlias: true });
  }
  roots.push({ source: "project", rootDir: path.join(input.cwd, ".chili", "skills"), compatibilityAlias: false });
  return roots;
}

async function loadSkillsFromRoot(root: SkillRoot, diagnostics: SkillDiagnostic[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = await readdir(root.rootDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return skills;
    throw error;
  }

  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const baseDir = path.join(root.rootDir, entry.name);
    const filePath = path.join(baseDir, SKILL_FILENAME);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      diagnostics.push({
        level: "error",
        code: "read_error",
        source: root.source,
        filePath,
        message: `Could not read skill file: ${errorMessage(error)}`,
      });
      continue;
    }

    const parsed = parseSkillMarkdown(content);
    if (parsed.status === "error") {
      diagnostics.push({
        level: "error",
        code: parsed.code,
        source: root.source,
        filePath,
        message: parsed.message,
      });
      continue;
    }

    const { metadata, body } = parsed.skill;
    if (!isValidSkillName(metadata.name)) {
      diagnostics.push({
        level: "error",
        code: "invalid_skill_name",
        source: root.source,
        skillName: metadata.name,
        filePath,
        message: `Skill name must be a safe single path segment: ${metadata.name}`,
      });
      continue;
    }

    skills.push({
      name: metadata.name,
      source: root.source,
      filePath,
      baseDir,
      metadata,
      body,
    });
  }

  return skills;
}

export function parseSkillMarkdown(content: string):
  | { status: "ok"; skill: ParsedSkillMarkdown }
  | { status: "error"; code: string; message: string } {
  if (!content.startsWith("---")) {
    return {
      status: "error",
      code: "missing_frontmatter",
      message: "Skill files must start with frontmatter delimited by ---.",
    };
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

  const frontmatter = parsed.frontmatter;
  if (!frontmatter.name || frontmatter.name.trim().length === 0) {
    return { status: "error", code: "missing_required_field", message: "Skill frontmatter requires name." };
  }
  if (!frontmatter.description || frontmatter.description.trim().length === 0) {
    return { status: "error", code: "missing_required_field", message: "Skill frontmatter requires description." };
  }
  const metadata: SkillMetadata = {
    ...frontmatter,
    name: frontmatter.name,
    description: frontmatter.description,
  };

  return {
    status: "ok",
    skill: {
      metadata,
      body: content.slice(match[0].length),
    },
  };
}

function parseFrontmatter(block: string):
  | { status: "ok"; frontmatter: Partial<SkillMetadata> }
  | { status: "error"; code: string; message: string } {
  const values = new Map<string, ParsedFrontmatterValue>();
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

function coerceFrontmatter(values: ReadonlyMap<string, ParsedFrontmatterValue>):
  | { status: "ok"; frontmatter: Partial<SkillMetadata> }
  | { status: "error"; code: string; message: string } {
  const frontmatter: Partial<SkillMetadata> = {};

  for (const [key, value] of values) {
    switch (key) {
      case "name":
      case "description":
      case "when_to_use":
      case "model":
      case "argumentHint":
      case "context": {
        if (typeof value !== "string") return invalidType(key, "string");
        frontmatter[key] = value;
        break;
      }
      case "allowedTools":
      case "paths": {
        const list = coerceStringList(value);
        if (!list) return invalidType(key, "string list");
        frontmatter[key] = list;
        break;
      }
      case "hidden": {
        if (typeof value !== "boolean") return invalidType(key, "boolean");
        frontmatter.hidden = value;
        break;
      }
      case "shouldDefer":
      case "should-defer":
      case "should_defer": {
        if (typeof value !== "boolean") return invalidType(key, "boolean");
        frontmatter.shouldDefer = value;
        break;
      }
      default:
        break;
    }
  }

  return { status: "ok", frontmatter };
}

function parseScalarOrInlineList(value: string): ParsedFrontmatterValue {
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

function coerceStringList(value: ParsedFrontmatterValue): string[] | undefined {
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

export function isValidSkillName(name: string): boolean {
  if (name !== name.trim()) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
