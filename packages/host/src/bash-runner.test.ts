import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeProcessGuardianLifecycle, type BashRunRequest, type BashRunner, type ToolResourceDenials } from "@chili/tools";
import { createHostBashRunner } from "./bash-runner.js";

const macOsTest = process.platform === "darwin" ? test : test.skip;

macOsTest("file denies are refreshed at actual shell launch and dominate full-access and elevation", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chili-host-shell-deny-")));
  try {
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, "private", "secret"), "PRIVATE_RESOURCE_CONTENT");
    await writeFile(join(workspace, "locked"), "original");
    await symlink("private/secret", join(workspace, "read-alias"));
    await symlink("locked", join(workspace, "write-alias"));
    let denials: ToolResourceDenials | undefined;
    let resolved = 0;
    const runner = createHostBashRunner({
      permissionProfile: () => "full-access",
      resolveResourceDenials: (request) => {
        expect(request.workspaceRoot).toBe(workspace);
        resolved += 1;
        return denials;
      },
    });
    expect((await runner.run(request(workspace, "cat private/secret"))).stdout).toBe("PRIVATE_RESOURCE_CONTENT");
    denials = { readPaths: [join(workspace, "private", "secret")], writePaths: [join(workspace, "locked")] };
    for (const path of ["private/secret", "./private/secret", join(workspace, "private", "secret"), "read-alias"]) {
      const result = await runner.run(request(workspace, `cat ${quote(path)}`));
      expect(result.sandbox).toBe("macos-seatbelt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("PRIVATE_RESOURCE_CONTENT");
    }
    for (const path of ["locked", "./locked", join(workspace, "locked"), "write-alias"]) {
      expect((await runner.run(request(workspace, `printf unsafe > ${quote(path)}`))).exitCode).not.toBe(0);
    }
    expect((await runner.run(request(workspace, "cat locked"))).stdout).toBe("original");
    expect((await runner.run(request(workspace, "printf allowed > allowed"))).exitCode).toBe(0);
    await expect(runner.run({ ...request(workspace, "cat private/secret"), sandboxPermissions: "require_escalated" }))
      .rejects.toThrow("cannot be bypassed by elevated execution");
    expect(await readFile(join(workspace, "locked"), "utf8")).toBe("original");
    expect(resolved).toBeGreaterThanOrEqual(12);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

macOsTest("read denies prevent alias creation and parent renames from exposing the resource", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chili-host-shell-alias-deny-")));
  try {
    await mkdir(join(workspace, "private"));
    const secret = join(workspace, "private", "secret");
    await writeFile(secret, "PRIVATE_RESOURCE_CONTENT");
    const runner = createHostBashRunner({
      permissionProfile: () => "full-access",
      resolveResourceDenials: () => ({ readPaths: [secret], writePaths: [] }),
    });
    for (const command of [
      "mv private/secret exposed && cat exposed",
      "mv private exposed && cat exposed/secret",
      "ln private/secret exposed && cat exposed",
    ]) {
      const result = await runner.run(request(workspace, command));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("PRIVATE_RESOURCE_CONTENT");
      expect(await readFile(secret, "utf8")).toBe("PRIVATE_RESOURCE_CONTENT");
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("file denies fail closed on unsupported platforms and opaque shell backends", async () => {
  let calls = 0;
  const opaque: BashRunner = { run: async () => { calls += 1; throw new Error("must not execute"); } };
  for (const platform of ["linux", "darwin"] as const) {
    const runner = createHostBashRunner({
      platform,
      permissionProfile: () => "full-access",
      sandboxedRunner: opaque,
      unsandboxedRunner: opaque,
      resolveResourceDenials: () => ({ readPaths: ["/workspace/secret"], writePaths: [] }),
    });
    await expect(runner.run(request("/workspace", "cat secret"))).rejects.toThrow(/resource denies/);
  }
  expect(calls).toBe(0);
});

macOsTest("a file deny added after backend preparation blocks the guardian start handshake", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chili-host-shell-late-deny-")));
  let denials: ToolResourceDenials | undefined;
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.type === "started" && event.cwd === workspace) {
      denials = { readPaths: [join(workspace, "secret")], writePaths: [] };
    }
  });
  try {
    await writeFile(join(workspace, "secret"), "PRIVATE_RESOURCE_CONTENT");
    const runner = createHostBashRunner({ permissionProfile: () => "full-access", resolveResourceDenials: () => denials });
    await expect(runner.run(request(workspace, "cat secret > exposed")))
      .rejects.toThrow("File resource policy changed during shell preparation");
    await expect(readFile(join(workspace, "exposed"))).rejects.toThrow();
  } finally { unsubscribe(); await rm(workspace, { recursive: true, force: true }); }
});

macOsTest("latest command authorization is checked after guardian registration and before side effects", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chili-host-shell-late-auth-")));
  let denied = false;
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.type === "started" && event.cwd === workspace) denied = true;
  });
  try {
    const runner = createHostBashRunner({ permissionProfile: () => "default" });
    await expect(runner.run({
      ...request(workspace, "printf unsafe > effect"),
      assertCurrentAuthorization: async () => { if (denied) throw new Error("command permission was revoked"); },
    })).rejects.toThrow("command permission was revoked");
    await expect(readFile(join(workspace, "effect"))).rejects.toThrow();
  } finally { unsubscribe(); await rm(workspace, { recursive: true, force: true }); }
});

macOsTest("revoking full-access after backend selection cannot launch the selected unsandboxed command", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chili-host-shell-profile-revoked-")));
  let profile: "default" | "full-access" = "full-access";
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.type === "started" && event.cwd === workspace) profile = "default";
  });
  try {
    const runner = createHostBashRunner({ permissionProfile: () => profile });
    await expect(runner.run(request(workspace, "printf unsafe > effect")))
      .rejects.toThrow("Shell permission profile changed during preparation");
    await expect(readFile(join(workspace, "effect"))).rejects.toThrow();
  } finally { unsubscribe(); await rm(workspace, { recursive: true, force: true }); }
});

function request(cwd: string, command: string): BashRunRequest {
  return {
    command, cwd, workspaceRoot: cwd, timeoutMs: 5_000, maxOutputBytes: 4096,
    sandboxPermissions: "use_default", signal: new AbortController().signal, onOutput: undefined,
  };
}

function quote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }
