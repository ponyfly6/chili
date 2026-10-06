import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeProcessGuardianLifecycle, runProcess } from "../process.js";
import { executeCodeMode } from "./runtime.js";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("code mode reports unconfirmed cancellation until a TERM-resistant guardian child is reaped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-code-mode-guardian-"));
  const controller = new AbortController();
  let guardianPid: number | undefined;
  let childSettled = false;
  let hostCall: Promise<unknown> | undefined;
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.cwd === cwd && event.type === "started") guardianPid = event.pid;
  });
  try {
    const result = await executeCodeMode({
      code: "await tools.command();",
      signal: controller.signal,
      timeoutMs: 5000,
      tools: [{ name: "command", description: "Controlled guardian fixture" }],
      invokeTool: (_name, _input, signal) => {
        hostCall = runProcess("/bin/sh", ["-c", "trap '' TERM; printf ready; while :; do sleep 1; done"], {
          cwd,
          signal,
          killGraceMs: 300,
          onRawOutput: () => controller.abort(),
        }).finally(() => { childSettled = true; });
        return hostCall;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("aborted");
    expect(result.error?.message).toContain("termination is unconfirmed");
    expect(result.calls[0]?.status).toBe("cancellation_requested");
    expect(childSettled).toBe(false);
    expect(guardianPid).toBeDefined();
    await expect(hostCall).rejects.toMatchObject({ name: "AbortError" });
    expect(childSettled).toBe(true);
    expect(() => process.kill(-guardianPid!, 0)).toThrow();
  } finally {
    controller.abort();
    await hostCall?.catch(() => undefined);
    unsubscribe();
    await rm(cwd, { recursive: true, force: true });
  }
}, 10_000);
