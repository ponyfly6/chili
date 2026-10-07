import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChiliEvent } from "@chili/protocol";
import type { RuntimeClient } from "@chili/sdk";
import { DetachedProcessGroupRegistry } from "./detached-process-group-registry.js";
import { desktopDiff } from "./git-diff.js";
import { processGroupExists } from "./process-groups.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("workspace diff reads raw HEAD objects without invoking repository drivers", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-hostile-");
  await fixtureGit(workspace, ["init", "-q"]);
  await fixtureGit(workspace, ["config", "user.email", "test@example.com"]);
  await fixtureGit(workspace, ["config", "user.name", "Test"]);
  await writeFile(join(workspace, ".gitattributes"), "*.txt diff=hostile filter=hostile\n", "utf8");
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  await fixtureGit(workspace, ["add", ".gitattributes", "tracked.txt"]);
  await fixtureGit(workspace, ["commit", "-q", "-m", "baseline"]);

  const sentinel = join(workspace, "..", `${workspace.split("/").at(-1)}-driver-sentinel`);
  const driver = join(workspace, "hostile-driver.sh");
  await writeFile(driver, `#!/bin/sh\nprintf 'executed\\n' >> '${shellSingleQuote(sentinel)}'\nexit 1\n`, "utf8");
  await chmod(driver, 0o755);
  await fixtureGit(workspace, ["config", "diff.hostile.textconv", driver]);
  await fixtureGit(workspace, ["config", "filter.hostile.clean", driver]);
  await fixtureGit(workspace, ["config", "filter.hostile.process", driver]);
  await fixtureGit(workspace, ["config", "filter.hostile.required", "true"]);
  await fixtureGit(workspace, ["config", "core.fsmonitor", driver]);
  expect(await exists(sentinel)).toBe(false);

  await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
  await writeFile(join(workspace, "untracked.txt"), "new file\n", "utf8");
  const result = await withEnvironment({
    PATH: workspace,
    GIT_DIR: join(workspace, "outside-git-dir"),
    GIT_WORK_TREE: join(workspace, "outside-work-tree"),
    GIT_EXTERNAL_DIFF: driver,
    GIT_OBJECT_DIRECTORY: join(workspace, "outside-objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: driver,
    DYLD_INSERT_LIBRARIES: driver,
    LD_PRELOAD: driver,
  }, () => desktopDiff({
      scope: "workspace",
      workspace,
      sessionId: "session_hostile",
      client: unusedClient(),
    }));

  expect(result.truncated).toBe(false);
  expect(result.text).toContain("diff --git a/tracked.txt b/tracked.txt");
  expect(result.text).toContain("-before");
  expect(result.text).toContain("+after");
  expect(result.text).toContain("diff --git a/untracked.txt b/untracked.txt");
  expect(result.text).toContain("+new file");
  expect(await exists(sentinel)).toBe(false);
});

test("shutdown contains Git blocked by a repository-local config include FIFO", async () => {
  if (process.platform === "win32") return;
  const workspace = await temporaryDirectory("chili-desktop-diff-config-fifo-");
  await fixtureGit(workspace, ["init", "-q"]);
  const fifo = join(workspace, ".git", "blocking-include");
  await execFileAsync("/usr/bin/mkfifo", [fifo]);
  await appendFile(join(workspace, ".git", "config"), `\n[include]\n\tpath = ${fifo}\n`, "utf8");

  const processGroups = new DetachedProcessGroupRegistry({ termGraceMs: 100, killGraceMs: 500 });
  const shutdown = new AbortController();
  const diff = desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_fifo",
    client: unusedClient(),
    processGroups,
    signal: shutdown.signal,
  });
  await waitFor(() => processGroups.activeProcessGroupIds().length === 1);
  const leaderPid = processGroups.activeProcessGroupIds()[0];
  if (!leaderPid) throw new Error("Blocked Git process group was not registered");
  expect(processGroupExists(leaderPid)).toBe(true);

  shutdown.abort(new Error("Desktop is closing"));
  const closing = processGroups.close();
  expect(processGroups.signal.aborted).toBe(true);
  await closing;
  await expect(diff).rejects.toThrow("Desktop is closing");

  expect(processGroupExists(leaderPid)).toBe(false);
  expect(processGroups.activeProcessGroupIds()).toEqual([]);
});

