import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "chili-p3-team-model-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p3-team-model-smoke" }, null, 2), "utf8");

  const initial = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "team parallel tool loop"]);
  assert.match(initial.stdout, /\[tool\] team_create/);
  assert.match(initial.stdout, /\[tool\] team_member_add/);
  assert.match(initial.stdout, /\[tool\] team_task_create_batch/);
  assert.match(initial.stdout, /\[tool\] team_run_loop/);
  assert.match(initial.stdout, /Team parallel tool loop works/);

  const reconciled = await runCli(["--model", "fake", "--cwd", workspace, "team-reconcile", "team_fake_parallel"]);
  const reconcileJson = JSON.parse(jsonObjectFromOutput(reconciled.stdout)) as { synced?: unknown[]; errors?: unknown[] };
  assert.equal(reconcileJson.errors?.length ?? 0, 0, reconciled.stdout);
  assert.equal(reconcileJson.synced?.length, 2, reconciled.stdout);

  const tasks = await runCli(["--model", "fake", "--cwd", workspace, "team-tasks", "team_fake_parallel"]);
  assert.match(tasks.stdout, /task_core\tcompleted/);
  assert.match(tasks.stdout, /task_docs\tcompleted/);
  console.log("P3 team model smoke ok");
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

function jsonObjectFromOutput(output: string): string {
  const start = output.indexOf("{");
  assert.ok(start >= 0, output);
  return output.slice(start);
}
