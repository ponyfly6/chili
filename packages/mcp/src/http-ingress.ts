export interface McpHttpIngressLimits {
  maxBodyBytes: number;
  maxErrorBodyBytes: number;
  maxSseFrameBytes: number;
  maxSseFrameLines: number;
}

export const DEFAULT_MCP_HTTP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MCP_HTTP_INGRESS_LIMITS: McpHttpIngressLimits = {
  maxBodyBytes: DEFAULT_MCP_HTTP_MAX_MESSAGE_BYTES,
  maxErrorBodyBytes: 64_000,
  maxSseFrameBytes: DEFAULT_MCP_HTTP_MAX_MESSAGE_BYTES,
  maxSseFrameLines: 4_096,
};

export type McpHttpIngressLimitKind =
  | "response-body-bytes"
  | "error-body-bytes"
  | "sse-frame-bytes"
  | "sse-frame-lines";

export type McpHttpIngressLimitSource = "content-length" | "stream";

export class McpHttpIngressLimitError extends Error {
  readonly code = "MCP_HTTP_INGRESS_LIMIT";

  constructor(
    readonly kind: McpHttpIngressLimitKind,
    readonly limit: number,
    readonly observed: number,
    readonly source: McpHttpIngressLimitSource,
  ) {
    super(`MCP HTTP ingress ${kind} exceeded limit ${limit} (observed ${observed} via ${source})`);
    this.name = "McpHttpIngressLimitError";
  }
}

export interface BoundedMcpFetchOptions {
  limits?: Partial<McpHttpIngressLimits>;
  onLimit?: (error: McpHttpIngressLimitError) => void;
}

export function createBoundedMcpFetch(
  baseFetch: typeof fetch = fetch,
  options: BoundedMcpFetchOptions = {},
): typeof fetch {
  const limits = normalizeLimits(options.limits);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);
    if (!response.body) return response;

    const contentType = response.headers.get("content-type");
    if (response.ok && isEventStreamContentType(contentType)) {
      const inspector = new SseFrameInspector(
        limits.maxSseFrameBytes,
        limits.maxSseFrameLines,
        options.onLimit,
      );
      return replaceResponseBody(response, createInspectedBody(response.body, inspector));
    }

    const kind: McpHttpIngressLimitKind = response.ok ? "response-body-bytes" : "error-body-bytes";
    const limit = response.ok ? limits.maxBodyBytes : limits.maxErrorBodyBytes;
    const declaredBytes = parseContentLength(response.headers.get("content-length"));
    if (declaredBytes !== undefined && declaredBytes > limit) {
      const error = new McpHttpIngressLimitError(kind, limit, declaredBytes, "content-length");
      notifyLimit(options.onLimit, error);
      await response.body.cancel(error).catch(() => undefined);
      throw error;
    }

    const inspector = new BodyByteInspector(kind, limit, options.onLimit);
    return replaceResponseBody(response, createInspectedBody(response.body, inspector));
  }) as typeof fetch;
}

interface ByteInspector {
  inspect(chunk: Uint8Array): void;
  finish(): void;
}

type ByteReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

class BodyByteInspector implements ByteInspector {
  private observed = 0;

  constructor(
    private readonly kind: McpHttpIngressLimitKind,
    private readonly limit: number,
    private readonly onLimit: ((error: McpHttpIngressLimitError) => void) | undefined,
  ) {}

  inspect(chunk: Uint8Array): void {
    this.observed += chunk.byteLength;
    if (this.observed <= this.limit) return;
    const error = new McpHttpIngressLimitError(this.kind, this.limit, this.observed, "stream");
    notifyLimit(this.onLimit, error);
    throw error;
  }

  finish(): void {}
}