test("workspace diff shows a staged modification and working-tree revert separately", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-staged-revert-");
  await fixtureGit(workspace, ["init", "-q"]);
  await fixtureGit(workspace, ["config", "user.email", "test@example.com"]);
  await fixtureGit(workspace, ["config", "user.name", "Test"]);
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  await fixtureGit(workspace, ["add", "tracked.txt"]);
  await fixtureGit(workspace, ["commit", "-q", "-m", "baseline"]);
  await writeFile(join(workspace, "tracked.txt"), "staged value\n", "utf8");
  await fixtureGit(workspace, ["add", "tracked.txt"]);
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");

  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_staged_revert",
    client: unusedClient(),
  });

  expect(result.truncated).toBe(false);
  expect(result.text).toContain("# staged changes (HEAD -> index)");
  expect(result.text).toContain("# unstaged changes (index -> working tree)");
  expect(result.text).toContain("-before");
  expect(result.text).toContain("+staged value");
  expect(result.text).toContain("-staged value");
  expect(result.text).toContain("+before");
  expect(result.text).not.toBe("Workspace is clean.");
});

test("workspace diff shows a staged add followed by a working-tree delete", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-staged-add-delete-");
  await fixtureGit(workspace, ["init", "-q"]);
  await writeFile(join(workspace, "added.txt"), "staged addition\n", "utf8");
  await fixtureGit(workspace, ["add", "added.txt"]);
  await rm(join(workspace, "added.txt"));

  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_staged_add_delete",
    client: unusedClient(),
  });

  expect(result.truncated).toBe(false);
  expect(result.text).toContain("# staged changes (HEAD -> index)");
  expect(result.text).toContain("new file mode 100644");
  expect(result.text).toContain("# unstaged changes (index -> working tree)");
  expect(result.text).toContain("deleted file mode 100644");
  expect(result.text).not.toBe("Workspace is clean.");
});

test("workspace diff shows a staged delete followed by recreating the HEAD file", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-staged-delete-recreate-");
  await fixtureGit(workspace, ["init", "-q"]);
  await fixtureGit(workspace, ["config", "user.email", "test@example.com"]);
  await fixtureGit(workspace, ["config", "user.name", "Test"]);
  await writeFile(join(workspace, "tracked.txt"), "HEAD value\n", "utf8");
  await fixtureGit(workspace, ["add", "tracked.txt"]);
  await fixtureGit(workspace, ["commit", "-q", "-m", "baseline"]);
  await fixtureGit(workspace, ["rm", "-q", "tracked.txt"]);
  await writeFile(join(workspace, "tracked.txt"), "HEAD value\n", "utf8");

  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_staged_delete_recreate",
    client: unusedClient(),
  });

  expect(result.truncated).toBe(false);
  expect(result.text).toContain("# staged changes (HEAD -> index)");
  expect(result.text).toContain("deleted file mode 100644");
  expect(result.text).toContain("# unstaged changes (index -> working tree)");
  expect(result.text).toContain("new file mode 100644");
  expect(result.text).not.toBe("Workspace is clean.");
});

test("workspace diff handles an unborn HEAD, symlinks, and binary files", async () => {
  if (process.platform === "win32") return;
  const workspace = await temporaryDirectory("chili-desktop-diff-unborn-");
  await fixtureGit(workspace, ["init", "-q"]);
  await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await symlink("target.txt", join(workspace, "link"));

  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_unborn",
    client: unusedClient(),
  });

  expect(result.text).toContain("Binary files /dev/null and b/binary.dat differ");
  expect(result.text).toContain("diff --git a/link b/link");
  expect(result.text).toContain("+target.txt");
});

