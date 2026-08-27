import type { Readable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const SIDECAR_READY_TYPE = "chili.sidecar.ready";
export const SIDECAR_PROCESS_TYPE = "chili.sidecar.process";
export const MAX_SIDECAR_CONTROL_LINE_BYTES = 64 * 1024;
export const SIDECAR_CREDENTIAL_FD = 3;
export const SIDECAR_CREDENTIAL_HANDSHAKE_TIMEOUT_MS = 5_000;
export const MAX_SIDECAR_CREDENTIAL_FRAME_BYTES = 128;

const SIDECAR_CREDENTIAL_FRAME_PREFIX = Buffer.from(
  "chili.sidecar.credential.v1:",
  "ascii",
);
const SIDECAR_CREDENTIAL_TOKEN_BYTES = 43;
const SIDECAR_CREDENTIAL_FRAME_BYTES =
  SIDECAR_CREDENTIAL_FRAME_PREFIX.length + SIDECAR_CREDENTIAL_TOKEN_BYTES + 1;

const SIDECAR_CONTROL_LINE_LIMIT_MESSAGE =
  `Sidecar control frame exceeds the ${MAX_SIDECAR_CONTROL_LINE_BYTES}-byte UTF-8 line limit`;

export interface SidecarReadyMessage {
  type: typeof SIDECAR_READY_TYPE;
  url: string;
  pid: number;
}

export interface SidecarProcessMessage {
  type: typeof SIDECAR_PROCESS_TYPE;
  action: "started" | "finished";
  pid: number;
}

export interface SidecarExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function encodeSidecarCredentialFrame(token: string): Buffer {
  if (!isBase64UrlCredential(token)) {
    throw new Error("Sidecar credential token is invalid");
  }
  const frame = Buffer.allocUnsafe(SIDECAR_CREDENTIAL_FRAME_BYTES);
  SIDECAR_CREDENTIAL_FRAME_PREFIX.copy(frame, 0);
  frame.write(token, SIDECAR_CREDENTIAL_FRAME_PREFIX.length, "ascii");
  frame[frame.length - 1] = 0x0a;
  return frame;
}

export function parseSidecarCredentialFrame(frame: Buffer): string {
  if (
    frame.length !== SIDECAR_CREDENTIAL_FRAME_BYTES
    || frame[frame.length - 1] !== 0x0a
    || !frame.subarray(0, SIDECAR_CREDENTIAL_FRAME_PREFIX.length)
      .equals(SIDECAR_CREDENTIAL_FRAME_PREFIX)
  ) {
    throw new Error("Sidecar credential frame is malformed");
  }
  const token = frame.subarray(
    SIDECAR_CREDENTIAL_FRAME_PREFIX.length,
    SIDECAR_CREDENTIAL_FRAME_PREFIX.length + SIDECAR_CREDENTIAL_TOKEN_BYTES,
  ).toString("ascii");
  if (!isBase64UrlCredential(token)) {
    throw new Error("Sidecar credential frame is malformed");
  }
  return token;
}

export function readSidecarCredentialStream(
  stream: Readable,
  timeoutMs = SIDECAR_CREDENTIAL_HANDSHAKE_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Sidecar credential handshake timeout is invalid"));
  }
  const frame = Buffer.alloc(MAX_SIDECAR_CREDENTIAL_FRAME_BYTES);
  let frameBytes = 0;
  let settled = false;
  let ended = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return new Promise<string>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const rejectHandshake = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      frame.fill(0);
      stream.destroy();
      rejectPromise(error);
    };
    const onData = (chunk: string | Buffer): void => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (bytes.length > MAX_SIDECAR_CREDENTIAL_FRAME_BYTES - frameBytes) {
        bytes.fill(0);
        rejectHandshake(new Error(
          `Sidecar credential frame exceeds ${MAX_SIDECAR_CREDENTIAL_FRAME_BYTES} bytes`,
        ));
        return;
      }
      bytes.copy(frame, frameBytes);
      frameBytes += bytes.length;
      bytes.fill(0);
    };
    const onEnd = (): void => {
      if (settled) return;
      ended = true;
      if (frameBytes === 0) {
        rejectHandshake(new Error("Sidecar credential channel reached EOF before a frame"));
        return;
      }
      let token: string;
      try {
        token = parseSidecarCredentialFrame(frame.subarray(0, frameBytes));
      } catch {
        rejectHandshake(new Error("Sidecar credential channel reached EOF with a malformed frame"));
        return;
      }
      settled = true;
      cleanup();
      frame.fill(0);
      resolvePromise(token);
    };
    const onClose = (): void => {
      if (!settled && !ended) {
        rejectHandshake(new Error("Sidecar credential channel closed before EOF"));
      }
    };
    const onError = (): void => {
      rejectHandshake(new Error("Sidecar credential channel failed"));
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
    timeout = setTimeout(() => {
      rejectHandshake(new Error("Sidecar credential handshake timed out"));
    }, timeoutMs);
    timeout.unref?.();
  });
}

