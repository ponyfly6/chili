import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@chili/policy";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { PolicyApprovalBroker } from "./approval.js";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadImageTool } from "./builtins/read-image.js";
import { createBashTool } from "./builtins/bash.js";
import { createGitWorktreeTool } from "./builtins/git-worktree.js";
import { createGitApplyPatchTool } from "./builtins/git-apply-patch.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { observeProcessGuardianLifecycle, runProcess } from "./process.js";
import type { ToolAccessPolicy } from "./types.js";

const secret = "PRIVATE_MARKER_c065751adf";

function harness(rules: () => readonly PermissionRule[], events: ChiliEvent[] = [], policy?: ToolAccessPolicy, ask?: () => Promise<{ action: "allow_session" }>): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of [createGlobTool(), createGrepTool(), createReadImageTool(), createBashTool(), createGitWorktreeTool(), createGitApplyPatchTool()]) registry.register(tool);
  const approvals = new PolicyApprovalBroker({ rulesetsForRequest: () => [rules()], ...(ask ? { ask } : {}) });
  return new ToolExecutor({
    registry, approvals, events: { publish: async (event) => { events.push(event); } },
    ...(policy ? { policyResolver: { resolve: () => policy } } : {}),
  });
}

function call(executor: ToolExecutor, cwd: string, toolName: string, input: unknown) {
  return executor.execute({ cwd, toolName, input, sessionId: "resource_session" as SessionId, turnId: "turn" as TurnId });
}

function rules(permission: string): PermissionRule[] {
  return [{ permission: "*", pattern: "*", action: "allow" }, { permission, pattern: "*", action: "deny" }];
}

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "chili-discovery-resources-"));
  try {
    await writeFile(join(cwd, "blocked.txt"), `${secret}\nshared needle\n`);
    await writeFile(join(cwd, "visible.txt"), "public needle\n");
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const permission of ["read", "grep", "glob"]) {
  test(`${permission} resource deny applies to broad grep and glob before content or names escape`, async () => {
    await withWorkspace(async (cwd) => {
      const events: ChiliEvent[] = [];
      const executor = harness(() => rules(`${permission}(blocked.txt)`), events);
      const grep = await call(executor, cwd, "grep", { pattern: "needle" });
      expect(grep.status).toBe("completed");
      if (grep.status === "completed") {
        expect(grep.result.output).toContain("visible.txt");
        expect(grep.result.output).not.toContain("blocked.txt");
        expect(grep.result.output).not.toContain(secret);
      }
      const glob = await call(executor, cwd, "glob", { pattern: "*.txt" });
      expect(glob.status).toBe("completed");
      if (glob.status === "completed") {
        expect(glob.result.output).toContain("visible.txt");
        expect(glob.result.output).not.toContain("blocked.txt");
      }
      expect(JSON.stringify(events)).not.toContain(secret);
      const outputs = events.filter((event) => event.type === "tool.call_finished");
      expect(JSON.stringify(outputs)).not.toContain("blocked.txt");
    });
  });
}

test("recursive discovery resolves denied file aliases and an explicit directory prefix", async () => {
  await withWorkspace(async (cwd) => {
    await mkdir(join(cwd, "nested"));
    await rename(join(cwd, "blocked.txt"), join(cwd, "nested", "private.txt"));
    await writeFile(join(cwd, "nested", "public.txt"), "public needle");
    await symlink(join(cwd, "nested"), join(cwd, "alias"));
    const executor = harness(() => rules(`read(${join(cwd, "nested", "private.txt")})`));
    for (const path of ["./nested", join(cwd, "nested"), "alias"]) {
      const result = await call(executor, cwd, "grep", { pattern: "needle", path });
      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.result.output).toContain("public.txt");
        expect(result.result.output).not.toContain("private.txt");
        expect(result.result.output).not.toContain(secret);
      }
    }
    const glob = await call(executor, cwd, "glob", { pattern: "**/*.txt", path: "alias" });
    expect(glob.status).toBe("completed");
    if (glob.status === "completed") expect(glob.result.output).not.toContain("private.txt");
  });
});

