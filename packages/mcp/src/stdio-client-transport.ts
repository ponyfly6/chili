import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { deserializeMessage, type JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ChildProcess } from "node:child_process";

export const DEFAULT_MCP_STDIO_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface BoundedStdioClientTransportOptions {
  maxFrameBytes?: number;
  onFatalError?: (error: McpStdioFrameTooLargeError) => void;
}

export class McpStdioFrameTooLargeError extends Error {
  readonly code = "MCP_STDIO_FRAME_TOO_LARGE";

  constructor(readonly maxFrameBytes: number) {
    super(`MCP stdio frame exceeds ${maxFrameBytes} bytes before newline.`);
    this.name = "McpStdioFrameTooLargeError";
  }
}

/**
 * A newline-delimited JSON-RPC buffer that enforces its limit before joining,
 * decoding, or parsing a frame.
 */
export class BoundedStdioReadBuffer {
  private chunks: Buffer[] = [];
  private frameBytes = 0;
  private frames: Buffer[] = [];
  private terminal = false;

  constructor(
    readonly maxFrameBytes: number,
    private readonly onTerminalError: (error: McpStdioFrameTooLargeError) => void,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new Error("MCP stdio maxFrameBytes must be a positive safe integer.");
    }
  }

  get bufferedBytes(): number {
    return this.frameBytes;
  }

  append(chunk: Buffer): void {
    if (this.terminal || chunk.byteLength === 0) return;

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendSegment(chunk, offset, chunk.byteLength);
        return;
      }

      if (!this.appendSegment(chunk, offset, newline)) return;
      this.finishFrame();
      offset = newline + 1;
    }
  }

  readMessage(): JSONRPCMessage | null {
    const frame = this.frames.shift();
    if (!frame) return null;
    const end = frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d
      ? frame.byteLength - 1
      : frame.byteLength;
    return deserializeMessage(frame.toString("utf8", 0, end));
  }

  clear(): void {
    this.chunks = [];
    this.frameBytes = 0;
    this.frames = [];
  }

  stop(): void {
    this.terminal = true;
    this.clear();
  }

  private appendSegment(chunk: Buffer, start: number, end: number): boolean {
    const segmentBytes = end - start;
    if (segmentBytes === 0) return true;
    if (segmentBytes > this.maxFrameBytes - this.frameBytes) {
      this.fail(new McpStdioFrameTooLargeError(this.maxFrameBytes));
      return false;
    }

    this.chunks.push(chunk.subarray(start, end));
    this.frameBytes += segmentBytes;
    return true;
  }

  private finishFrame(): void {
    this.frames.push(this.joinFrame());
    this.chunks = [];
    this.frameBytes = 0;
  }

  private joinFrame(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0]!;
    return Buffer.concat(this.chunks, this.frameBytes);
  }

  private fail(error: McpStdioFrameTooLargeError): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clear();
    this.onTerminalError(error);
  }
}

/**
 * Return the SDK's exact transport class so v2 negotiates on a disposable
 * sibling. A subclass would probe the actual session and exhaust strict legacy
 * servers that exit on a request before initialize. The sibling inherits the
 * native maxBufferSize guard; the session retains our per-frame guard.
 */
export function createBoundedStdioClientTransport(
  server: StdioServerParameters,
  options: BoundedStdioClientTransportOptions = {},
): StdioClientTransport {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MCP_STDIO_MAX_FRAME_BYTES;
  const transport = new StdioClientTransport({ ...server, maxBufferSize: maxFrameBytes });
  let closePromise: Promise<void> | undefined;
  let closeHandler: (() => void) | undefined;
  let closeHandlerCaptured = false;
  let closeEmitted = false;
  let terminalError: McpStdioFrameTooLargeError | undefined;
  const originalStart = transport.start.bind(transport);
  const originalClose = transport.close.bind(transport);
  const boundedReadBuffer = new BoundedStdioReadBuffer(maxFrameBytes, fail);
  (transport as unknown as { _readBuffer: BoundedStdioReadBuffer })._readBuffer = boundedReadBuffer;

  transport.start = () => {
    captureCloseHandler();
    return originalStart();
  };
  transport.close = () => {
    if (!closePromise) {
      captureCloseHandler();
      closePromise = closeTransport();
    }
    return closePromise;
  };
  return transport;

  async function closeTransport(): Promise<void> {
    boundedReadBuffer.stop();
    const child = (transport as unknown as { _process?: ChildProcess })._process;
    child?.stdout?.pause();
    child?.stdout?.removeAllListeners("data");
    child?.stdout?.destroy();

    try {
      await originalClose();
    } finally {
      emitCloseOnce();
    }
  }

  function fail(error: McpStdioFrameTooLargeError): void {
    if (terminalError) return;
    terminalError = error;
    try {
      options.onFatalError?.(error);
    } catch {
      // A fatal-state observer must not prevent SDK error delivery or cleanup.
    }
    try {
      transport.onerror?.(error);
    } catch {
      // An observer must not prevent terminal transport cleanup.
    }
    void transport.close().catch(() => undefined);
  }

  function captureCloseHandler(): void {
    if (closeHandlerCaptured) return;
    closeHandlerCaptured = true;
    closeHandler = transport.onclose;
    transport.onclose = emitCloseOnce;
  }

  function emitCloseOnce(): void {
    if (closeEmitted) return;
    closeEmitted = true;
    closeHandler?.();
  }
}
