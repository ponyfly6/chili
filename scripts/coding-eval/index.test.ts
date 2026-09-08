import { expect, test } from "bun:test";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const entry = join(import.meta.dir, "index.ts");

async function run(args: string[], cwd = process.cwd()) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const historyAvailable = (await run(["git", "cat-file", "-e", "ee637fccd8998175f1eac4a3113740cfee26578c^{commit}"], join(import.meta.dir, "../.."))).exitCode === 0;

(historyAvailable ? test : test.skip)("coding evaluation isolates history and restores external checks after candidate test edits", async () => {
  const prepared = await run([process.execPath, "run", entry, "prepare", "mcp-operation-deadline"]);
  expect(prepared.exitCode).toBe(0);
  const { runDirectory, workspace } = JSON.parse(prepared.stdout) as { runDirectory: string; workspace: string };
  try {
    const history = await run(["git", "rev-list", "--count", "HEAD"], workspace);
    expect(history.stdout.trim()).toBe("1");
    const remotes = await run(["git", "remote"], workspace);
    expect(remotes.stdout.trim()).toBe("");
    const missingAcceptance = await Bun.file(join(workspace, "packages/mcp/src/manager-timeout.test.ts")).exists();
    expect(missingAcceptance).toBe(false);

    // A candidate claiming success by replacing its own regression tests does
    // not replace the evaluator's pinned regression or acceptance tests.
    const path = join(workspace, "packages/mcp/src/manager.test.ts");
    const weakened = 'import { test, expect } from "bun:test"; test("always passes", () => expect(true).toBe(true));\n';
    await writeFile(path, weakened);
    const observedHomes = join(runDirectory, "observed-homes.txt");
    const managerPath = join(workspace, "packages/mcp/src/manager.ts");
    const managerSource = await readFile(managerPath, "utf8");
    await writeFile(managerPath, `import { appendFileSync as codingEvalRecordHome } from "node:fs";\ncodingEvalRecordHome(${JSON.stringify(observedHomes)}, (process.env.HOME ?? "") + "\\n");\n${managerSource}`);
    const verified = await run([process.execPath, "run", entry, "verify", runDirectory]);
    expect(verified.exitCode).toBe(1);
    const result = JSON.parse(verified.stdout) as {
      passed: boolean;
      modelRun: null;
      regression: { passed: boolean; passedTests: number };
      acceptance: { passed: boolean; failedTests: number; timedOut: boolean };
    };
    expect(result.passed).toBe(false);
    expect(result.modelRun).toBeNull();
    expect(result.regression.passed).toBe(true);
    expect(result.regression.passedTests).toBeGreaterThan(1);
    expect(result.acceptance.passed).toBe(false);
    expect(result.acceptance.failedTests).toBe(4);
    expect(result.acceptance.timedOut).toBe(false);
    const homes = (await readFile(observedHomes, "utf8")).trim().split("\n");
    expect(homes).toHaveLength(2);
    expect(new Set(homes).size).toBe(2);
    for (const home of homes) {
      expect(home.startsWith("/tmp/chili-coding-eval-home-")).toBe(true);
      await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path, "utf8")).toBe(weakened);
    expect(await Bun.file(join(workspace, "packages/mcp/src/manager-timeout.test.ts")).exists()).toBe(false);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}, 60_000);
