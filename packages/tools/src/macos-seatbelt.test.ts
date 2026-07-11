import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { expect, test } from "bun:test";
import type { BashRunRequest } from "./builtins/bash.js";
import {
  MACOS_SANDBOX_EXEC_PATH,
  buildMacOsSeatbeltProfile,
  createMacOsSeatbeltBashRunner,
} from "./macos-seatbelt.js";
import type { RunProcessOptions, RunProcessResult } from "./process.js";

test("macOS Seatbelt runner uses a fixed executable and forwards process controls", async () => {
  const workspace = "/tmp";
  const canonicalWorkspace = await realpath(workspace);
  let seen: { command: string; args: readonly string[]; options: RunProcessOptions } | undefined;
  const runner = createMacOsSeatbeltBashRunner({
    processRunner: async (command, args, options) => {
      seen = { command, args, options };
      return processResult();
    },
  });
  const controller = new AbortController();
  const onOutput = () => undefined;

  const result = await runner.run({
    command: "printf ok",
    workspaceRoot: workspace,
    cwd: workspace,
    env: { CHILI_TEST: "1" },
    timeoutMs: 123,
    maxOutputBytes: 456,
    signal: controller.signal,
    onOutput,
  });

  expect(seen?.command).toBe(MACOS_SANDBOX_EXEC_PATH);
  expect(seen?.args.slice(-4)).toEqual(["--", "/bin/bash", "-lc", "printf ok"]);
  expect(seen?.args).toContain(`-DWORKSPACE_ROOT=${canonicalWorkspace}`);
  const tempDefinition = seen?.args.find((argument) => argument.startsWith("-DTEMP_ROOT="));
  expect(tempDefinition).toBeDefined();
  expect(seen?.options).toMatchObject({
    cwd: workspace,
    env: {
      CHILI_TEST: "1",
      CHILI_SANDBOX: "macos-seatbelt",
      CHILI_SANDBOX_NETWORK_DISABLED: "1",
    },
    timeoutMs: 123,
    maxOutputBytes: 456,
    signal: controller.signal,
    onOutput,
  });
  expect(result.sandbox).toBe("macos-seatbelt");
});

test("macOS Seatbelt profile is deny-first and protects workspace metadata", () => {
  const profile = buildMacOsSeatbeltProfile("/tmp/chili-seatbelt-workspace");

  expect(profile).toContain("(deny default)");
  expect(profile).toContain("(allow file-read*)");
  expect(profile).toContain('(subpath (param "WORKSPACE_ROOT"))');
  expect(profile).toContain('(subpath (param "TEMP_ROOT"))');
  expect(profile).toContain('(literal (param "PROTECTED_GIT"))');
  expect(profile).toContain('(literal (param "PROTECTED_CHILI"))');
  expect(profile).not.toContain("(allow network-outbound");
  expect(profile).not.toContain("(allow network-inbound");
});

test("macOS Seatbelt profile safely handles shell metacharacters in workspace paths", () => {
  const workspace = "/tmp/chili seatbelt/$value;$(echo nope)'(test)";
  const profile = buildMacOsSeatbeltProfile(workspace);
  expect(profile).toContain("chili seatbelt/\\$value;\\$\\(echo nope\\)'\\(test\\)");
});

test("macOS Seatbelt runner fails closed when sandbox launch fails", async () => {
  let calls = 0;
  const runner = createMacOsSeatbeltBashRunner({
    processRunner: async () => {
      calls += 1;
      throw new Error("sandbox-exec unavailable");
    },
  });

  await expect(runner.run(bashRequest("/tmp", "printf unsafe")))
    .rejects.toThrow("sandbox-exec unavailable");
  expect(calls).toBe(1);
});

const macOsTest = process.platform === "darwin" ? test : test.skip;