test("a new resource deny defeats an older broad search approval", async () => {
  await withWorkspace(async (cwd) => {
    let active: PermissionRule[] = [{ permission: "*", pattern: "*", action: "ask" }];
    const executor = harness(() => active, [], undefined, async () => ({ action: "allow_session" }));
    const initial = await call(executor, cwd, "grep", { pattern: "needle" });
    expect(initial.status).toBe("completed");
    if (initial.status === "completed") expect(initial.result.output).toContain("blocked.txt");
    active = [...active, { permission: "read(blocked.txt)", pattern: "*", action: "deny" }];
    const after = await call(executor, cwd, "grep", { pattern: "needle" });
    expect(after.status).toBe("completed");
    if (after.status === "completed") {
      expect(after.result.output).toContain("visible.txt");
      expect(after.result.output).not.toContain("blocked.txt");
    }
  });
});

test("image reads honor resource denies from other read-tool permission names", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "private.png"), Buffer.from(secret));
    for (const name of ["read", "grep", "glob"]) {
      const executor = harness(() => rules(`${name}(private.png)`));
      const result = await call(executor, cwd, "read_image", { filePath: "./private.png" });
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(Buffer.from(secret).toString("base64"));
    }
  });
});

test("Bash Git broad, selected-path, renamed historical and status reads require an enforcing resource sandbox", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await git(cwd, ["mv", "blocked.txt", "renamed.txt"]);
    await writeFile(join(cwd, "renamed.txt"), "new contents");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "renamed"]);
    const events: ChiliEvent[] = [];
    const executor = harness(() => rules("read(blocked.txt)"), events);
    for (const command of ["git diff", "git diff HEAD~1 -- renamed.txt", "git diff --staged", "git status"]) {
      const result = await call(executor, cwd, "bash", { command });
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

test("Bash Git mutations and hooks cannot bypass file write denies or an empty scoped policy", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await git(cwd, ["branch", "other"]);
    await writeFile(join(cwd, "visible.txt"), "staged update");
    await git(cwd, ["add", "visible.txt"]);
    const hook = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf hook > hook-ran.txt\n");
    await chmod(hook, 0o755);
    for (const executor of [
      harness(() => rules("write(blocked.txt)")),
      harness(() => [{ permission: "*", pattern: "*", action: "allow" }], [], { writeScope: [], executeScope: [], allowedTools: ["bash"] }),
    ]) {
      for (const command of ["git switch other", "git add --all", "git commit -m 'must not run hooks'"]) {
        expect((await call(executor, cwd, "bash", { command })).status).toBe("failed");
      }
    }
    expect((await git(cwd, ["branch", "--show-current"])).trim()).toBe("main");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("baseline");
    await expect(access(join(cwd, "hook-ran.txt"))).rejects.toThrow();
    expect(await readFile(join(cwd, "blocked.txt"), "utf8")).toContain(secret);
  });
});

test("discovery loads resource rules per batch rather than once per candidate", async () => {
  await withWorkspace(async (cwd) => {
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(cwd, `candidate-${index}.txt`), "public needle\n")));
    let ruleLoads = 0;
    const executor = harness(() => { ruleLoads++; return rules("read(blocked.txt)"); });
    for (const [tool, input] of [["grep", { pattern: "needle", headLimit: 500 }], ["glob", { pattern: "*.txt", limit: 500 }]] as const) {
      ruleLoads = 0;
      const result = await call(executor, cwd, tool, input);
      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.result.output).toContain("candidate-199.txt");
        expect(result.result.output).not.toContain("blocked.txt");
      }
      expect(ruleLoads).toBeLessThan(60);
    }
  });
});

test("managed Git tools recheck write revocation immediately before dispatching each process", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    let active: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
    let started = 0;
    const stop = observeProcessGuardianLifecycle((event) => {
      if (event.type !== "started" || event.cwd !== cwd) return;
      started++;
      active = rules("write(blocked.txt)");
    });
    try {
      const result = await call(harness(() => active), cwd, "git_worktree", { action: "create", name: "revoked" });
      expect(result.status).toBe("failed");
      expect(started).toBe(1);
      expect(await readFile(join(cwd, "blocked.txt"), "utf8")).toContain(secret);
    } finally { stop(); }
    await expect(access(join(cwd, ".chili", "worktrees", "revoked"))).rejects.toThrow();
  });
});

