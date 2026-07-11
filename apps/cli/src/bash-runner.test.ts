import { expect, test } from "bun:test";
import type { RuntimePermissionProfileId } from "@chili/protocol";
import type { BashRunner } from "@chili/tools";
import { createCliBashRunner } from "./bash-runner.js";

test("CLI bash runner follows live macOS permission profile changes", async () => {
  let profile: RuntimePermissionProfileId = "default";
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => profile,
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  expect((await runner.run(request())).sandbox).toBe("macos-seatbelt");
  profile = "full-access";
  expect((await runner.run(request())).sandbox).toBeUndefined();
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 1, unsandboxedCalls: 1 });
});

test("CLI bash runner does not retry outside the sandbox after a sandbox failure", async () => {
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => "default",
    sandboxedRunner: {
      async run() {
        throw new Error("seatbelt failed");
      },
    },
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  await expect(runner.run(request())).rejects.toThrow("seatbelt failed");
  expect(unsandboxedCalls).toBe(0);
});

test("CLI bash runner keeps the unsandboxed backend on unsupported platforms", async () => {
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "linux",
    permissionProfile: () => "default",
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  expect((await runner.run(request())).sandbox).toBeUndefined();
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 0, unsandboxedCalls: 1 });
});

function fakeRunner(onRun: () => void, sandbox?: "macos-seatbelt"): BashRunner {
  return {
    async run(request) {
      onRun();
      return {
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutBytes: 2,
        stderrBytes: 0,
        outputLimitBytes: request.maxOutputBytes,
        durationMs: 1,
        timedOut: false,
        aborted: false,
        ...(sandbox ? { sandbox } : {}),
      };
    },
  };
}

function request() {
  return {
    command: "printf ok",
    workspaceRoot: "/repo",
    cwd: "/repo",
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    signal: new AbortController().signal,
    onOutput: undefined,
  };
}
