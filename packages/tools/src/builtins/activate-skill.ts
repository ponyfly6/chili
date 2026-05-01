import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Skill, SkillRegistry } from "@chili/skills";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface ActivateSkillInput {
  name: string;
}

export type SkillRegistryLike = Pick<SkillRegistry, "get" | "list">;

const DEFAULT_SKILL_FILE_LIMIT = 30;
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);

export function createActivateSkillTool(registry: SkillRegistryLike): ChiliToolDefinition<ActivateSkillInput> {
  return {
    name: "activate_skill",
    aliases: ["skill"],
    searchHint: "Load full local SKILL.md instructions by skill name.",
    description: "Activate a local Chili skill by name and return its full instructions and resource file list.",
    risk: "read",
    alwaysLoad: true,
    shouldDefer: false,
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: Infinity,
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
      },
    },
    validate(input): ValidationResult<ActivateSkillInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      if (typeof input.name !== "string" || input.name.trim().length === 0) {
        return { ok: false, message: "name must be a non-empty string" };
      }
      return { ok: true, value: { name: input.name.trim() } };
    },
    approval: () => false,
    async execute(input) {
      const skill = registry.get(input.name);
      if (!skill) {
        const availableSkills = registry.list().map((item) => item.name);
        return {
          title: `activate skill ${input.name}`,
          output: `Skill "${input.name}" not found. Available skills: ${availableSkills.length > 0 ? availableSkills.join(", ") : "none"}.`,
          metadata: {
            error: "skill_not_found",
            name: input.name,
            availableSkills,
          },
        };
      }

      const skillFiles = await listSkillFiles(skill.baseDir, DEFAULT_SKILL_FILE_LIMIT);
      return {
        title: `activate skill ${skill.name}`,
        output: formatActivatedSkill(skill, skillFiles),
        metadata: {
          name: skill.name,
          source: skill.source,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          skillFiles,
        },
      };
    },
  };
}

async function listSkillFiles(baseDir: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];

  while (queue.length > 0 && files.length < limit) {
    const relativeDir = queue.shift() ?? "";
    const absoluteDir = path.join(baseDir, relativeDir);
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) queue.push(relativePath);
        continue;
      }
      if (!entry.isFile() || entry.name === "SKILL.md") continue;
      files.push(relativePath.split(path.sep).join("/"));
      if (files.length >= limit) break;
    }
  }

  return files;
}

function formatActivatedSkill(skill: Skill, skillFiles: readonly string[]): string {
  const metadata = metadataLines(skill).join("\n");
  const files = skillFiles.length > 0 ? skillFiles.map((file) => `- ${file}`).join("\n") : "(none)";
  return [
    `<activated_skill name="${skill.name}">`,
    "<metadata>",
    metadata,
    "</metadata>",
    "<instructions>",
    skill.body.trimEnd(),
    "</instructions>",
    "<skill_files>",
    files,
    "</skill_files>",
    "</activated_skill>",
  ].join("\n");
}

function metadataLines(skill: Skill): string[] {
  const metadata = skill.metadata;
  const lines = [
    `source: ${skill.source}`,
    `path: ${skill.filePath}`,
    `baseDir: ${skill.baseDir}`,
    `description: ${metadataValue(metadata.description)}`,
  ];
  if (metadata.when_to_use !== undefined) lines.push(`when_to_use: ${metadataValue(metadata.when_to_use)}`);
  if (metadata.allowedTools !== undefined) lines.push(`allowedTools: ${metadata.allowedTools.join(", ")}`);
  if (metadata.model !== undefined) lines.push(`model: ${metadataValue(metadata.model)}`);
  if (metadata.argumentHint !== undefined) lines.push(`argumentHint: ${metadataValue(metadata.argumentHint)}`);
  if (metadata.paths !== undefined) lines.push(`paths: ${metadata.paths.join(", ")}`);
  if (metadata.context !== undefined) lines.push(`context: ${metadataValue(metadata.context)}`);
  if (metadata.hidden !== undefined) lines.push(`hidden: ${metadata.hidden}`);
  if (metadata.shouldDefer !== undefined) lines.push(`shouldDefer: ${metadata.shouldDefer}`);
  return lines;
}

function metadataValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
