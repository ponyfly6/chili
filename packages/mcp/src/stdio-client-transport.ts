import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
 * Keeps the SDK's process spawning and stdio compatibility while replacing its
 * unbounded ReadBuffer with a bounded implementation.
 */
export class BoundedStdioClientTransport extends StdioClientTransport {
  private readonly boundedReadBuffer: BoundedStdioReadBuffer;
  private closePromise: Promise<void> | undefined;
  private closeHandler: (() => void) | undefined;
  private closeHandlerCaptured = false;
  private closeEmitted = false;
  private terminalError: McpStdioFrameTooLargeError | undefined;
  private readonly onFatalError: ((error: McpStdioFrameTooLargeError) => void) | undefined;

  constructor(
    server: StdioServerParameters,
    options: BoundedStdioClientTransportOptions = {},
  ) {
    super(server);
    this.onFatalError = options.onFatalError;
    this.boundedReadBuffer = new BoundedStdioReadBuffer(
      options.maxFrameBytes ?? DEFAULT_MCP_STDIO_MAX_FRAME_BYTES,
      (error) => this.fail(error),
    );
    (this as unknown as { _readBuffer: BoundedStdioReadBuffer })._readBuffer = this.boundedReadBuffer;
  }

  override start(): Promise<void> {
    this.captureCloseHandler();
    return super.start();
  }

  override close(): Promise<void> {
    if (!this.closePromise) {
      this.captureCloseHandler();
      this.closePromise = this.closeTransport();
    }
    return this.closePromise;
  }

  private async closeTransport(): Promise<void> {
    this.boundedReadBuffer.stop();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    child?.stdout?.pause();
    child?.stdout?.removeAllListeners("data");
    child?.stdout?.destroy();

    try {
      await super.close();
    } finally {
      this.emitCloseOnce();
    }
  }

  private fail(error: McpStdioFrameTooLargeError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    try {
      this.onFatalError?.(error);
    } catch {
      // A fatal-state observer must not prevent SDK error delivery or cleanup.
    }
    try {
      this.onerror?.(error);
    } catch {
      // An observer must not prevent terminal transport cleanup.
    }
    void this.close().catch(() => undefined);
  }

  private captureCloseHandler(): void {
    if (this.closeHandlerCaptured) return;
    this.closeHandlerCaptured = true;
    this.closeHandler = this.onclose;
    this.onclose = () => this.emitCloseOnce();
  }

  private emitCloseOnce(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closeHandler?.();
  }
}
