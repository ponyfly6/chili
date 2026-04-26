import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "chili-p3-agent-tree-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p3-agent-tree-smoke" }, null, 2), "utf8");

  const initial = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "delegate read"]);
  const taskId = /\[task\]\s+(task_[^\s]+)/.exec(initial.stdout)?.[1];
  assert.ok(taskId, initial.stdout);

  const agents = await runCli(["--model", "fake", "--cwd", workspace, "agents"]);
  assert.match(agents.stdout, new RegExp(`/root/${taskId}\\tcompleted`));

  await runCli(["--model", "fake", "--yes", "--cwd", workspace, "followup", taskId, "continue the task"]);

  const mailbox = await runCli(["--model", "fake", "--cwd", workspace, "mailbox"]);
  const messageId = /^(event_[^\t]+)/m.exec(mailbox.stdout)?.[1];
  assert.ok(messageId, mailbox.stdout);

  const consumed = await runCli(["--model", "fake", "--cwd", workspace, "consume", messageId]);
  assert.match(consumed.stdout, new RegExp(`\\[mailbox\\] ${messageId}\\tconsumed`));

  const emptyMailbox = await runCli(["--model", "fake", "--cwd", workspace, "mailbox"]);
  assert.match(emptyMailbox.stdout, /No mailbox messages/);
  console.log("P3 agent tree smoke ok");
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
