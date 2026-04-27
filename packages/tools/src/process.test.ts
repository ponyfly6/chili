import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.js";

test("runProcess reports output truncation with byte metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-output-"));
  try {
    const result = await runProcess("bash", ["-lc", "printf abcdef; printf ghijkl >&2"], {
      cwd: workspace,
      maxOutputBytes: 3,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abc");
    expect(result.stderr).toBe("ghi");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdoutBytes).toBe(6);
    expect(result.stderrBytes).toBe(6);
    expect(result.outputLimitBytes).toBe(3);
    expect(result.timedOut).toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess timeout terminates background children in the process group", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-timeout-"));
  const marker = join(workspace, "survived.txt");
  try {
    const command = `(sleep 0.8; printf survived > ${shellQuote(marker)}) & wait`;
    const result = await runProcess("bash", ["-lc", command], {
      cwd: workspace,
      timeoutMs: 80,
      killGraceMs: 80,
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(1_500);
    await sleep(1_000);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
