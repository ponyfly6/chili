import { expect, test } from "bun:test";
import {
  PERSISTED_ERROR_LIMITS,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@chili/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, type BashRunner } from "./builtins/bash.js";
import type { ChiliToolExecutionContext } from "./types.js";

test("bash bounds and redacts a hostile persisted-output registration error before returning success", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-bash-persistence-error-"));
  const password = "bash-registration-password-secret";
  const authorization = "bash-registration-authorization-secret";
  const hostileBody = "\\\"\u001b".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const hostile = new Error(
    `password=${password}\0\nAuthorization Basic ${authorization}\n${hostileBody}`,
  );
  hostile.name = "RemotePersistenceError";
  let stackReads = 0;
  let causeReads = 0;
  Object.defineProperties(hostile, {
    stack: {
      configurable: true,
      get() {
        stackReads += 1;
        return `stack password=${password}`;
      },
    },
    cause: {
      configurable: true,
      get() {
        causeReads += 1;
        return new Error(`cause password=${password}`);
      },
    },
  });

  const runner: BashRunner = {
    async run(request) {
      const output = Buffer.alloc(60 * 1024, 120);
      await request.onRawOutput?.({ stream: "stdout", chunk: output });
      return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        stdoutBytes: output.byteLength,
        stderrBytes: 0,
        outputLimitBytes: request.maxOutputBytes,
        durationMs: 1,
        timedOut: false,
        aborted: false,
      };
    },
  };
  const context: ChiliToolExecutionContext = {
    sessionId: "session_bash_persistence_error" as SessionId,
    turnId: "turn_bash_persistence_error" as TurnId,
    callId: "toolcall_bash_persistence_error" as ToolCallId,
    outputArtifactId: "tooloutput_bash_persistence_error" as ToolCallId,
    signal: new AbortController().signal,
    cwd: workspace,
    metadata: async () => undefined,
    streamOutput: async () => undefined,
    registerPersistedOutput: async () => {
      throw hostile;
    },
  };

  try {
    const result = await createBashTool({ runner }).execute({ command: "printf ignored" }, context);
    const persistenceError = result.metadata?.outputPersistenceError;

    expect(typeof persistenceError).toBe("string");
    if (typeof persistenceError !== "string") return;
    expect(Buffer.byteLength(persistenceError, "utf8"))
      .toBe(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(persistenceError).toContain("password=[REDACTED]");
    expect(persistenceError).toContain("Authorization Basic [REDACTED]");
    expect(persistenceError).toContain("[error message truncated from");
    expect(persistenceError).not.toContain(password);
    expect(persistenceError).not.toContain(authorization);
    expect(persistenceError).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
    expect(result.output).toContain("output could not be persisted");
    expect(result.output).toContain(persistenceError);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(authorization);
    expect(stackReads).toBe(0);
    expect(causeReads).toBe(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