class SseFrameInspector implements ByteInspector {
  // Count raw UTF-8 bytes for every non-empty SSE field/comment line, including
  // that line's LF, CR, or CRLF terminator. The terminating blank line is framing
  // between events and is excluded before the next frame starts at zero.
  private frameBytes = 0;
  private frameLines = 0;
  private lineBytes = 0;
  private afterCarriageReturn = false;
  private carriageReturnEndedContentLine = false;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly maxFrameLines: number,
    private readonly onLimit: ((error: McpHttpIngressLimitError) => void) | undefined,
  ) {}

  inspect(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.afterCarriageReturn) {
        this.afterCarriageReturn = false;
        if (byte === LF) {
          if (this.carriageReturnEndedContentLine) this.addFrameBytes(1);
          continue;
        }
      }

      if (byte === CR) {
        this.carriageReturnEndedContentLine = this.lineBytes > 0;
        if (this.carriageReturnEndedContentLine) {
          this.addFrameBytes(1);
          this.finishContentLine();
        } else {
          this.finishFrame();
        }
        this.afterCarriageReturn = true;
        continue;
      }
      if (byte === LF) {
        if (this.lineBytes > 0) {
          this.addFrameBytes(1);
          this.finishContentLine();
        } else {
          this.finishFrame();
        }
        continue;
      }

      this.addFrameBytes(1);
      this.lineBytes += 1;
    }
  }

  finish(): void {
    this.afterCarriageReturn = false;
    if (this.lineBytes > 0) this.finishContentLine();
  }

  private finishContentLine(): void {
    this.lineBytes = 0;
    this.frameLines += 1;
    if (this.frameLines <= this.maxFrameLines) return;
    this.fail("sse-frame-lines", this.maxFrameLines, this.frameLines);
  }

  private finishFrame(): void {
    this.frameBytes = 0;
    this.frameLines = 0;
  }

  private addFrameBytes(bytes: number): void {
    this.frameBytes += bytes;
    if (this.frameBytes <= this.maxFrameBytes) return;
    this.fail("sse-frame-bytes", this.maxFrameBytes, this.frameBytes);
  }

  private fail(kind: "sse-frame-bytes" | "sse-frame-lines", limit: number, observed: number): never {
    const error = new McpHttpIngressLimitError(kind, limit, observed, "stream");
    notifyLimit(this.onLimit, error);
    throw error;
  }
}

const LF = 0x0a;
const CR = 0x0d;

function createInspectedBody(body: ReadableStream<Uint8Array>, inspector: ByteInspector): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const cancelReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } catch {
      // Preserve the ingress-limit error when a source rejects cancellation.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ByteReadResult;
      try {
        result = await reader.read();
      } catch (error) {
        release();
        controller.error(error);
        return;
      }

      if (result.done) {
        try {
          inspector.finish();
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          release();
        }
        return;
      }

      try {
        inspector.inspect(result.value);
      } catch (error) {
        await cancelReader(error);
        release();
        controller.error(error);
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      await cancelReader(reason);
      release();
    },
  }, { highWaterMark: 0 });
}

function replaceResponseBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const replacement = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(replacement, {
    url: { configurable: true, value: response.url },
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
  });
  return replacement;
}

function normalizeLimits(input: Partial<McpHttpIngressLimits> | undefined): McpHttpIngressLimits {
  return {
    maxBodyBytes: positiveLimit(input?.maxBodyBytes, DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxBodyBytes),
    maxErrorBodyBytes: positiveLimit(input?.maxErrorBodyBytes, DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxErrorBodyBytes),
    maxSseFrameBytes: positiveLimit(input?.maxSseFrameBytes, DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxSseFrameBytes),
    maxSseFrameLines: positiveLimit(input?.maxSseFrameLines, DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxSseFrameLines),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isEventStreamContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function notifyLimit(
  onLimit: ((error: McpHttpIngressLimitError) => void) | undefined,
  error: McpHttpIngressLimitError,
): void {
  try {
    onLimit?.(error);
  } catch {
    // Limit callbacks are diagnostic/fatal-state hooks; their failure must not mask the limit.
  }
}