function isBase64UrlCredential(token: string): boolean {
  return token.length === SIDECAR_CREDENTIAL_TOKEN_BYTES
    && /^[A-Za-z0-9_-]+$/u.test(token);
}

export function observeSidecarTermination(child: ChildProcessWithoutNullStreams): {
  exit: Promise<SidecarExitInfo>;
  closed: Promise<SidecarExitInfo>;
} {
  let resolveExit: ((info: SidecarExitInfo) => void) | undefined;
  let resolveClosed: ((info: SidecarExitInfo) => void) | undefined;
  let exitInfo: SidecarExitInfo | undefined;
  const exit = new Promise<SidecarExitInfo>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const closed = new Promise<SidecarExitInfo>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    resolveExit?.(exitInfo);
  });
  child.once("close", (code, signal) => {
    const info = exitInfo ?? { code, signal };
    resolveExit?.(info);
    resolveClosed?.(info);
  });
  child.once("error", (error) => {
    const info: SidecarExitInfo = { code: null, signal: null, error };
    exitInfo = info;
    resolveExit?.(info);
    resolveClosed?.(info);
  });
  return { exit, closed };
}

export function observeSidecarControlStream(
  stream: Readable,
  exit: Promise<SidecarExitInfo>,
  token: string,
  callbacks: {
    onProcess(message: SidecarProcessMessage): void;
    onLog(text: string): void;
    onFatal(error: Error): void;
  },
  timeoutMs = 45_000,
): { ready: Promise<SidecarReadyMessage>; dispose(): void } {
  let buffer = "";
  let bufferBytes = 0;
  let readySettled = false;
  let disposed = false;
  let resolveReady: ((ready: SidecarReadyMessage) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<SidecarReadyMessage>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const timeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady?.(new Error(`Sidecar did not become ready within ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref?.();

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      callbacks.onLog(redactControlLog(line, token));
      return;
    }
    const readyMessage = parseSidecarReadyMessage(parsed);
    if (readyMessage) {
      if (!readySettled) {
        readySettled = true;
        clearTimeout(timeout);
        resolveReady?.(readyMessage);
      }
      return;
    }
    const processMessage = parseSidecarProcessMessage(parsed);
    if (processMessage) {
      callbacks.onProcess(processMessage);
      return;
    }
    callbacks.onLog(redactControlLog(line, token));
  };

  const failLineLimit = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    stream.off("data", onData);
    buffer = "";
    bufferBytes = 0;
    const error = new Error(SIDECAR_CONTROL_LINE_LIMIT_MESSAGE);
    if (!readySettled) {
      readySettled = true;
      rejectReady?.(error);
    } else {
      callbacks.onFatal(error);
    }
  };

  const appendSegment = (segment: string): boolean => {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (segmentBytes > MAX_SIDECAR_CONTROL_LINE_BYTES - bufferBytes) {
      failLineLimit();
      return false;
    }
    buffer += segment;
    bufferBytes += segmentBytes;
    return true;
  };

  const onData = (chunk: string | Buffer): void => {
    if (disposed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      if (!appendSegment(text.slice(offset, end))) return;
      if (newline < 0) return;
      const line = buffer;
      buffer = "";
      bufferBytes = 0;
      consumeLine(line);
      offset = newline + 1;
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", onData);
  void exit.then((info) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(timeout);
    rejectReady?.(
      info.error
        ?? new Error(`Sidecar exited before ready (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`),
    );
  });

  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      stream.off("data", onData);
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
      bufferBytes = 0;
    },
  };
}

export function parseSidecarReadyMessage(value: unknown): SidecarReadyMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== SIDECAR_READY_TYPE || typeof record.url !== "string") return undefined;
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
  return { type: SIDECAR_READY_TYPE, url: record.url, pid: record.pid };
}

export function parseSidecarProcessMessage(value: unknown): SidecarProcessMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type !== SIDECAR_PROCESS_TYPE
    || (record.action !== "started" && record.action !== "finished")
  ) return undefined;
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
  return { type: SIDECAR_PROCESS_TYPE, action: record.action, pid: record.pid };
}

export function redactControlLog(text: string, token: string): string {
  return text.replaceAll(token, "[redacted]").trimEnd();
}
