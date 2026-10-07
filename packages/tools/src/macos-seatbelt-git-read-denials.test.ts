import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import type { BashRunRequest } from "./builtins/bash.js";
import { createMacOsSeatbeltBashRunner } from "./macos-seatbelt.js";
import { runProcess } from "./process.js";

const macOsTest = process.platform === "darwin" ? test : test.skip;
const secret = "historical-secret-content";

macOsTest("resource read denials block historical and renamed Git blobs while allowing ordinary files", async () => {
  const workspace = await createRepository();
  try {
    const runner = createMacOsSeatbeltBashRunner();
    const request = bashRequest(workspace, "cat public.txt");
    const allowed = await runner.run(request);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("public");

    for (const command of [
      "git show HEAD~1:secret.txt",
      "git show HEAD:renamed.txt",
      "git cat-file blob HEAD:renamed.txt",
      "cat .git/HEAD",
    ]) {
      const denied = await runner.run({ ...request, command });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain(secret);
    }

    const { resourceDenials: _readDenials, ...unrestrictedRequest } = request;
    for (const resourceDenials of [undefined, { readPaths: [], writePaths: [join(workspace, "secret.txt")] }]) {
      const unrestricted = await runner.run({
        ...unrestrictedRequest,
        command: "git show HEAD:renamed.txt",
        ...(resourceDenials ? { resourceDenials } : {}),
      });
      expect(unrestricted.exitCode).toBe(0);
      expect(unrestricted.stdout.trim()).toBe(secret);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

macOsTest("resource read denials cover linked worktree metadata and the shared Git object database", async () => {
  const workspace = await createRepository();
  const worktree = `${workspace}-linked`;
  try {
    await git(workspace, "worktree", "add", "--detach", worktree);
    const commonDir = await realpath(join(workspace, ".git"));
    const pointer = (await readFile(join(worktree, ".git"), "utf8")).trim().slice("gitdir: ".length);
    const gitDir = await realpath(resolve(worktree, pointer));
    const runner = createMacOsSeatbeltBashRunner();
    for (const command of [
      "git show HEAD~1:secret.txt",
      "git show HEAD:renamed.txt",
      `git --git-dir=${shellQuote(commonDir)} show HEAD:renamed.txt`,
      `cat ${shellQuote(join(gitDir, "HEAD"))}`,
    ]) {
      const denied = await runner.run(bashRequest(worktree, command));
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain(secret);
    }
    const allowed = await runner.run(bashRequest(worktree, "cat public.txt"));
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("public");
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

macOsTest("resource read denials protect ancestor repository history for subdirectory workspaces", async () => {
  const repository = await createRepository();
  const workspace = join(repository, "subdir");
  try {
    await mkdir(workspace);
    await writeFile(join(workspace, "secret.txt"), `${secret}\n`);
    await writeFile(join(workspace, "public.txt"), "public\n");
    await git(repository, "add", "subdir");
    await git(repository, "commit", "--quiet", "-m", "add subdirectory files");
    const runner = createMacOsSeatbeltBashRunner();
    const denied = await runner.run(bashRequest(workspace, "git show HEAD:subdir/secret.txt"));
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).not.toContain(secret);
    const allowed = await runner.run(bashRequest(workspace, "cat public.txt"));
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("public");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}, 15_000);

macOsTest("resource read denials block ordinary nested Git metadata and moving it to a readable alias", async () => {
  const repository = await createRepository();
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-nested-git-"));
  try {
    await rename(repository, join(workspace, "nested"));
    const runner = createMacOsSeatbeltBashRunner();
    for (const command of [
      "git -C nested show HEAD:renamed.txt",
      "mv nested/.git nested/metadata && git --git-dir=nested/metadata show HEAD:renamed.txt",
    ]) {
      const denied = await runner.run({
        ...bashRequest(workspace, command),
        resourceDenials: { readPaths: [join(workspace, "nested", "renamed.txt")], writePaths: [] },
      });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain(secret);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
}, 15_000);

macOsTest("resource read denials cover symlinked Git directories and object-store targets", async () => {
  const workspace = await createRepository();
  try {
    const blob = (await git(workspace, "rev-parse", "HEAD:renamed.txt")).trim();
    await rename(join(workspace, ".git"), join(workspace, "git-metadata"));
    await symlink("git-metadata", join(workspace, ".git"));
    await rename(join(workspace, "git-metadata", "objects"), join(workspace, "object-store"));
    await symlink("../object-store", join(workspace, "git-metadata", "objects"));
    const runner = createMacOsSeatbeltBashRunner();
    for (const command of [
      "git show HEAD:renamed.txt",
      "cat git-metadata/HEAD",
      `cat object-store/${blob.slice(0, 2)}/${blob.slice(2)}`,
    ]) {
      const denied = await runner.run(bashRequest(workspace, command));
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).toBe("");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

test("resource read denials fail closed for unsupported Git alternate object databases", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-alternates-"));
  let processCalls = 0;
  try {
    await mkdir(join(workspace, ".git", "objects", "info"), { recursive: true });
    await writeFile(join(workspace, ".git", "objects", "info", "alternates"), "/another/object-store\n");
    const runner = createMacOsSeatbeltBashRunner({
      processRunner: async () => {
        processCalls += 1;
        throw new Error("must not launch");
      },
    });
    await expect(runner.run(bashRequest(workspace, "cat public.txt"))).rejects.toThrow("Git alternate object databases");
    expect(processCalls).toBe(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("read-only Git execution blocks fsmonitor callback writes despite an existing file write scope", async () => {
  const workspace = await createRepository();
  try {
    const agentsPath = join(workspace, "AGENTS.md");
    await writeFile(agentsPath, "original instructions\n");
    const monitorPath = join(workspace, "monitor.sh");
    await writeFile(monitorPath, "#!/bin/sh\nprintf changed > AGENTS.md\nprintf 'monitor invoked\\n' >&2\nprintf 'token\\0'\n");
    await chmod(monitorPath, 0o755);
    await git(workspace, "config", "core.fsmonitor", "./monitor.sh");
    const runner = createMacOsSeatbeltBashRunner();
    const { resourceDenials: _denials, ...baseRequest } = bashRequest(workspace, "git status --porcelain");
    const request = {
      ...baseRequest,
      executionPolicy: { writeScope: ["AGENTS.md"], executeScope: [] },
    };

    const writable = await runner.run(request);
    expect(writable.readOnly).toBe(false);
    expect(writable.stderr).toContain("monitor invoked");
    expect(await readFile(agentsPath, "utf8")).toBe("changed");

    await writeFile(agentsPath, "original instructions\n");
    const readOnly = await runner.run({ ...request, readOnly: true });
    expect(readOnly.readOnly).toBe(true);
    expect(readOnly.exitCode).toBe(0);
    expect(readOnly.stderr).toContain("monitor invoked");
    expect(readOnly.stderr).toContain("Operation not permitted");
    expect(await readFile(agentsPath, "utf8")).toBe("original instructions\n");

    const allowed = await runner.run({ ...request, readOnly: true, command: "cat public.txt" });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("public");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

async function createRepository(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-git-reads-"));
  try {
    await git(workspace, "init", "--quiet");
    await writeFile(join(workspace, "secret.txt"), `${secret}\n`);
    await writeFile(join(workspace, "public.txt"), "public\n");
    await git(workspace, "add", "secret.txt", "public.txt");
    await git(workspace, "commit", "--quiet", "-m", "initial");
    await git(workspace, "mv", "secret.txt", "renamed.txt");
    await git(workspace, "commit", "--quiet", "-m", "rename secret");
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-c", "user.name=Seatbelt Test", "-c", "user.email=seatbelt@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
  });
  if (result.exitCode !== 0) throw new Error(`Git fixture failed: ${result.stderr}`);
  return result.stdout;
}

function bashRequest(workspace: string, command: string): BashRunRequest {
  return {
    command,
    workspaceRoot: workspace,
    cwd: workspace,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    sandboxPermissions: "use_default",
    signal: new AbortController().signal,
    onOutput: undefined,
    resourceDenials: { readPaths: [join(workspace, "secret.txt")], writePaths: [] },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
