import { expect, test } from "bun:test";
import type { RuntimePermissionProfileId } from "@chili/protocol";
import type { BashRunner } from "@chili/tools";
import { createCliBashRunner } from "./bash-runner.js";

test("CLI root shell uses the same backend after either execution mode admits a call", async () => {
  let profile: RuntimePermissionProfileId = "auto-review";
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => profile,
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  expect((await runner.run(request())).sandbox).toBe("none");
  profile = "full-access";
  expect((await runner.run(request())).sandbox).toBe("none");
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 0, unsandboxedCalls: 2 });
});

test("CLI root shell executes a reviewed call without manual escalation", async () => {
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => "auto-review",
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }, "none"),
  });

  expect((await runner.run(request("require_escalated"))).sandbox).toBe("none");
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 0, unsandboxedCalls: 1 });
});

test("CLI scoped shell does not retry outside the sandbox after a sandbox failure", async () => {
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => "auto-review",
    allowHostSandboxEscape: false,
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

test("CLI bash runner keeps both execution modes on the unsandboxed backend on unsupported platforms", async () => {
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "linux",
    permissionProfile: () => "auto-review",
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  expect((await runner.run(request())).sandbox).toBe("none");
  expect((await runner.run(request("require_escalated"))).sandbox).toBe("none");
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 0, unsandboxedCalls: 2 });
});

test("scoped worker runner ignores Full Access and rejects explicit sandbox escape", async () => {
  let sandboxedCalls = 0;
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "darwin",
    permissionProfile: () => "full-access",
    allowHostSandboxEscape: false,
    sandboxedRunner: fakeRunner(() => { sandboxedCalls += 1; }, "macos-seatbelt"),
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }, "none"),
  });

  expect((await runner.run(request("use_default"))).sandbox).toBe("macos-seatbelt");
  await expect(runner.run(request("require_escalated"))).rejects.toThrow(
    "Scoped workers cannot request execution outside the host sandbox",
  );
  expect({ sandboxedCalls, unsandboxedCalls }).toEqual({ sandboxedCalls: 1, unsandboxedCalls: 0 });
});

test("scoped worker runner fails closed when the host has no shell sandbox", async () => {
  let unsandboxedCalls = 0;
  const runner = createCliBashRunner({
    platform: "linux",
    permissionProfile: () => "auto-review",
    allowHostSandboxEscape: false,
    unsandboxedRunner: fakeRunner(() => { unsandboxedCalls += 1; }),
  });

  await expect(runner.run(request())).rejects.toThrow("host has no configured shell sandbox");
  await expect(runner.run(request("require_escalated"))).rejects.toThrow("host has no configured shell sandbox");
  expect(unsandboxedCalls).toBe(0);
});

function fakeRunner(onRun: () => void, sandbox: "macos-seatbelt" | "none" = "none"): BashRunner {
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
        sandbox,
      };
    },
  };
}

function request(sandboxPermissions: "use_default" | "require_escalated" = "use_default") {
  return {
    command: "printf ok",
    workspaceRoot: "/repo",
    cwd: "/repo",
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    sandboxPermissions,
    signal: new AbortController().signal,
    onOutput: undefined,
  };
}