test("workspace diff rejects Git metadata that points outside the selected workspace", async () => {
  const outside = await temporaryDirectory("chili-desktop-diff-gitdir-");
  await fixtureGit(outside, ["init", "-q"]);
  await fixtureGit(outside, ["config", "user.email", "test@example.com"]);
  await fixtureGit(outside, ["config", "user.name", "Test"]);
  await writeFile(join(outside, "outside-secret.txt"), "OUTSIDE GIT OBJECT SECRET\n", "utf8");
  await fixtureGit(outside, ["add", "outside-secret.txt"]);
  await fixtureGit(outside, ["commit", "-q", "-m", "outside"]);

  const workspace = await temporaryDirectory("chili-desktop-diff-external-git-");
  await writeFile(join(workspace, ".git"), `gitdir: ${join(outside, ".git")}\n`, "utf8");
  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_external_git",
    client: unusedClient(),
  });

  expect(result.text).toBe("Workspace is not a top-level Git working tree with local metadata.");
  expect(result.text).not.toContain("OUTSIDE GIT OBJECT SECRET");
});

test("workspace diff supports registered linked worktrees and rejects tampered relationships", async () => {
  if (process.platform === "win32") return;
  const main = await temporaryDirectory("chili-desktop-diff-worktree-main-");
  await fixtureGit(main, ["init", "-q"]);
  await fixtureGit(main, ["config", "user.email", "test@example.com"]);
  await fixtureGit(main, ["config", "user.name", "Test"]);
  await writeFile(join(main, "tracked.txt"), "main baseline\n", "utf8");
  await fixtureGit(main, ["add", "tracked.txt"]);
  await fixtureGit(main, ["commit", "-q", "-m", "baseline"]);
  const linkedParent = await temporaryDirectory("chili-desktop-diff-worktree-linked-");
  const linked = join(linkedParent, "linked");
  await fixtureGit(main, ["worktree", "add", "-q", "-b", "desktop-linked", linked]);
  await writeFile(join(linked, "tracked.txt"), "linked change\n", "utf8");

  const healthy = await desktopDiff({
    scope: "workspace",
    workspace: linked,
    sessionId: "session_linked",
    client: unusedClient(),
  });
  expect(healthy.text).toContain("diff --git a/tracked.txt b/tracked.txt");
  expect(healthy.text).toContain("-main baseline");
  expect(healthy.text).toContain("+linked change");

  const gitfile = await readFile(join(linked, ".git"), "utf8");
  const gitDirectory = gitfile.trim().slice("gitdir: ".length);
  const commondirPath = join(gitDirectory, "commondir");
  const originalCommondir = await readFile(commondirPath, "utf8");
  const outside = await temporaryDirectory("chili-desktop-diff-worktree-outside-");
  await fixtureGit(outside, ["init", "-q"]);
  await writeFile(commondirPath, `${join(outside, ".git")}\n`, "utf8");
  const badCommondir = await desktopDiff({
    scope: "workspace",
    workspace: linked,
    sessionId: "session_bad_commondir",
    client: unusedClient(),
  });
  expect(badCommondir.text).toBe("Workspace is not a top-level Git working tree with local metadata.");

  await writeFile(commondirPath, originalCommondir, "utf8");
  const gitdirAlias = join(main, "linked-gitdir-alias");
  await symlink(gitDirectory, gitdirAlias);
  await writeFile(join(linked, ".git"), `gitdir: ${gitdirAlias}\n`, "utf8");
  const symlinkedGitdir = await desktopDiff({
    scope: "workspace",
    workspace: linked,
    sessionId: "session_symlinked_gitdir",
    client: unusedClient(),
  });
  expect(symlinkedGitdir.text).toBe("Workspace is not a top-level Git working tree with local metadata.");
});

