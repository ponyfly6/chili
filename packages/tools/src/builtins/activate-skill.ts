import {
  listSkillResourceFiles,
  skillFileLines,
  skillMetadataLines,
  type Skill,
  type SkillResourceFile,
  type SkillRegistry,
} from "@chili/skills";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface ActivateSkillInput {
  name: string;
}

export type SkillRegistryLike = Pick<SkillRegistry, "get" | "list">;

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

      const skillResources = await listSkillResourceFiles(skill.baseDir);
      return {
        title: `activate skill ${skill.name}`,
        output: formatActivatedSkill(skill, skillResources.files, skillResources.truncated),
        metadata: {
          name: skill.name,
          source: skill.source,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          skillFiles: skillResources.files.map((file) => file.path),
          skillFilesTruncated: skillResources.truncated,
          omittedHiddenSkillFiles: skillResources.omittedHidden,
          omittedLargeSkillFiles: skillResources.omittedLarge,
          omittedUnreadableSkillFiles: skillResources.omittedUnreadable,
        },
      };
    },
  };
}

function formatActivatedSkill(skill: Skill, skillFiles: readonly SkillResourceFile[], truncated: boolean): string {
  return [
    `<activated_skill name="${skill.name}">`,
    "<metadata>",
    skillMetadataLines(skill).join("\n"),
    "</metadata>",
    "<instructions>",
    skill.body.trimEnd(),
    "</instructions>",
    "<skill_files>",
    ...skillFileLines(skillFiles, truncated),
    "</skill_files>",
    "</activated_skill>",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
