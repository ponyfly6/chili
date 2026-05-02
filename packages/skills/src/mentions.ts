import type { Skill } from "./types.js";
import type { SkillRegistry } from "./registry.js";

export interface SkillMentionInput {
  name: string;
  path?: string;
}

export interface SkillMentionDiagnostic {
  level: "warning";
  code: "skill_not_found" | "skill_path_not_found" | "skill_ambiguous";
  name: string;
  path?: string;
  message: string;
}

export interface ResolveSkillMentionsInput {
  text: string;
  mentions?: readonly SkillMentionInput[];
  registry: Pick<SkillRegistry, "findByName" | "getByPath">;
}

export interface ResolvedSkillMentions {
  skills: Skill[];
  diagnostics: SkillMentionDiagnostic[];
}

const SKILL_MENTION_PATTERN = /(^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g;

export function extractSkillMentionNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function resolveSkillMentions(input: ResolveSkillMentionsInput): ResolvedSkillMentions {
  const skills = new Map<string, Skill>();
  const diagnostics: SkillMentionDiagnostic[] = [];
  const structuredNames = new Set<string>();

  for (const mention of input.mentions ?? []) {
    const name = mention.name.trim();
    if (!name) continue;
    structuredNames.add(name);
    if (mention.path) {
      const skill = input.registry.getByPath(mention.path);
      if (!skill) {
        diagnostics.push({
          level: "warning",
          code: "skill_path_not_found",
          name,
          path: mention.path,
          message: `Skill mention $${name} points to ${mention.path}, but no loaded skill has that path; skipped.`,
        });
        continue;
      }
      skills.set(skill.filePath, skill);
      continue;
    }
    addSkillByExactName(input.registry, name, skills, diagnostics);
  }

  for (const name of extractSkillMentionNames(input.text)) {
    if (structuredNames.has(name)) continue;
    addSkillByExactName(input.registry, name, skills, diagnostics);
  }

  return {
    skills: [...skills.values()].sort(compareSkills),
    diagnostics,
  };
}

function addSkillByExactName(
  registry: Pick<SkillRegistry, "findByName">,
  name: string,
  skills: Map<string, Skill>,
  diagnostics: SkillMentionDiagnostic[],
): void {
  const matches = registry.findByName(name);
  if (matches.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "skill_not_found",
      name,
      message: `Skill mention $${name} did not match any loaded skill; skipped.`,
    });
    return;
  }
  if (matches.length > 1) {
    diagnostics.push({
      level: "warning",
      code: "skill_ambiguous",
      name,
      message: `Skill mention $${name} is ambiguous across ${matches.length} loaded skills; skipped. Select it from the picker so the exact SKILL.md path is bound.`,
    });
    return;
  }
  const skill = matches[0];
  if (skill) skills.set(skill.filePath, skill);
}

function compareSkills(left: Skill, right: Skill): number {
  return left.name.localeCompare(right.name)
    || left.source.localeCompare(right.source)
    || left.filePath.localeCompare(right.filePath);
}
