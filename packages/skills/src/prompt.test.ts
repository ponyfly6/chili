import { expect, test } from "bun:test";
import { SkillRegistry } from "./registry.js";
import { resolveSkillMentions } from "./mentions.js";
import { formatAvailableSkillsPrompt, formatSkillBodyPrompt } from "./prompt.js";
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
  expect(prompt).toContain("$skill-name");
  expect(prompt).toContain("long-skill");
  expect(prompt).toContain("AAAAAAAAAAAAAAAAAAAAA...");
  expect(prompt).toContain("When to use: Use when the user asks for...");
  expect(prompt).not.toContain("SECRET BODY");
});

test("explicit skill mention resolver prefers structured path bindings and skips ambiguous plain mentions", () => {
  const userSkill = skill({ name: "dupe", description: "User skill.", body: "user body", source: "user" });
  const projectSkill = skill({ name: "dupe", description: "Project skill.", body: "project body", source: "project" });
  const registry = new SkillRegistry([projectSkill], [], [userSkill, projectSkill]);

  const plain = resolveSkillMentions({
    text: "use $dupe",
    registry,
  });
  expect(plain.skills).toEqual([]);
  expect(plain.diagnostics).toContainEqual(expect.objectContaining({ code: "skill_ambiguous", name: "dupe" }));

  const structured = resolveSkillMentions({
    text: "use $dupe twice $dupe",
    mentions: [{ name: "dupe", path: userSkill.filePath }],
    registry,
  });
  expect(structured.skills.map((item) => item.filePath)).toEqual([userSkill.filePath]);
  expect(structured.diagnostics).toEqual([]);
});

test("skill body prompt includes full body for contextual injection", () => {
  const prompt = formatSkillBodyPrompt(skill({
    name: "writer",
    description: "Write docs.",
    when_to_use: "When docs are requested.",
    body: "# Instructions\nKeep docs crisp.\n",
  }));

  expect(prompt).toContain("<skill name=\"writer\" source=\"project\">");
  expect(prompt).toContain("description: Write docs.");
  expect(prompt).toContain("when_to_use: When docs are requested.");
  expect(prompt).toContain("# Instructions\nKeep docs crisp.");
  expect(prompt).toContain("<skill_files>\n(none)\n</skill_files>");
});

test("skill body prompt includes resource file hints without file bodies", () => {
  const prompt = formatSkillBodyPrompt(
    skill({
      name: "writer",
      description: "Write docs.",
      body: "# Instructions\nUse the template when needed.\n",
    }),
    {
      resourceFiles: [
        { path: "scripts/create.ts", bytes: 22 },
        { path: "templates/post.md", bytes: 12 },
      ],
      resourcesTruncated: true,
    },
  );

  expect(prompt).toContain("- scripts/create.ts (22 bytes)");
  expect(prompt).toContain("- templates/post.md (12 bytes)");
  expect(prompt).toContain("more files omitted");
  expect(prompt).not.toContain("template file contents");
});

test("available skills prompt hides hidden skills by default", () => {
  const registry = new SkillRegistry([
    skill({ name: "visible", description: "Visible.", body: "visible body" }),
    skill({ name: "hidden", description: "Hidden.", body: "hidden body", hidden: true }),
    skill({ name: "disabled", description: "Disabled.", body: "disabled body" }),
  ], [], [], ["disabled"], true);

  const prompt = formatAvailableSkillsPrompt(registry.list());

  expect(prompt).toContain("visible");
  expect(prompt).not.toContain("hidden");
  expect(prompt).not.toContain("disabled");
});

function skill(input: {
  name: string;
  description: string;
  body: string;
  when_to_use?: string;
  hidden?: boolean;
  source?: Skill["source"];
}): Skill {
  const metadata: Skill["metadata"] = {
    name: input.name,
    description: input.description,
  };
  if (input.when_to_use !== undefined) metadata.when_to_use = input.when_to_use;
  if (input.hidden !== undefined) metadata.hidden = input.hidden;
  return {
    name: input.name,
    source: input.source ?? "project",
    filePath: input.source === "user" ? `/home/.chili/skills/${input.name}/SKILL.md` : `/repo/.chili/skills/${input.name}/SKILL.md`,
    baseDir: input.source === "user" ? `/home/.chili/skills/${input.name}` : `/repo/.chili/skills/${input.name}`,
    metadata,
    body: input.body,
  };
}
