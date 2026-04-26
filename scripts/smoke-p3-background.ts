import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "chili-p3-background-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p3-background-smoke" }, null, 2), "utf8");

  const initial = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "delegate background read"]);
  const taskId = /\[task\]\s+(task_[^\s]+)/.exec(initial.stdout)?.[1];
  assert.ok(taskId, initial.stdout);
  assert.match(initial.stdout, new RegExp(`\\[task\\] ${taskId}: completed`));

  const listed = await runCli(["--model", "fake", "--cwd", workspace, "tasks"]);
  assert.match(listed.stdout, new RegExp(`${taskId}\\tcompleted`));

  const waited = await runCli(["--model", "fake", "--cwd", workspace, "wait", taskId, "--timeout-ms", "5000"]);
  assert.match(waited.stdout, new RegExp(`\\[task\\] ${taskId}\\tcompleted`));
  console.log("P3 background smoke ok");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "cli", "--", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assert.equal(code, 0, stderr);
  return { stdout, stderr };
}
