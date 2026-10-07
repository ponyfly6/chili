import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadImageTool } from "./builtins/read-image.js";
import { createBashTool } from "./builtins/bash.js";
import { createGitApplyPatchTool } from "./builtins/git-apply-patch.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { observeProcessGuardianLifecycle, runProcess } from "./process.js";
import type { ToolAccessPolicy, ToolExecutionGate, ToolReviewRequest } from "./types.js";

const secret = "PRIVATE_MARKER_c065751adf";

const allowGate: ToolExecutionGate = { review: async () => ({ decision: "allow" }) };

function harness(gate: ToolExecutionGate = allowGate, events: ChiliEvent[] = [], policy?: ToolAccessPolicy): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of [createGlobTool(), createGrepTool(), createReadImageTool(), createBashTool(), createGitApplyPatchTool()]) registry.register(tool);
  return new ToolExecutor({
    registry, gate, events: { publish: async (event) => { events.push(event); } },
    ...(policy ? { policyResolver: { resolve: () => policy } } : {}),
  });
}

function call(executor: ToolExecutor, cwd: string, toolName: string, input: unknown) {
  return executor.execute({ cwd, toolName, input, sessionId: "resource_session" as SessionId, turnId: "turn" as TurnId });
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

test("gate denial stops broad discovery before file contents or names escape", async () => {
  await withWorkspace(async (cwd) => {
    const events: ChiliEvent[] = [];
    const reviewed: ToolReviewRequest[] = [];
    const executor = harness({ review: async (request) => {
      reviewed.push(request);
      return { decision: "deny", reason: "Broad discovery is outside this task." };
    } }, events);
    expect((await call(executor, cwd, "grep", { pattern: "needle" })).status).toBe("failed");
    expect((await call(executor, cwd, "glob", { pattern: "*.txt" })).status).toBe("failed");
    expect(reviewed.map((request) => request.toolName)).toEqual(["grep", "glob"]);
    expect(reviewed[0]?.input).toMatchObject({ pattern: "needle" });
    expect(reviewed[1]?.input).toMatchObject({ pattern: "*.txt" });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events.filter((event) => event.type === "tool.call_finished"))).not.toContain("blocked.txt");
  });
});

test("allowed discovery searches explicit directories and aliases without old permission filtering", async () => {
  await withWorkspace(async (cwd) => {
    await mkdir(join(cwd, "nested"));
    await rename(join(cwd, "blocked.txt"), join(cwd, "nested", "private.txt"));
    await writeFile(join(cwd, "nested", "public.txt"), "public needle");
    await symlink(join(cwd, "nested"), join(cwd, "alias"));
    const executor = harness();
    for (const path of ["./nested", join(cwd, "nested"), "alias"]) {
      const result = await call(executor, cwd, "grep", { pattern: "needle", path });
      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.result.output).toContain("public.txt");
        expect(result.result.output).toContain("private.txt");
      }
    }
    const glob = await call(executor, cwd, "glob", { pattern: "**/*.txt", path: "alias" });
    expect(glob.status).toBe("completed");
    if (glob.status === "completed") expect(glob.result.output).toContain("private.txt");
  });
});

test("a previous allowed search does not grant later calls access", async () => {
  await withWorkspace(async (cwd) => {
    let deny = false;
    let reviews = 0;
    const executor = harness({ review: async () => {
      reviews++;
      return { decision: deny ? "deny" : "allow", reason: "The task context changed." };
    } });
    const initial = await call(executor, cwd, "grep", { pattern: "needle" });
    expect(initial.status).toBe("completed");
    if (initial.status === "completed") expect(initial.result.output).toContain("blocked.txt");
    deny = true;
    const after = await call(executor, cwd, "grep", { pattern: "needle" });
    expect(after.status).toBe("failed");
    expect(reviews).toBe(2);
    expect(JSON.stringify(after)).not.toContain(secret);
  });
});

test("image reads enter the gate with their exact target before exposing image bytes", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "private.png"), Buffer.from(secret));
    const reviewed: ToolReviewRequest[] = [];
    const executor = harness({ review: async (request) => {
      reviewed.push(request);
      return { decision: "deny", reason: "The image is unrelated to this task." };
    } });
    const result = await call(executor, cwd, "read_image", { filePath: "./private.png" });
    expect(result.status).toBe("failed");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.toolName).toBe("read_image");
    expect(reviewed[0]?.input).toMatchObject({ filePath: "private.png" });
    expect(JSON.stringify(result)).not.toContain(Buffer.from(secret).toString("base64"));
  });
});

