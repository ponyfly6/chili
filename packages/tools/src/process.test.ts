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

test("runProcess streams stdout and stderr deltas while preserving final output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-stream-"));
  const deltas: { stream: "stdout" | "stderr"; delta: string }[] = [];
  try {
    const result = await runProcess("bash", ["-lc", "printf out1; printf err1 >&2; sleep 0.05; printf out2; printf err2 >&2"], {
      cwd: workspace,
      outputFlushBytes: 1,
      onOutput: (chunk) => {
        deltas.push({ stream: chunk.stream, delta: chunk.delta });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out1out2");
    expect(result.stderr).toBe("err1err2");
    expect(deltas.filter((delta) => delta.stream === "stdout").map((delta) => delta.delta).join("")).toBe("out1out2");
    expect(deltas.filter((delta) => delta.stream === "stderr").map((delta) => delta.delta).join("")).toBe("err1err2");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess streams split UTF-8 output without replacement characters", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-utf8-"));
  const deltas: string[] = [];
  try {
    const script = `const b = Buffer.from("你好"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 20);`;
    const result = await runProcess("node", ["-e", script], {
      cwd: workspace,
      outputFlushBytes: 1,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") deltas.push(chunk.delta);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("你好");
    expect(deltas.join("")).toBe("你好");
    expect(deltas.join("")).not.toContain("�");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess coalesces tiny output chunks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-throttle-"));
  const deltas: string[] = [];
  try {
    const result = await runProcess("bash", ["-lc", "for i in {1..20}; do printf x; sleep 0.01; done"], {
      cwd: workspace,
      outputFlushIntervalMs: 1_000,
      outputFlushBytes: 1_024,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") deltas.push(chunk.delta);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("xxxxxxxxxxxxxxxxxxxx");
    expect(deltas.join("")).toBe(result.stdout);
    expect(deltas.length).toBeLessThanOrEqual(2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess live output continues after final capture is truncated", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-live-cap-"));
  const deltas: string[] = [];
  try {
    const result = await runProcess("bash", ["-lc", "printf abcdef; sleep 0.05; printf ghijkl"], {
      cwd: workspace,
      maxOutputBytes: 4,
      outputFlushBytes: 1,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") deltas.push(chunk.delta);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abcd");
    expect(result.stdoutTruncated).toBe(true);
    expect(deltas.join("")).toBe("abcdefghijkl");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess bounds verbose live output while keeping a fresh tail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-live-budget-"));
  const deltas: { delta: string; truncated?: boolean }[] = [];
  try {
    const marker = "TAIL_MARKER_尾巴";
    const script = `process.stdout.write("a".repeat(120000)); process.stdout.write("\\n${marker}\\n");`;
    const result = await runProcess("node", ["-e", script], {
      cwd: workspace,
      maxOutputBytes: 16,
      outputFlushIntervalMs: 10_000,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") {
          deltas.push({
            delta: chunk.delta,
            ...(chunk.truncated !== undefined ? { truncated: chunk.truncated } : {}),
          });
        }
      },
    });

    const liveBytes = deltas.reduce((total, delta) => total + Buffer.byteLength(delta.delta, "utf8"), 0);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a".repeat(16));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBeGreaterThan(120_000);
    expect(deltas.length).toBeLessThanOrEqual(3);
    expect(liveBytes).toBeLessThanOrEqual(12_000);
    expect(deltas.some((delta) => delta.truncated === true)).toBe(true);
    expect(deltas.at(-1)?.delta).toContain(marker);
    expect(deltas.map((delta) => delta.delta).join("")).not.toContain("�");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runProcess flushes pending output before abort rejection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-process-abort-"));
  const controller = new AbortController();
  const deltas: string[] = [];
  try {
    const run = runProcess("bash", ["-lc", "printf before; sleep 5"], {
      cwd: workspace,
      signal: controller.signal,
      killGraceMs: 50,
      outputFlushIntervalMs: 1_000,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") deltas.push(chunk.delta);
      },
    });
    await sleep(80);
    controller.abort();

    await expect(run).rejects.toThrow("Process aborted");
    expect(deltas.join("")).toContain("before");
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