test("workspace diff stops incrementally after hundreds of changed files", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-bounded-");
  await fixtureGit(workspace, ["init", "-q"]);
  await fixtureGit(workspace, ["config", "user.email", "test@example.com"]);
  await fixtureGit(workspace, ["config", "user.name", "Test"]);
  const paths = Array.from({ length: 250 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`);
  await Promise.all(paths.map((path) => writeFile(join(workspace, path), `${"a".repeat(4_096)}\n`, "utf8")));
  await fixtureGit(workspace, ["add", "."]);
  await fixtureGit(workspace, ["commit", "-q", "-m", "many files"]);
  await Promise.all(paths.map((path) => writeFile(join(workspace, path), `${"b".repeat(4_096)}\n`, "utf8")));

  const result = await desktopDiff({
    scope: "workspace",
    workspace,
    sessionId: "session_bounded",
    client: unusedClient(),
  });

  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512 * 1024);
  expect(result.text).toContain("# diff output truncated by the safety limit");
  expect(result.text).not.toContain("file-0249.txt");
});

test("turn diff marks tool calls without snapshot baselines as incomplete", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-unsnapshotted-");
  await writeFile(join(workspace, "created-by-bash.txt"), "not attributable from a snapshot\n", "utf8");
  const sessionId = "session_unsnapshotted";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_bash" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_bash",
      callId: "call_bash",
      toolName: "bash",
      input: { command: "write a file" },
    }, 2),
  ] as ChiliEvent[];

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(true);
  expect(result.text).toContain("tool call(s) had no snapshot baseline");
  expect(result.text).toContain("No readable file snapshot was created by this turn.");
  expect(result.text).not.toContain("not attributable from a snapshot");
});

test("turn diff does not mark explicitly read-only builtin calls as incomplete", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-read-only-");
  await writeFile(join(workspace, "read-only.txt"), "read only\n", "utf8");
  const sessionId = "session_read_only";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_read" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_read",
      callId: "call_read",
      toolName: "read",
      input: { filePath: "read-only.txt" },
    }, 2),
    event("tool.call_started", sessionId, {
      turnId: "turn_read",
      callId: "call_git_status",
      toolName: "git_status",
      input: {},
    }, 3),
  ] as ChiliEvent[];

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result).toEqual({
    scope: "turn",
    text: "No snapshot-backed file changes were recorded for this turn.",
    truncated: false,
  });
});

test.each(["git status --short", "git diff --stat", "git log -5 --oneline", "pwd", "cat README.md"])(
  "turn diff recognizes executor-classified read-only Bash: %s",
  async (command) => {
    const workspace = await temporaryDirectory("chili-desktop-diff-bash-read-");
    const sessionId = "session_bash_read";
    const events = [
      event("turn.started", sessionId, { turnId: "turn_bash_read" }, 1),
      event("tool.call_started", sessionId, {
        turnId: "turn_bash_read", callId: "call_bash_read", toolName: "bash", input: { command },
      }, 2),
    ];
    const readDiff = () => desktopDiff({
      scope: "turn", workspace, sessionId,
      client: { sessionEvents: async () => events } as unknown as RuntimeClient,
    });

    // The initial event has no executor classification, so coverage is still unknown.
    expect((await readDiff()).truncated).toBe(true);
    events.push(event("tool.call_updated", sessionId, {
      callId: "call_bash_read", status: "running", metadata: { command, readOnly: true },
    }, 3));
    events.push(event("tool.call_updated", sessionId, {
      callId: "call_bash_read", status: "running", metadata: { processId: "process_read", background: true },
    }, 4));

    // Later metadata without a classification preserves the executor's decision.
    expect(await readDiff()).toEqual({
      scope: "turn",
      text: "No snapshot-backed file changes were recorded for this turn.",
      truncated: false,
    });
  },
);

test.each([
  { name: "write classification", command: "git checkout other", metadata: { readOnly: false } },
  { name: "missing classification", command: "git status", metadata: {} },
  { name: "non-boolean classification", command: "git status", metadata: { readOnly: "true" } },
])("turn diff keeps Bash conservative with $name", async ({ command, metadata }) => {
  const workspace = await temporaryDirectory("chili-desktop-diff-bash-unknown-");
  const sessionId = "session_bash_unknown";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_bash_unknown" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_bash_unknown", callId: "call_bash_unknown", toolName: "bash",
      input: { command, readOnly: true, metadata: { readOnly: true } },
    }, 2),
    event("tool.call_updated", sessionId, {
      callId: "call_bash_unknown", status: "running", metadata,
    }, 3),
  ];
  const result = await desktopDiff({
    scope: "turn", workspace, sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(true);
  expect(result.text).toContain("1 tool call(s) had no snapshot baseline");
});

test("turn diff scopes Bash classification to the matching session and started call", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-bash-event-scope-");
  const sessionId = "session_bash_scope";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_old" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_old", callId: "call_bash_scope", toolName: "bash", input: { command: "pwd" },
    }, 2),
    event("tool.call_updated", sessionId, {
      callId: "call_bash_scope", status: "running", metadata: { readOnly: true },
    }, 3),
    event("turn.started", sessionId, { turnId: "turn_bash_scope" }, 4),
    event("tool.call_started", sessionId, {
      turnId: "turn_bash_scope", callId: "call_bash_scope", toolName: "bash", input: { command: "git add ." },
    }, 5),
    event("tool.call_updated", "other_session", {
      callId: "call_bash_scope", status: "running", metadata: { readOnly: true },
    }, 6),
    event("tool.call_updated", sessionId, {
      callId: "other_call", status: "running", metadata: { readOnly: true },
    }, 7),
  ];
  const result = await desktopDiff({
    scope: "turn", workspace, sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(true);
  expect(result.text).toContain("1 tool call(s) had no snapshot baseline");
});

test("turn diff treats a dynamic MCP tool with a read-like name as potentially mutating", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-mcp-read-spoof-");
  await writeFile(join(workspace, "spoofed-read.txt"), "secret mutation behind a read-like name\n", "utf8");
  const sessionId = "session_mcp_read_spoof";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_mcp_read_spoof" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_mcp_read_spoof",
      callId: "call_mcp_read_spoof",
      toolName: "mcp__filesystem__read_file",
      input: { path: "spoofed-read.txt" },
    }, 2),
    event("tool.call_updated", sessionId, {
      callId: "call_mcp_read_spoof", status: "running", metadata: { readOnly: true },
    }, 3),
  ] as ChiliEvent[];

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(true);
  expect(result.text).toContain("tool call(s) had no snapshot baseline");
  expect(result.text).not.toContain("secret mutation behind a read-like name");
});

test("turn diff treats an MCP writer without semantic snapshot coverage as incomplete", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-mcp-write-");
  await writeFile(join(workspace, "mcp-created.txt"), "MCP write output must not be inferred\n", "utf8");
  const sessionId = "session_mcp_write";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_mcp_write" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_mcp_write",
      callId: "call_mcp_write",
      toolName: "mcp__filesystem__write_file",
      input: { path: "mcp-created.txt" },
    }, 2),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_empty",
      callId: "call_mcp_write",
      paths: [],
      reason: "empty coverage is not semantic coverage",
    }, 3),
  ] as ChiliEvent[];

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(true);
  expect(result.text).toContain("tool call(s) had no snapshot baseline");
  expect(result.text).not.toContain("MCP write output must not be inferred");
});

test("turn diff ignores an unsnapshotted read alongside a snapshotted edit", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-read-edit-");
  await writeFile(join(workspace, "executable.sh"), "echo after\n", "utf8");
  await chmod(join(workspace, "executable.sh"), 0o755);
  await writeSnapshot(workspace, "snapshot_edit", "executable.sh", "echo before\n", 0o100755);
  const sessionId = "session_read_edit";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_edit" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_edit",
      callId: "call_read",
      toolName: "read",
      input: { filePath: "executable.sh" },
    }, 2),
    event("tool.call_started", sessionId, {
      turnId: "turn_edit",
      callId: "call_edit",
      toolName: "edit",
      input: { filePath: "executable.sh" },
    }, 3),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_edit",
      callId: "call_edit",
      paths: ["executable.sh"],
      reason: "edit",
    }, 4),
  ] as ChiliEvent[];

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    client: { sessionEvents: async () => events } as unknown as RuntimeClient,
  });

  expect(result.truncated).toBe(false);
  expect(result.text).toContain("-echo before");
  expect(result.text).toContain("+echo after");
  expect(result.text).not.toContain("old mode");
  expect(result.text).not.toContain("new mode");
  expect(result.text).not.toContain("incomplete");
});

test("turn diff uses the earliest matching snapshot and ignores revert history", async () => {
  const workspace = await temporaryDirectory("chili-desktop-diff-turn-");
  const currentPath = join(workspace, "src", "value.txt");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(currentPath, "current value\n", "utf8");
  await writeSnapshot(workspace, "snapshot_first", "src/value.txt", "first baseline\n");
  await writeSnapshot(workspace, "snapshot_second", "src/value.txt", "second baseline\n");

  const outside = await temporaryDirectory("chili-desktop-diff-outside-");
  await writeFile(join(outside, "manifest.json"), "SECRET OUTSIDE SNAPSHOT", "utf8");
  await symlink(outside, join(workspace, ".chili", "snapshots", "snapshot_malicious"));
  const outsideSecret = join(outside, "outside-secret.txt");
  await writeFile(outsideSecret, "FOLLOWED SYMLINK SECRET", "utf8");
  await symlink(outsideSecret, join(workspace, "external-link.txt"));
  await writeSnapshot(workspace, "snapshot_followed", "external-link.txt", "FOLLOWED SYMLINK SECRET");
  await writeFile(join(workspace, "legacy.txt"), "safe current value\n", "utf8");
  await writeLegacySnapshot(workspace, "snapshot_legacy", "legacy.txt", "LEGACY BLOB SECRET");

  const sessionId = "session_turn";
  const events = [
    event("turn.started", sessionId, { turnId: "turn_old" }, 1),
    event("tool.call_started", sessionId, {
      turnId: "turn_old",
      callId: "call_old",
      toolName: "write",
      input: {},
    }, 2),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_old",
      callId: "call_old",
      paths: ["history-secret.txt"],
      reason: "old turn",
    }, 3),
    event("snapshot.reverted", sessionId, {
      snapshotId: "snapshot_old",
      status: "completed",
      paths: ["history-secret.txt"],
    }, 4),
    event("turn.started", sessionId, { turnId: "turn_target" }, 5),
    event("tool.call_started", sessionId, {
      turnId: "turn_target",
      callId: "call_target",
      toolName: "write",
      input: {},
    }, 6),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_first",
      callId: "call_target",
      paths: ["src/value.txt"],
      reason: "first write",
    }, 7),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_second",
      callId: "call_target",
      paths: ["src/value.txt"],
      reason: "second write",
    }, 8),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_malicious",
      callId: "call_target",
      paths: ["leak.txt"],
      reason: "malicious fixture",
    }, 9),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_followed",
      callId: "call_target",
      paths: ["external-link.txt"],
      reason: "simulated vulnerable legacy snapshot",
    }, 10),
    event("snapshot.created", sessionId, {
      snapshotId: "snapshot_legacy",
      callId: "call_target",
      paths: ["legacy.txt"],
      reason: "legacy manifest without provenance",
    }, 11),
  ] as ChiliEvent[];
  const client = { sessionEvents: async () => events } as unknown as RuntimeClient;

  const result = await desktopDiff({
    scope: "turn",
    workspace,
    sessionId,
    turnId: "turn_target",
    client,
  });

  expect(result.text).toContain("diff --git a/src/value.txt b/src/value.txt");
  expect(result.text).toContain("-first baseline");
  expect(result.text).toContain("+current value");
  expect(result.text).not.toContain("second baseline");
  expect(result.text).not.toContain("history-secret.txt");
  expect(result.text).not.toContain("SECRET OUTSIDE SNAPSHOT");
  expect(result.text).not.toContain("FOLLOWED SYMLINK SECRET");
  expect(result.text).not.toContain("LEGACY BLOB SECRET");
  expect(result.text).toContain("snapshot path contains a symlink");
  expect(result.text).toContain("turn snapshot path is a symlink");
  expect(result.truncated).toBe(true);
});

async function writeSnapshot(
  workspace: string,
  id: string,
  path: string,
  content: string,
  mode: 0o100644 | 0o100755 = 0o100644,
): Promise<void> {
  const directory = join(workspace, ".chili", "snapshots", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "0.blob"), content, "utf8");
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    version: 2,
    id,
    cwd: workspace,
    createdAt: 1,
    reason: "test",
    entries: [{ relativePath: path, kind: "regular", existed: true, mode, backupName: "0.blob" }],
  }), "utf8");
}

async function writeLegacySnapshot(workspace: string, id: string, path: string, content: string): Promise<void> {
  const directory = join(workspace, ".chili", "snapshots", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "0.blob"), content, "utf8");
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    id,
    cwd: workspace,
    entries: [{ relativePath: path, existed: true, backupName: "0.blob" }],
  }), "utf8");
}

function event(type: string, sessionId: string, payload: unknown, time: number): ChiliEvent {
  return { id: `event_${time}`, type, time, sessionId, payload } as ChiliEvent;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixtureGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: "/nonexistent",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
    maxBuffer: 1024 * 1024,
  });
}

function unusedClient(): RuntimeClient {
  return {} as RuntimeClient;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

async function withEnvironment<T>(values: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
