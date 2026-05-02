import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { loadSkillSettings, updateSkillDisabledSetting } from "./settings.js";

test("skill settings merge user and project disabled names", async () => {
  const fixture = await tempFixture();
  await mkdir(path.join(fixture.home, ".chili"), { recursive: true });
  await mkdir(path.join(fixture.cwd, ".chili"), { recursive: true });
  await writeFile(path.join(fixture.home, ".chili", "skills.json"), JSON.stringify({ disabled: ["writer"] }), "utf8");
  await writeFile(path.join(fixture.cwd, ".chili", "skills.json"), JSON.stringify({ disabledSkills: ["reviewer"] }), "utf8");

  const settings = await loadSkillSettings({ cwd: fixture.cwd, homeDir: fixture.home });

  expect(settings.disabledSkillNames).toEqual(["reviewer", "writer"]);
});

test("skill settings update project disabled names", async () => {
  const fixture = await tempFixture();

  await updateSkillDisabledSetting({
    cwd: fixture.cwd,
    homeDir: fixture.home,
    scope: "project",
    name: "reviewer",
    disabled: true,
  });
  expect(await loadSkillSettings({ cwd: fixture.cwd, homeDir: fixture.home })).toMatchObject({
    disabledSkillNames: ["reviewer"],
  });

  await updateSkillDisabledSetting({
    cwd: fixture.cwd,
    homeDir: fixture.home,
    scope: "project",
    name: "reviewer",
    disabled: false,
  });
  expect(JSON.parse(await readFile(path.join(fixture.cwd, ".chili", "skills.json"), "utf8"))).toEqual({ disabled: [] });
});

async function tempFixture(): Promise<{ root: string; cwd: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "chili-skill-settings-"));
  return {
    root,
    cwd: path.join(root, "repo"),
    home: path.join(root, "home"),
  };
}
