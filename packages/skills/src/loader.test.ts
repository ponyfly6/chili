import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSkills, parseSkillMarkdown } from "./loader.js";
import { discoverSkills } from "./registry.js";

test("loader reads user and project skills", async () => {
  const fixture = await tempFixture();
  await writeSkill(fixture.home, "user", "user-skill", "User skill description.", "user body");
  await writeSkill(fixture.cwd, "project", "project-skill", "Project skill description.", "project body");

  const result = await loadSkills({ cwd: fixture.cwd, homeDir: fixture.home });

  expect(result.diagnostics).toEqual([]);
  expect(result.skills.map((skill) => `${skill.source}:${skill.name}`)).toEqual([
    "project:project-skill",
    "user:user-skill",
  ]);
});

test("project skill overrides same-name user skill", async () => {
  const fixture = await tempFixture();
  await writeSkill(fixture.home, "user", "shared-skill", "User description.", "user body");
  await writeSkill(fixture.cwd, "project", "shared-skill", "Project description.", "project body");

  const result = await loadSkills({ cwd: fixture.cwd, homeDir: fixture.home });
  const registry = await discoverSkills({ cwd: fixture.cwd, homeDir: fixture.home });
  const skill = registry.get("shared-skill");

  expect(result.skills).toHaveLength(1);
  expect(result.allSkills.map((item) => `${item.source}:${item.filePath}`)).toHaveLength(2);
  expect(skill?.source).toBe("project");
  expect(registry.findByName("shared-skill")).toHaveLength(2);
  expect(registry.getByPath(path.join(fixture.home, ".chili", "skills", "shared-skill", "SKILL.md"))?.source).toBe("user");
  expect(skill?.body).toBe("project body\n");
  expect(registry.diagnostics()).toContainEqual(expect.objectContaining({ code: "skill_overridden" }));
});

test("disabled skills are omitted from registry lookup and summaries", async () => {
  const fixture = await tempFixture();
  await writeSkill(fixture.cwd, "project", "reviewer", "Review code.", "review body");
  await writeSkill(fixture.cwd, "project", "writer", "Write docs.", "writer body");
  await mkdir(path.join(fixture.cwd, ".chili"), { recursive: true });
  await writeFile(path.join(fixture.cwd, ".chili", "skills.json"), JSON.stringify({ disabled: ["reviewer"] }), "utf8");

  const registry = await discoverSkills({ cwd: fixture.cwd, homeDir: fixture.home });

  expect(registry.list().map((skill) => skill.name)).toEqual(["writer"]);
  expect(registry.listAll().map((skill) => skill.name)).toEqual(["writer"]);
  expect(registry.get("reviewer")).toBeUndefined();
  expect(registry.findByName("reviewer")).toEqual([]);
  expect(registry.disabled()).toEqual(["reviewer"]);

  const withDisabled = await discoverSkills({ cwd: fixture.cwd, homeDir: fixture.home, includeDisabled: true });
  expect(withDisabled.list().find((skill) => skill.name === "reviewer")).toMatchObject({
    name: "reviewer",
    disabled: true,
  });
  expect(withDisabled.get("reviewer")?.name).toBe("reviewer");
});

test("invalid skills return diagnostics without failing the load", async () => {
  const fixture = await tempFixture();
  await writeSkill(fixture.cwd, "project", "valid-skill", "Valid description.", "valid body");
  await writeRawSkill(fixture.cwd, "project", "no-frontmatter", "# Missing frontmatter\n");
  await writeRawSkill(fixture.cwd, "project", "missing-description", "---\nname: missing-description\n---\nbody\n");
  await writeRawSkill(fixture.cwd, "project", "unsafe-name", "---\nname: ../bad\ndescription: Bad\n---\nbody\n");

  const result = await loadSkills({ cwd: fixture.cwd, homeDir: fixture.home });

  expect(result.skills.map((skill) => skill.name)).toEqual(["valid-skill"]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
    "invalid_skill_name",
    "missing_frontmatter",
    "missing_required_field",
  ]);
});

test("frontmatter supports scalar fields and simple lists", () => {
  const parsed = parseSkillMarkdown(
    [
      "---",
      "name: react-component",
      "description: Build React components.",
      "when_to_use: Use for React UI.",
      "allowedTools:",
      "  - read",
      "  - grep",
      "paths: [\"src/components/**\", tests/components/**]",
      "model: chili-reviewer",
      "argumentHint: <component>",
      "context: inline",
      "hidden: false",
      "should-defer: true",
      "---",
      "# Instructions",
      "",
    ].join("\n"),
  );

  expect(parsed.status).toBe("ok");
  if (parsed.status !== "ok") return;
  expect(parsed.skill.metadata).toMatchObject({
    name: "react-component",
    description: "Build React components.",
    when_to_use: "Use for React UI.",
    allowedTools: ["read", "grep"],
    paths: ["src/components/**", "tests/components/**"],
    model: "chili-reviewer",
    argumentHint: "<component>",
    context: "inline",
    hidden: false,
    shouldDefer: true,
  });
  expect(parsed.skill.body).toBe("# Instructions\n");
});

async function tempFixture(): Promise<{ root: string; cwd: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "chili-skills-"));
  return {
    root,
    cwd: path.join(root, "repo"),
    home: path.join(root, "home"),
  };
}

async function writeSkill(
  root: string,
  scope: "project" | "user",
  name: string,
  description: string,
  body: string,
): Promise<void> {
  await writeRawSkill(
    root,
    scope,
    name,
    ["---", `name: ${name}`, `description: ${description}`, "---", body, ""].join("\n"),
  );
}

async function writeRawSkill(root: string, _scope: "project" | "user", name: string, content: string): Promise<void> {
  const skillDir = path.join(root, ".chili", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
}

test("custom profiles isolate user skills and settings while preserving project-root aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-skills-profile-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const cwd = join(project, "nested");
  const profileA = join(home, "profile-a");
  const profileB = join(home, "profile-b");
  try {
    const put = async (base: string, name: string) => {
      await mkdir(join(base, name), { recursive: true });
      await writeFile(join(base, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\nbody\n`);
    };
    await mkdir(cwd, { recursive: true });
    await put(join(profileA, "skills"), "profile-a");
    await put(join(profileB, "skills"), "profile-b");
    await put(join(home, ".agents", "skills"), "global-leak");
    await put(join(project, ".agents", "skills"), "project-alias");
    const a = await loadSkills({ cwd, projectRoot: project, homeDir: home, chiliHome: profileA });
    const b = await loadSkills({ cwd, projectRoot: project, homeDir: home, chiliHome: profileB });
    expect(a.skills.map((skill) => skill.name)).toEqual(["profile-a", "project-alias"]);
    expect(b.skills.map((skill) => skill.name)).toEqual(["profile-b", "project-alias"]);
    await writeFile(join(profileA, "skills.json"), JSON.stringify({ disabled: ["project-alias"] }));
    expect((await loadSkills({ cwd, projectRoot: project, homeDir: home, chiliHome: profileA })).skills.map((skill) => skill.name)).toEqual(["profile-a"]);
    expect((await loadSkills({ cwd, projectRoot: project, homeDir: home, chiliHome: profileB })).skills.map((skill) => skill.name)).toEqual(["profile-b", "project-alias"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