test("Bash Git mutations and hooks respect gate denial and worker execution scope", async () => {
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
      harness({ review: async () => ({ decision: "deny", reason: "No repository changes requested." }) }),
      harness(allowGate, [], { writeScope: [], executeScope: [], allowedTools: ["bash"] }),
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

test("discovery reviews one exact action rather than every matching candidate", async () => {
  await withWorkspace(async (cwd) => {
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(cwd, `candidate-${index}.txt`), "public needle\n")));
    let reviews = 0;
    const executor = harness({ review: async () => { reviews++; return { decision: "allow" }; } });
    for (const [tool, input] of [["grep", { pattern: "needle", headLimit: 500 }], ["glob", { pattern: "*.txt", limit: 500 }]] as const) {
      reviews = 0;
      const result = await call(executor, cwd, tool, input);
      expect(result.status).toBe("completed");
      if (result.status === "completed") expect(result.result.output).toContain("candidate-199.txt");
      expect(reviews).toBe(1);
    }
  });
});

test("git_apply_patch rechecks review validity immediately before dispatching each process", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    const input = await gitPatchInput(cwd);
    let revoked = false;
    let started = 0;
    const stop = observeProcessGuardianLifecycle((event) => {
      if (event.type !== "started" || event.cwd !== cwd) return;
      started++;
      revoked = true;
    });
    try {
      const executor = harness({ review: async () => ({
        decision: "allow",
        assertCurrent: async () => { if (revoked) throw new Error("Review settings changed."); },
      }) });
      const result = await call(executor, cwd, "git_apply_patch", input);
      expect(result.status).toBe("failed");
      expect(started).toBe(1);
      expect(await readFile(join(cwd, "blocked.txt"), "utf8")).toContain(secret);
    } finally { stop(); }
    expect(await readFile(join(cwd, "visible.txt"), "utf8")).toBe("public needle\n");
  });
});

test("git_apply_patch checks refuse repository filters even without resource scopes", async () => {
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
    const input = { ...await gitPatchInput(cwd), checkOnly: true };
    for (const executor of [
      harness(),
      harness(allowGate, [], { writeScope: [], executeScope: [], allowedTools: ["git_apply_patch"] }),
    ]) {
      expect((await call(executor, cwd, "git_apply_patch", input)).status).toBe("failed");
      await expect(access(join(cwd, "filter-ran.txt"))).rejects.toThrow();
    }
  });
});

test("git_apply_patch checks disable filesystem-monitor helpers", async () => {
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
    const executor = harness();
    const input = { ...await gitPatchInput(cwd), checkOnly: true };
    expect((await call(executor, cwd, "git_apply_patch", input)).status).toBe("completed");
    await expect(access(join(cwd, "monitor-ran.txt"))).rejects.toThrow();
  });
});

test("git_apply_patch checks detect filters added while the command is being prepared", async () => {
  await withWorkspace(async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);
    await writeFile(join(cwd, ".gitattributes"), "visible.txt filter=probe\n");
    await writeFile(join(cwd, "visible.txt"), "changed\n");
    const input = { ...await gitPatchInput(cwd), checkOnly: true };
    const configPath = join(cwd, ".git", "config");
    const originalConfig = await readFile(configPath, "utf8");
    let started = 0;
    const stop = observeProcessGuardianLifecycle((event) => {
      if (event.type !== "started" || event.cwd !== cwd || ++started !== 1) return;
      // The registration hook is synchronous, as is durable guardian ownership.
      writeFileSync(configPath, `${originalConfig}\n[filter "probe"]\n\tclean = printf filter > filter-ran.txt; cat\n`);
    });
    try {
      const result = await call(harness(), cwd, "git_apply_patch", input);
      expect(result.status).toBe("failed");
      await expect(access(join(cwd, "filter-ran.txt"))).rejects.toThrow();
    } finally { stop(); }
  });
});

async function gitPatchInput(cwd: string) {
  const expectedHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const patchText = "diff --git a/visible.txt b/visible.txt\n--- a/visible.txt\n+++ b/visible.txt\n@@ -1 +1 @@\n-public needle\n+updated needle\n";
  return { expectedHead, patchText };
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
