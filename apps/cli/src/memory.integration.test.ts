import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

async function runMemory(cwd: string, profile: string, args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url)), "--cwd", cwd, "--chili-home", profile, "memory", ...args],
    cwd,
    env: { ...process.env, CHILI_HOME: profile, CHILI_PROVIDER: "not-needed-for-memory", CHILI_MODEL: "not-needed-for-memory" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return stdout;
}

function savedPath(output: string): string {
  const path = /^\[memory\] saved (?:user|project): (.+)$/m.exec(output)?.[1];
  expect(path).toBeDefined();
  if (!path) throw new Error(`Missing saved Memory path: ${output}`);
  expect(path.endsWith(".md")).toBe(true);
  return path;
}

test("CLI Memory reads current Markdown files with personal/project isolation and no runtime database", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-memory-files-"));
  const cwd = join(root, "project-a");
  const otherCwd = join(root, "project-b");
  const profile = join(root, "profile");
  try {
    await mkdir(cwd);
    await mkdir(otherCwd);
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTIONS_ARE_NOT_MEMORY");
    expect(await runMemory(cwd, profile, ["show"])).toContain("No Memory Markdown files found");

    const longPersonalMemory = `# Personal preference\n\n${"Keep the complete original text. ".repeat(100)}PERSONAL_END_MARKER`;
    const personalPath = savedPath(await runMemory(cwd, profile, ["add", "--user", longPersonalMemory]));
    const projectPath = savedPath(await runMemory(cwd, profile, ["add", "--project", "PROJECT_A_FACT"]));
    const otherProjectPath = savedPath(await runMemory(otherCwd, profile, ["add", "--project", "PROJECT_B_FACT"]));
    expect(projectPath).not.toBe(otherProjectPath);
    expect((await readFile(personalPath, "utf8")).trim()).toBe(longPersonalMemory);

    const all = await runMemory(cwd, profile, ["show", "--all"]);
    expect(all).toContain("PERSONAL_END_MARKER");
    expect(all).toContain("PROJECT_A_FACT");
    expect(all).not.toContain("PROJECT_B_FACT");
    expect(all).not.toContain("PROJECT_INSTRUCTIONS_ARE_NOT_MEMORY");
    const projectOnly = await runMemory(cwd, profile, ["show", "--project"]);
    expect(projectOnly).toContain("PROJECT_A_FACT");
    expect(projectOnly).not.toContain("PERSONAL_END_MARKER");
    const other = await runMemory(otherCwd, profile, ["show", "--all"]);
    expect(other).toContain("PERSONAL_END_MARKER");
    expect(other).toContain("PROJECT_B_FACT");
    expect(other).not.toContain("PROJECT_A_FACT");

    await writeFile(personalPath, "UPDATED_PERSONAL_FACT\n");
    const updated = await runMemory(cwd, profile, ["show", "--user"]);
    expect(updated).toContain("UPDATED_PERSONAL_FACT");
    expect(updated).not.toContain("PERSONAL_END_MARKER");
    expect(updated).not.toContain("PROJECT_A_FACT");
    await rm(personalPath);
    expect(await runMemory(cwd, profile, ["show", "--user"])).not.toContain("UPDATED_PERSONAL_FACT");

    const profileFiles = await readdir(profile, { recursive: true });
    expect(profileFiles.some((file) => /\.sqlite(?:-|$)/.test(file))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("CLI Memory neither reads nor changes retired SQLite and Markdown locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-memory-no-legacy-"));
  const cwd = join(root, "workspace");
  const profile = join(root, "profile");
  const retiredDatabase = join(profile, "memory.sqlite");
  const retiredProjectFile = join(cwd, ".chili", "memory.md");
  try {
    await mkdir(profile);
    await mkdir(dirname(retiredProjectFile), { recursive: true });
    const databaseBytes = Buffer.from("Not a database: this retired file must never be opened as SQLite");
    await writeFile(retiredDatabase, databaseBytes);
    await writeFile(retiredProjectFile, "RETIRED_PROJECT_MARKER");
    await writeFile(join(profile, "memory.md"), "RETIRED_USER_MARKER");
    const shown = await runMemory(cwd, profile, ["show", "--all"]);
    expect(shown).toContain("No Memory Markdown files found");
    expect(shown).not.toContain("RETIRED_");
    const newPath = savedPath(await runMemory(cwd, profile, ["add", "--user", "NEW_MARKDOWN_FACT"]));
    expect(await readFile(newPath, "utf8")).toContain("NEW_MARKDOWN_FACT");
    expect(await readFile(retiredDatabase)).toEqual(databaseBytes);
    expect(await readFile(retiredProjectFile, "utf8")).toBe("RETIRED_PROJECT_MARKER");
    expect(await readFile(join(profile, "memory.md"), "utf8")).toBe("RETIRED_USER_MARKER");
    expect((await readdir(profile, { recursive: true })).filter((file) => /\.sqlite(?:-|$)/.test(file))).toEqual(["memory.sqlite"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
