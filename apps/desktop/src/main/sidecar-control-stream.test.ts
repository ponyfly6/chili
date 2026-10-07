import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { terminateProcessGroup } from "./process-groups.js";
import { MAX_DESKTOP_ERROR_MESSAGE_BYTES } from "../shared/safe-error.js";
import {
  encodeSidecarCredentialFrame,
  createSidecarStartupErrorMessage,
  MAX_SIDECAR_CREDENTIAL_FRAME_BYTES,
  MAX_SIDECAR_CONTROL_LINE_BYTES,
  observeSidecarControlStream,
  observeSidecarTermination,
  parseSidecarCredentialFrame,
  readSidecarCredentialStream,
  type SidecarExitInfo,
} from "./sidecar-control-stream.js";

const FIXTURE_CREDENTIAL = "A".repeat(43);

describe("sidecar credential channel", () => {
  test("round-trips one exact versioned base64url credential frame", async () => {
    const frame = encodeSidecarCredentialFrame(FIXTURE_CREDENTIAL);
    expect(parseSidecarCredentialFrame(frame)).toBe(FIXTURE_CREDENTIAL);

    const stream = new PassThrough();
    const credential = readSidecarCredentialStream(stream);
    const text = frame.toString("ascii");
    frame.fill(0);
    stream.write(text.slice(0, 7));
    stream.write(text.slice(7, 31));
    stream.end(text.slice(31));

    expect(await credential).toBe(FIXTURE_CREDENTIAL);
  });

  test("rejects invalid outbound credentials before writing a frame", () => {
    expect(() => encodeSidecarCredentialFrame("not-base64url"))
      .toThrow("Sidecar credential token is invalid");
  });

  test("fails closed on missing, malformed, and trailing credential bytes", async () => {
    const missing = new PassThrough();
    const missingCredential = readSidecarCredentialStream(missing);
    missing.end();
    await expect(missingCredential).rejects.toThrow("EOF before a frame");

    const malformed = new PassThrough();
    const malformedCredential = readSidecarCredentialStream(malformed);
    malformed.end("not-a-credential-frame\n");
    await expect(malformedCredential).rejects.toThrow("EOF with a malformed frame");

    const trailing = new PassThrough();
    const trailingCredential = readSidecarCredentialStream(trailing);
    const validFrame = encodeSidecarCredentialFrame(FIXTURE_CREDENTIAL);
    trailing.end(Buffer.concat([validFrame, Buffer.from("x")]));
    await expect(trailingCredential).rejects.toThrow("EOF with a malformed frame");
    validFrame.fill(0);
  });

  test("fails closed immediately when the credential frame is oversized", async () => {
    const stream = new PassThrough();
    const credential = readSidecarCredentialStream(stream, 1_000);
    stream.write(Buffer.alloc(MAX_SIDECAR_CREDENTIAL_FRAME_BYTES + 1, 0x78));

    await expect(credential).rejects.toThrow(
      `Sidecar credential frame exceeds ${MAX_SIDECAR_CREDENTIAL_FRAME_BYTES} bytes`,
    );
    expect(stream.destroyed).toBe(true);
  });

  test("fails closed on timeout and a close before EOF", async () => {
    const stalled = new PassThrough();
    await expect(readSidecarCredentialStream(stalled, 10)).rejects.toThrow(
      "Sidecar credential handshake timed out",
    );
    expect(stalled.destroyed).toBe(true);

    const closed = new PassThrough();
    const credential = readSidecarCredentialStream(closed, 1_000);
    closed.destroy();
    await expect(credential).rejects.toThrow("closed before EOF");
  });
});

