import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "chili-p2-subagent-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p2-subagent-smoke" }, null, 2), "utf8");
  const proc = Bun.spawn(["bun", "run", "cli", "--", "--model", "fake", "--yes", "--cwd", workspace, "delegate read"], {
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
  assert.match(stdout, /\[task\] task_/);
  assert.match(stdout, /\[agent\] spawned \/root\/task_/);
  assert.match(stdout, /\[agent\] completed \/root\/task_.*completed/);
  assert.match(stdout, /I read the file and the tool loop works/);
  console.log("P2 subagent smoke ok");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
