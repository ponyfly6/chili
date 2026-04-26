import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "chili-p3-agent-tree-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p3-agent-tree-smoke" }, null, 2), "utf8");

  const initial = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "delegate read"]);
  const sessionId = /\[session\]\s+(session_[^\s]+)/.exec(initial.stdout)?.[1];
  assert.ok(sessionId, initial.stdout);
  const taskId = /\[task\]\s+(task_[^\s]+)/.exec(initial.stdout)?.[1];
  assert.ok(taskId, initial.stdout);

  const agents = await runCli(["--model", "fake", "--cwd", workspace, "agents"]);
  assert.match(agents.stdout, new RegExp(`/root/${taskId}\\tcompleted`));

  const toolList = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "--resume", sessionId, "list tasks through tool"]);
  assert.match(toolList.stdout, /\[tool\] task_list/);
  assert.match(toolList.stdout, new RegExp(taskId));

  const toolWait = await runCli(["--model", "fake", "--yes", "--cwd", workspace, "--resume", sessionId, "wait task", taskId]);
  assert.match(toolWait.stdout, /\[tool\] task_wait/);
  assert.match(toolWait.stdout, new RegExp(taskId));

  const toolMailbox = await runCli([
    "--model",
    "fake",
    "--yes",
    "--cwd",
    workspace,
    "--resume",
    sessionId,
    "list mailbox through tool",
  ]);
  assert.match(toolMailbox.stdout, /\[tool\] mailbox_list/);
  assert.match(toolMailbox.stdout, /"count":0/);

  const toolFollowup = await runCli([
    "--model",
    "fake",
    "--yes",
    "--cwd",
    workspace,
    "--resume",
    sessionId,
    "followup task",
    taskId,
  ]);
  assert.match(toolFollowup.stdout, /\[tool\] task_followup/);
  assert.match(toolFollowup.stdout, new RegExp(`\\[task\\] ${taskId}: completed`));

  await runCli(["--model", "fake", "--yes", "--cwd", workspace, "followup", taskId, "continue the task"]);

  const mailbox = await runCli(["--model", "fake", "--cwd", workspace, "mailbox"]);
  assert.match(mailbox.stdout, /No mailbox messages/);
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
