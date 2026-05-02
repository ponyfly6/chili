import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { listSkillResourceFiles } from "./resources.js";

test("skill resource listing skips hidden, large, node_modules, and SKILL.md files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chili-skill-resources-"));
  const skillDir = path.join(root, "skill");
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await mkdir(path.join(skillDir, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(skillDir, ".hidden"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "body\n", "utf8");
  await writeFile(path.join(skillDir, "scripts", "run.ts"), "export {};\n", "utf8");
  await writeFile(path.join(skillDir, ".DS_Store"), "junk\n", "utf8");
  await writeFile(path.join(skillDir, ".hidden", "secret.txt"), "secret\n", "utf8");
  await writeFile(path.join(skillDir, "node_modules", "pkg", "index.js"), "module\n", "utf8");
  await writeFile(path.join(skillDir, "big.bin"), "x".repeat(20), "utf8");

  const listing = await listSkillResourceFiles(skillDir, { maxFileBytes: 15 });

  expect(listing.files).toEqual([{ path: "scripts/run.ts", bytes: 11 }]);
  expect(listing.omittedHidden).toBe(2);
  expect(listing.omittedLarge).toBe(1);
  expect(listing.truncated).toBe(false);
});

test("skill resource listing marks file budget truncation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chili-skill-resources-"));
  const skillDir = path.join(root, "skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "a.txt"), "a", "utf8");
  await writeFile(path.join(skillDir, "b.txt"), "b", "utf8");

  const listing = await listSkillResourceFiles(skillDir, { maxFiles: 1 });

  expect(listing.files).toEqual([{ path: "a.txt", bytes: 1 }]);
  expect(listing.truncated).toBe(true);
});