macOsTest("macOS Seatbelt permits workspace writes and blocks metadata and parent writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-seatbelt-real-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  const gitConfig = join(workspace, ".git", "config");
  const chiliState = join(workspace, ".chili", "state");

  try {
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".chili"), { recursive: true });
    await writeFile(gitConfig, "original-git\n", "utf8");
    await writeFile(chiliState, "original-chili\n", "utf8");
    const runner = createMacOsSeatbeltBashRunner();

    const allowed = await runner.run(bashRequest(workspace, "printf allowed > allowed.txt"));
    const gitDenied = await runner.run(bashRequest(workspace, "printf hacked > .git/config"));
    const chiliDenied = await runner.run(bashRequest(workspace, "printf hacked > .chili/state"));
    const outsideDenied = await runner.run(bashRequest(workspace, "printf escaped > ../outside.txt"));

    expect(allowed.exitCode).toBe(0);
    expect(await readFile(join(workspace, "allowed.txt"), "utf8")).toBe("allowed");
    expect(gitDenied.exitCode).not.toBe(0);
    expect(chiliDenied.exitCode).not.toBe(0);
    expect(outsideDenied.exitCode).not.toBe(0);
    expect(await readFile(gitConfig, "utf8")).toBe("original-git\n");
    expect(await readFile(chiliState, "utf8")).toBe("original-chili\n");
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt blocks first creation of protected metadata paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-create-"));
  try {
    const runner = createMacOsSeatbeltBashRunner();
    const gitDenied = await runner.run(bashRequest(workspace, "mkdir .git"));
    const chiliDenied = await runner.run(bashRequest(workspace, "mkdir .chili"));

    expect(gitDenied.exitCode).not.toBe(0);
    expect(chiliDenied.exitCode).not.toBe(0);
    await expect(readFile(join(workspace, ".git"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, ".chili"), "utf8")).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt protects metadata symlink targets inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-symlink-"));
  const metadataTarget = join(workspace, "metadata-target");
  const targetConfig = join(metadataTarget, "config");
  try {
    await mkdir(metadataTarget);
    await writeFile(targetConfig, "original\n", "utf8");
    await symlink(metadataTarget, join(workspace, ".git"), "dir");
    const runner = createMacOsSeatbeltBashRunner();

    const denied = await runner.run(bashRequest(workspace, "printf hacked > .git/config"));

    expect(denied.exitCode).not.toBe(0);
    expect(await readFile(targetConfig, "utf8")).toBe("original\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt protects gitdir pointer targets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-gitdir-"));
  const gitDir = join(workspace, "actual-gitdir");
  const gitConfig = join(gitDir, "config");
  try {
    await mkdir(gitDir);
    await writeFile(gitConfig, "original\n", "utf8");
    await writeFile(join(workspace, ".git"), "gitdir: actual-gitdir\n", "utf8");
    const runner = createMacOsSeatbeltBashRunner();

    const denied = await runner.run(bashRequest(workspace, "printf hacked > actual-gitdir/config"));

    expect(denied.exitCode).not.toBe(0);
    expect(await readFile(gitConfig, "utf8")).toBe("original\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt blocks loopback network access by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-network-"));
  const server = createServer();
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const runner = createMacOsSeatbeltBashRunner();

    const denied = await runner.run(bashRequest(workspace, `/usr/bin/nc -z 127.0.0.1 ${address.port}`));

    expect(denied.exitCode).not.toBe(0);
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt provides and cleans an isolated temporary directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-temp-"));
  const runner = createMacOsSeatbeltBashRunner();
  try {
    const result = await runner.run(bashRequest(
      workspace,
      'file="$(mktemp)" && printf temporary > "$file" && printf "%s\\n" "$file" && cat "$file"',
    ));

    expect(result.exitCode).toBe(0);
    const [temporaryPath, contents] = result.stdout.trim().split("\n");
    expect(temporaryPath).toContain("chili-seatbelt-");
    expect(contents).toBe("temporary");
    await expect(access(temporaryPath ?? "")).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt runs common coding tools without sandbox diagnostics", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-seatbelt-tools-"));
  const runner = createMacOsSeatbeltBashRunner();
  const commands = [
    "/usr/bin/git --version",
    "/usr/bin/python3 -c 'import tempfile; f = tempfile.NamedTemporaryFile(); f.write(b\"ok\"); f.flush(); print(f.name)'",
    '"$BUN_EXECUTABLE" --version',
  ];

  try {
    for (const command of commands) {
      const result = await runner.run({
        ...bashRequest(workspace, command),
        env: { BUN_EXECUTABLE: process.execPath },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Operation not permitted");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

macOsTest("macOS Seatbelt derives isolation from each request workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-seatbelt-workspaces-"));
  const mainWorkspace = join(root, "main");
  const childWorkspace = join(mainWorkspace, ".chili", "worktrees", "team", "task");
  const runner = createMacOsSeatbeltBashRunner();

  try {
    await mkdir(childWorkspace, { recursive: true });

    const childResult = await runner.run({
      ...bashRequest(childWorkspace, 'printf child > child.txt; printf escaped > "$MAIN_WORKSPACE/escaped.txt"'),
      env: { MAIN_WORKSPACE: mainWorkspace },
    });
    expect(childResult.exitCode).not.toBe(0);
    expect(await readFile(join(childWorkspace, "child.txt"), "utf8")).toBe("child");
    await expect(readFile(join(mainWorkspace, "escaped.txt"), "utf8")).rejects.toThrow();

    const mainResult = await runner.run(bashRequest(mainWorkspace, "printf main > main.txt"));
    expect(mainResult.exitCode).toBe(0);
    expect(await readFile(join(mainWorkspace, "main.txt"), "utf8")).toBe("main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function bashRequest(cwd: string, command: string): BashRunRequest {
  return {
    command,
    workspaceRoot: cwd,
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    signal: new AbortController().signal,
    onOutput: undefined,
  };
}

function processResult(): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 2,
    stderrBytes: 0,
    outputLimitBytes: 456,
    durationMs: 1,
    timedOut: false,
    aborted: false,
  };
}