describe("sidecar control stream", () => {
  test("redacts startup credentials before UTF-8 diagnostic truncation", () => {
    const diagnostic = createSidecarStartupErrorMessage(new Error(
      `${"界".repeat(675)} ${FIXTURE_CREDENTIAL} api_key=private-key`,
    ), FIXTURE_CREDENTIAL);
    expect(diagnostic.type).toBe("chili.sidecar.startup_error");
    expect(Buffer.byteLength(diagnostic.message, "utf8")).toBeLessThanOrEqual(MAX_DESKTOP_ERROR_MESSAGE_BYTES);
    expect(diagnostic.message).not.toContain("AAA");
    expect(diagnostic.message).not.toContain("private-key");
  });

  test("retains a structured startup failure and redacts secrets before rejecting readiness", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const logs: string[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, FIXTURE_CREDENTIAL, {
      onProcess: () => undefined,
      onLog: (text) => logs.push(text),
      onFatal: () => undefined,
    });
    const failure = observer.ready.catch((error: Error) => error);
    const line = `${JSON.stringify({
      type: "chili.sidecar.startup_error",
      message: `no such column: parent_session_id\napi_key=private-key ${FIXTURE_CREDENTIAL}`,
    })}\n`;
    stream.write(line.slice(0, 17));
    stream.write(line.slice(17));
    exit.resolve({ code: 1, signal: null });

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("no such column: parent_session_id");
    expect(message).not.toContain("private-key");
    expect(message).not.toContain(FIXTURE_CREDENTIAL);
    expect(message).not.toContain("\n");
    expect(logs).toEqual([]);
    observer.dispose();
    stream.end();
  });

  test("rejects malformed startup diagnostic frames without reflecting their contents", async () => {
    for (const frame of [
      { message: "" },
      { message: { secret: "private-value" } },
      { message: "private-value", extra: "unexpected" },
      { message: "界".repeat(Math.ceil(MAX_DESKTOP_ERROR_MESSAGE_BYTES / 3)) },
    ]) {
      const stream = new PassThrough();
      const exit = deferred<SidecarExitInfo>();
      const logs: string[] = [];
      const observer = observeSidecarControlStream(stream, exit.promise, FIXTURE_CREDENTIAL, {
        onProcess: () => undefined,
        onLog: (text) => logs.push(text),
        onFatal: () => undefined,
      });
      stream.write(`${JSON.stringify({ type: "chili.sidecar.startup_error", ...frame })}\n`);
      await expect(observer.ready).rejects.toThrow("Sidecar reported an invalid startup failure");
      expect(logs).toEqual([]);
      observer.dispose();
      stream.end();
    }
  });

  test("reports a post-ready diagnostic once and keeps draining process cleanup frames", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const failures: Error[] = [];
    const processMessages: unknown[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, FIXTURE_CREDENTIAL, {
      onProcess: (message) => processMessages.push(message),
      onLog: () => undefined,
      onFatal: (error) => failures.push(error),
    });
    stream.write(`${JSON.stringify({ type: "chili.sidecar.ready", url: "http://127.0.0.1:3210", pid: 42 })}\n`);
    await observer.ready;
    const diagnostic = `${JSON.stringify({ type: "chili.sidecar.startup_error", message: "startup failed" })}\n`;
    stream.write(diagnostic + diagnostic);
    stream.write(`${JSON.stringify({ type: "chili.sidecar.process", action: "finished", pid: 43 })}\n`);
    expect(failures.map((error) => error.message)).toEqual(["startup failed"]);
    expect(processMessages).toEqual([{ type: "chili.sidecar.process", action: "finished", pid: 43 }]);
    observer.dispose();
    stream.end();
  });

  test("keeps draining process frames after ready without exposing the token", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const processGroups = new Set<number>();
    const logs: string[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, "secret-token", {
      onProcess(message) {
        if (message.action === "started") processGroups.add(message.pid);
        else processGroups.delete(message.pid);
      },
      onLog: (text) => logs.push(text),
      onFatal: () => undefined,
    });

    stream.write(`${JSON.stringify({ type: "chili.sidecar.ready", url: "http://127.0.0.1:3210", pid: 42 })}\n`);
    expect(await observer.ready).toEqual({
      type: "chili.sidecar.ready",
      url: "http://127.0.0.1:3210",
      pid: 42,
    });
    for (let pid = 100; pid < 5_100; pid += 1) {
      stream.write(`${JSON.stringify({ type: "chili.sidecar.process", action: "started", pid })}\n`);
      stream.write(`${JSON.stringify({ type: "chili.sidecar.process", action: "finished", pid })}\n`);
    }
    stream.write("post-ready secret-token log\n");
    await Promise.resolve();

    expect(processGroups.size).toBe(0);
    expect(logs).toContain("post-ready [redacted] log");
    observer.dispose();
    stream.end();
  });

  test("accepts an exact-limit UTF-8 control frame followed by a newline", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const observer = observeSidecarControlStream(stream, exit.promise, "token", {
      onProcess: () => undefined,
      onLog: () => undefined,
      onFatal: () => undefined,
    });
    const line = exactLimitReadyLine();
    expect(Buffer.byteLength(line, "utf8")).toBe(MAX_SIDECAR_CONTROL_LINE_BYTES);

    stream.write(`${line}\n`);

    expect(await observer.ready).toEqual({
      type: "chili.sidecar.ready",
      url: "http://127.0.0.1:3210",
      pid: 42,
    });
    observer.dispose();
    stream.end();
  });

  test("rejects a limit-plus-one unterminated frame once and stops parsing", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const processMessages: unknown[] = [];
    const logs: string[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, "token", {
      onProcess: (message) => processMessages.push(message),
      onLog: (text) => logs.push(text),
      onFatal: () => undefined,
    });

    stream.write("x".repeat(MAX_SIDECAR_CONTROL_LINE_BYTES + 1));
    stream.write(`${JSON.stringify({ type: "chili.sidecar.ready", url: "http://127.0.0.1:3210", pid: 42 })}\n`);

    await expect(observer.ready).rejects.toThrow(
      `Sidecar control frame exceeds the ${MAX_SIDECAR_CONTROL_LINE_BYTES}-byte UTF-8 line limit`,
    );
    expect(processMessages).toEqual([]);
    expect(logs).toEqual([]);
    observer.dispose();
    stream.end();
  });

  test("parses multiple complete control frames from one chunk", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const processMessages: unknown[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, "token", {
      onProcess: (message) => processMessages.push(message),
      onLog: () => undefined,
      onFatal: () => undefined,
    });
    const ready = JSON.stringify({ type: "chili.sidecar.ready", url: "http://127.0.0.1:3210", pid: 42 });
    const started = JSON.stringify({ type: "chili.sidecar.process", action: "started", pid: 100 });
    const finished = JSON.stringify({ type: "chili.sidecar.process", action: "finished", pid: 100 });

    stream.write(`${ready}\n${started}\n${finished}\n`);

    await observer.ready;
    expect(processMessages).toEqual([
      { type: "chili.sidecar.process", action: "started", pid: 100 },
      { type: "chili.sidecar.process", action: "finished", pid: 100 },
    ]);
    observer.dispose();
    stream.end();
  });

  test("counts UTF-8 bytes and reports one terminal overflow after ready", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const processMessages: unknown[] = [];
    const logs: string[] = [];
    const fatals: string[] = [];
    const observer = observeSidecarControlStream(stream, exit.promise, "token", {
      onProcess: (message) => processMessages.push(message),
      onLog: (text) => logs.push(text),
      onFatal: (error) => fatals.push(error.message),
    });
    stream.write(`${JSON.stringify({ type: "chili.sidecar.ready", url: "http://127.0.0.1:3210", pid: 42 })}\n`);
    await observer.ready;
    const multibyte = "界".repeat(Math.floor(MAX_SIDECAR_CONTROL_LINE_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(MAX_SIDECAR_CONTROL_LINE_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(MAX_SIDECAR_CONTROL_LINE_BYTES);

    stream.write(multibyte);
    stream.write(multibyte);
    stream.write(`${JSON.stringify({ type: "chili.sidecar.process", action: "started", pid: 100 })}\n`);

    expect(logs).toEqual([]);
    expect(fatals).toEqual([
      `Sidecar control frame exceeds the ${MAX_SIDECAR_CONTROL_LINE_BYTES}-byte UTF-8 line limit`,
    ]);
    expect(processMessages).toEqual([]);
    observer.dispose();
    stream.end();
  });

  test("rejects readiness from the exit signal without waiting for stream close", async () => {
    const stream = new PassThrough();
    const exit = deferred<SidecarExitInfo>();
    const observer = observeSidecarControlStream(stream, exit.promise, "token", {
      onProcess: () => undefined,
      onLog: () => undefined,
      onFatal: () => undefined,
    }, 10_000);

    exit.resolve({ code: 9, signal: null });
    await expect(observer.ready).rejects.toThrow("exited before ready");
    observer.dispose();
    stream.end();
  });

  test("reports leader exit even while a descendant keeps stdout open", async () => {
    if (process.platform === "win32") return;
    const child = spawn("bash", ["-lc", "sleep 5 & exit 23"], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const leaderPid = child.pid;
    if (!leaderPid) throw new Error("Fixture did not start");
    const termination = observeSidecarTermination(child);
    try {
      expect(await termination.exit).toMatchObject({ code: 23, signal: null });
      expect(await settlesWithin(termination.closed, 50)).toBe(false);
    } finally {
      await terminateProcessGroup(leaderPid, { termGraceMs: 50, killGraceMs: 500 });
    }
    expect(await settlesWithin(termination.closed, 1_000)).toBe(true);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function exactLimitReadyLine(): string {
  const prefix = '{"type":"chili.sidecar.ready","url":"http://127.0.0.1:3210","pid":42,"padding":"';
  const suffix = '"}';
  const paddingBytes = MAX_SIDECAR_CONTROL_LINE_BYTES
    - Buffer.byteLength(prefix, "utf8")
    - Buffer.byteLength(suffix, "utf8");
  if (paddingBytes < 0) throw new Error("Ready frame prefix exceeds the control line limit");
  return `${prefix}${"x".repeat(paddingBytes)}${suffix}`;
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
