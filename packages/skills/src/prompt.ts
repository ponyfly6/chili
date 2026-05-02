import type { Skill, SkillSummary } from "./types.js";

export interface FormatAvailableSkillsPromptOptions {
  maxChars?: number;
  descriptionMaxChars?: number;
  whenToUseMaxChars?: number;
  includeHidden?: boolean;
}

const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_FIELD_MAX_CHARS = 250;

export function formatAvailableSkillsPrompt(
  skills: readonly SkillSummary[],
  options: FormatAvailableSkillsPromptOptions = {},
): string | undefined {
  const visible = skills
    .filter((skill) => options.includeHidden === true || skill.hidden !== true)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (visible.length === 0) return undefined;

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const descriptionMaxChars = options.descriptionMaxChars ?? DEFAULT_FIELD_MAX_CHARS;
  const whenToUseMaxChars = options.whenToUseMaxChars ?? DEFAULT_FIELD_MAX_CHARS;
  const lines = [
    "<available_skills>",
    "Skills are reusable instruction packs. The user may explicitly mention $skill-name to include the full skill instructions for the current turn. When a task matches a skill but it was not explicitly mentioned, you may call activate_skill with the skill name to inspect it before proceeding.",
  ];
  let omitted = 0;

  for (const skill of visible) {
    const line = formatSkillLine(skill, { descriptionMaxChars, whenToUseMaxChars });
    const candidate = [...lines, line, "</available_skills>"].join("\n");
    if (candidate.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }

  if (omitted > 0) {
    const omittedLine = `- ... ${omitted} more skill${omitted === 1 ? "" : "s"} omitted due to skills context budget.`;
    const candidate = [...lines, omittedLine, "</available_skills>"].join("\n");
    if (candidate.length <= maxChars) lines.push(omittedLine);
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillBodyPrompt(skill: Skill): string {
  return [
    `<skill name="${escapeAttribute(skill.name)}" source="${skill.source}">`,
    "<metadata>",
    `path: ${skill.filePath}`,
    `baseDir: ${skill.baseDir}`,
    `description: ${inlineMetadata(skill.metadata.description)}`,
    ...(skill.metadata.when_to_use !== undefined ? [`when_to_use: ${inlineMetadata(skill.metadata.when_to_use)}`] : []),
    "</metadata>",
    "<instructions>",
    skill.body.trimEnd(),
    "</instructions>",
    "</skill>",
  ].join("\n");
}

function formatSkillLine(
  skill: SkillSummary,
  options: { descriptionMaxChars: number; whenToUseMaxChars: number },
): string {
  const description = truncateInline(skill.description, options.descriptionMaxChars);
  const whenToUse = skill.when_to_use ? truncateInline(skill.when_to_use, options.whenToUseMaxChars) : undefined;
  return whenToUse ? `- ${skill.name}: ${description} When to use: ${whenToUse}` : `- ${skill.name}: ${description}`;
}

function truncateInline(input: string, maxChars: number): string {
  const normalized = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function inlineMetadata(input: string): string {
  return input.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeAttribute(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