test("managed Git read commands refuse repository filters even without resource scopes", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await writeFile(join(cwd, ".gitattributes"), "visible.txt filter=probe\n");
    await git(cwd, ["config", "filter.probe.clean", "printf filter > filter-ran.txt; cat"]);
    await writeFile(join(cwd, "visible.txt"), "changed content\n");
    // Prove this configuration has an actual command side effect in vanilla
    // Git, then require the normal executor path to avoid that side effect.
    await git(cwd, ["diff", "--no-ext-diff", "--no-textconv"]);
    expect(await readFile(join(cwd, "filter-ran.txt"), "utf8")).toBe("filter");
    await rm(join(cwd, "filter-ran.txt"));
    const calls = await managedGitReadCalls(cwd);
    for (const executor of [
      harness(() => [{ permission: "*", pattern: "*", action: "allow" }]),
      harness(() => rules("write(filter-ran.txt)")),
      harness(() => [{ permission: "*", pattern: "*", action: "allow" }], [], { writeScope: [], executeScope: [], allowedTools: ["git_worktree", "git_apply_patch"] }),
    ]) {
      for (const [tool, input] of calls) {
        expect((await call(executor, cwd, tool, input)).status).toBe("failed");
        await expect(access(join(cwd, "filter-ran.txt"))).rejects.toThrow();
      }
    }
  });
});

test("managed Git read commands disable filesystem-monitor helpers", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await writeFile(join(cwd, "monitor.sh"), "#!/bin/sh\nprintf monitor > monitor-ran.txt\nprintf 'clock\\000'\n");
    await chmod(join(cwd, "monitor.sh"), 0o755);
    await git(cwd, ["config", "core.fsmonitor", "./monitor.sh"]);
    await git(cwd, ["status", "--porcelain"]);
    expect(await readFile(join(cwd, "monitor-ran.txt"), "utf8")).toBe("monitor");
    await rm(join(cwd, "monitor-ran.txt"));
    const executor = harness(() => [{ permission: "*", pattern: "*", action: "allow" }]);
    for (const [tool, input] of await managedGitReadCalls(cwd)) {
      expect((await call(executor, cwd, tool, input)).status).toBe("completed");
      await expect(access(join(cwd, "monitor-ran.txt"))).rejects.toThrow();
    }
  });
});

test("managed Git read dispatch detects filters added while the command is being prepared", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await writeFile(join(cwd, ".gitattributes"), "visible.txt filter=probe\n");
    await writeFile(join(cwd, "visible.txt"), "changed\n");
    const configPath = join(cwd, ".git", "config");
    const originalConfig = await readFile(configPath, "utf8");
    let started = 0;
    const stop = observeProcessGuardianLifecycle((event) => {
      if (event.type !== "started" || event.cwd !== cwd || ++started !== 1) return;
      // The registration hook is synchronous, as is durable guardian ownership.
      writeFileSync(configPath, `${originalConfig}\n[filter "probe"]\n\tclean = printf filter > filter-ran.txt; cat\n`);
    });
    try {
      const result = await call(harness(() => [{ permission: "*", pattern: "*", action: "allow" }]), cwd, "git_worktree", { action: "list" });
      expect(result.status).toBe("failed");
      await expect(access(join(cwd, "filter-ran.txt"))).rejects.toThrow();
    } finally { stop(); }
  });
});

async function managedGitReadCalls(cwd: string) {
  const expectedHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const patchText = "diff --git a/visible.txt b/visible.txt\n--- a/visible.txt\n+++ b/visible.txt\n@@ -1 +1 @@\n-public needle\n+updated needle\n";
  return [
    ["git_worktree", { action: "list" }],
    ["git_apply_patch", { expectedHead, patchText, checkOnly: true }],
  ] as const;
}

async function initializeGit(cwd: string): Promise<void> {
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Chili test"]);
  await git(cwd, ["config", "user.email", "chili-test@example.invalid"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 10_000, maxOutputBytes: 100_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}
