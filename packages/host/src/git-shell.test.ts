import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import {
  createBashTool, InMemoryToolRegistry, runProcess, ToolExecutor,
  type ToolReviewRequest, type BashInput, type ExecuteToolResult,
} from "@chili/tools";
import { createHostBashRunner } from "./bash-runner.js";

const macOsTest = process.platform === "darwin" ? test : test.skip;

macOsTest("Git through Bash reviews each action and preserves hooks and unrelated work", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "chili-git-shell-")));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Git shell test"]);
    await git(cwd, ["config", "user.email", "git-shell@example.invalid"]);
    await git(cwd, ["config", "commit.gpgSign", "false"]);
    await git(cwd, ["config", "core.hooksPath", join(cwd, ".git", "hooks")]);
    await writeFile(join(cwd, "tracked.txt"), "initial\n");
    await git(cwd, ["add", "tracked.txt"]);
    await git(cwd, ["commit", "-m", "Initial"]);
    await writeFile(join(cwd, "tracked.txt"), "user work\n");
    await writeFile(join(cwd, "next file.txt"), "agent work\n");

    const approvals: ToolReviewRequest[] = [];
    const events: ChiliEvent[] = [];
    let allow = false;
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({ runner: createHostBashRunner({ permissionProfile: () => "auto-review" }) }));
    const executor = new ToolExecutor({
      registry,
      events: { publish: async (event) => { events.push(event); } },
      gate: { review: async (request) => {
        approvals.push(request);
        return { decision: allow ? "allow" : "deny", reason: "Fixture review" };
      } },
      now: () => Date.now() as TimestampMs,
    });
    const execute = (input: BashInput) => executor.execute({
      sessionId: "session_git_shell" as SessionId,
      turnId: "turn_git_shell" as TurnId,
      toolName: "bash", cwd, input,
    });

    allow = true;
    const inspected = await execute({ command: "git --no-optional-locks status --short" });
    expect(completed(inspected).structuredData).toMatchObject({ exitCode: 0 });
    expect(completed(inspected).output).toContain("tracked.txt");
    expect(events.some((event) => event.type === "tool.call_updated"
      && event.payload.callId === inspected.callId && event.payload.metadata?.sandbox === "none")).toBe(true);
    expect(approvals).toHaveLength(1);

    allow = false;
    const commit: BashInput = {
      command: "git add -- 'next file.txt' && git commit -m 'Add next file'",
    };
    expect((await execute(commit)).status).toBe("failed");
    expect(approvals).toHaveLength(2);
    expect(await git(cwd, ["diff", "--cached"])).toBe("");

    const hook = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf hook-ran > hook-result\nexit 1\n");
    await chmod(hook, 0o755);
    allow = true;
    const originalHead = await git(cwd, ["rev-parse", "HEAD"]);
    const rejectedByHook = await execute(commit);
    expect(completed(rejectedByHook).structuredData).not.toMatchObject({ exitCode: 0 });
    expect(await readFile(join(cwd, "hook-result"), "utf8")).toBe("hook-ran");
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(originalHead);
    await writeFile(hook, "#!/bin/sh\nprintf hook-ran > hook-result\n");
    const committed = await execute(commit);
    expect(completed(committed).structuredData).toMatchObject({ exitCode: 0 });
    expect(completed(committed).metadata).toMatchObject({ readOnly: false, sandbox: "none" });
    expect(approvals).toHaveLength(4);
    expect(approvals.every((request) => request.toolName === "bash")).toBe(true);
    expect(approvals.at(-1)?.input).toMatchObject({ command: commit.command });
    expect((await git(cwd, ["log", "-1", "--format=%B"])).trim()).toBe("Add next file");
    expect(await git(cwd, ["show", "HEAD:next file.txt"])).toBe("agent work\n");
    expect(await git(cwd, ["show", "HEAD:tracked.txt"])).toBe("initial\n");
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("user work\n");

    // Repository signing is attempted; Bash does not inject --no-gpg-sign.
    const signer = join(cwd, "signer");
    await writeFile(signer, "#!/bin/sh\nprintf signing-attempted > signing-result\nexit 1\n");
    await chmod(signer, 0o755);
    await git(cwd, ["config", "commit.gpgSign", "true"]);
    await git(cwd, ["config", "gpg.format", "openpgp"]);
    await git(cwd, ["config", "gpg.program", signer]);
    const signed = await execute({ ...commit, command: "git commit --allow-empty -m 'Signed commit'" });
    expect(completed(signed).structuredData).not.toMatchObject({ exitCode: 0 });
    expect(await readFile(join(cwd, "signing-result"), "utf8")).toBe("signing-attempted");
    expect((await git(cwd, ["log", "-1", "--format=%s"])).trim()).toBe("Add next file");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

macOsTest("automatic review can reject git clean before it deletes an untracked file", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "chili-git-shell-deny-")));
  try {
    await git(cwd, ["init", "-b", "main"]);
    await writeFile(join(cwd, "keep.txt"), "keep\n");
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({ runner: createHostBashRunner({ permissionProfile: () => "auto-review" }) }));
    const executor = new ToolExecutor({ registry, events: { publish: async () => undefined },
      gate: { review: async (request) => {
        expect(request.input).toMatchObject({ command: "git clean -fd" });
        return { decision: "deny", reason: "Untracked user files were not requested for deletion." };
      } },
    });
    const result = await executor.execute({ sessionId: "session_git_shell_deny" as SessionId,
      turnId: "turn_git_shell_deny" as TurnId, toolName: "bash", cwd, input: { command: "git clean -fd" } });
    expect(result.status).toBe("failed");
    expect(await readFile(join(cwd, "keep.txt"), "utf8")).toBe("keep\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

function completed(result: ExecuteToolResult) {
  if (result.status !== "completed") throw result.error;
  return result.result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 5_000, maxOutputBytes: 64_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}
