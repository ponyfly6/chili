import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

test("CLI skills and memory use the selected Host profile across independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-profiles-"));
  const cwd = join(root, "workspace");
  const profileA = join(root, "profile-a");
  const profileB = join(root, "profile-b");
  try {
    await mkdir(cwd);
    for (const [profile, name] of [[profileA, "profile-a-skill"], [profileB, "profile-b-skill"]] as const) {
      await mkdir(join(profile, "skills", name), { recursive: true });
      await writeFile(join(profile, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Profile test skill\n---\nOnly this profile may see this skill.`);
    }
    const run = async (args: string[]) => {
      const child = Bun.spawn({
        cmd: [process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url)), "--cwd", cwd, ...args],
        cwd,
        env: { ...process.env, CHILI_HOME: profileA },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return stdout;
    };

    expect(await run(["skills", "list", "--json"])).toContain("profile-a-skill");
    const selected = await run(["skills", "list", "--json", "--chili-home", profileB]);
    expect(selected).toContain("profile-b-skill");
    expect(selected).not.toContain("profile-a-skill");
    await run(["skills", "disable", "profile-b-skill", "--user", "--chili-home", profileB]);
    expect(JSON.parse(await readFile(join(profileB, "skills.json"), "utf8"))).toEqual({ disabled: ["profile-b-skill"] });
    await expect(readFile(join(profileA, "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const isolatedMemory = "Memory visible only in profile B";
    await run(["--model", "fake", "--no-mcp", "memory", "add", "--user", "--chili-home", profileB, isolatedMemory]);
    expect(await run(["--model", "fake", "--no-mcp", "memory", "show", "--user", "--chili-home", profileB])).toContain(isolatedMemory);
    expect(await run(["--model", "fake", "--no-mcp", "memory", "show", "--user"])).not.toContain(isolatedMemory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
