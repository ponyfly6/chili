import { expect, test } from "bun:test";
import { SkillRegistry } from "./registry.js";
import { formatAvailableSkillsPrompt } from "./prompt.js";
import type { Skill } from "./types.js";

test("available skills prompt omits full bodies and truncates long descriptions", () => {
  const registry = new SkillRegistry([
    skill({
      name: "long-skill",
      description: "A".repeat(80),
      body: "SECRET BODY SHOULD NOT APPEAR",
      when_to_use: "Use when the user asks for the very specific workflow that needs this skill.",
    }),
  ]);

  const prompt = formatAvailableSkillsPrompt(registry.list(), {
    descriptionMaxChars: 24,
    whenToUseMaxChars: 30,
  });

  expect(prompt).toContain("<available_skills>");
  expect(prompt).toContain("long-skill");
  expect(prompt).toContain("AAAAAAAAAAAAAAAAAAAAA...");
  expect(prompt).toContain("When to use: Use when the user asks for...");
  expect(prompt).not.toContain("SECRET BODY");
});

test("available skills prompt hides hidden skills by default", () => {
  const registry = new SkillRegistry([
    skill({ name: "visible", description: "Visible.", body: "visible body" }),
    skill({ name: "hidden", description: "Hidden.", body: "hidden body", hidden: true }),
  ]);

  const prompt = formatAvailableSkillsPrompt(registry.list());

  expect(prompt).toContain("visible");
  expect(prompt).not.toContain("hidden");
});

function skill(input: {
  name: string;
  description: string;
  body: string;
  when_to_use?: string;
  hidden?: boolean;
}): Skill {
  const metadata: Skill["metadata"] = {
    name: input.name,
    description: input.description,
  };
  if (input.when_to_use !== undefined) metadata.when_to_use = input.when_to_use;
  if (input.hidden !== undefined) metadata.hidden = input.hidden;
  return {
    name: input.name,
    source: "project",
    filePath: `/repo/.chili/skills/${input.name}/SKILL.md`,
    baseDir: `/repo/.chili/skills/${input.name}`,
    metadata,
    body: input.body,
  };
}
