import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ListenOptions, Socket } from "node:net";
import { Readable } from "node:stream";

export interface NodeHttpTransportOptions {
  hostname?: string;
  port?: number;
  /** Socket inactivity timeout, in seconds, matching Bun.serve. */
  idleTimeout?: number;
  tls?: Bun.TLSOptions | Bun.TLSOptions[];
  stallTimeoutMs?: number;
  handler(request: Request, listenerPort: number): Response | Promise<Response>;
}

export interface NodeHttpTransport {
  url: string;
  close(): Promise<void>;
}

const WRITE_CHUNK_BYTES = 64 * 1024;

/**
 * Bun's fetch server can eagerly drain a Response into its native send queue.
 * Its node:http adapter exposes write/drain, so the application stream only
 * advances when the socket accepts more bytes.
 */
export function startNodeHttpTransport(options: NodeHttpTransportOptions): NodeHttpTransport {
  const hostname = options.hostname ?? "127.0.0.1";
  const protocol = options.tls === undefined ? "http" : "https";
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new Error("HTTP transport stallTimeoutMs must be positive");
  }
  const tlsEntries = options.tls === undefined
    ? undefined
    : Array.isArray(options.tls) ? options.tls : [options.tls];
  if (tlsEntries?.length === 0) throw new Error("HTTP transport TLS options cannot be empty");
  if (tlsEntries !== undefined && tlsEntries.length > 1) {
    throw new Error("HTTP transport does not support multiple TLS certificates on this Bun version");
  }
  const tls = tlsEntries?.[0];
  if (tls !== undefined && (tls.cert === undefined || tls.key === undefined)) {
    throw new Error("HTTP transport TLS requires an explicit cert and key");
  }
  const server = createHttpServer();

  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // A failed Bun listen emits an error asynchronously even though address()
  // already reveals the failure. Keep it handled when startup throws below.
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  let listenerPort = 0;
  let origin = "";
  server.on("request", (incoming: IncomingMessage, outgoing: ServerResponse) => {
    void dispatchRequest(incoming, outgoing, origin, listenerPort, stallTimeoutMs, options.handler);
  });
  server.setTimeout((options.idleTimeout ?? 255) * 1_000);
  // Bun's node:https constructor filters out native TLS options, including
  // ALPN and ciphers. Its node:http listen extension forwards a single TLS
  // configuration directly to Bun.serve, preserving Bun.file and byte inputs.
  // Arrays are not supported here: the extension spreads them into an object
  // and loses the certificate contexts.
  const listenOptions: ListenOptions & { tls?: Bun.TLSOptions } = {
    port: options.port ?? 0,
    host: hostname,
    ...(tls === undefined ? {} : { tls }),
  };
  server.listen(listenOptions);
  // This module runs on Bun, whose node:http listener binds synchronously.
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error(`Failed to bind HTTP transport to ${hostname}:${options.port ?? 0}`);
  }
  listenerPort = address.port;
  const authority = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  origin = `${protocol}://${authority}:${listenerPort}`;
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}/`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

async function dispatchRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  origin: string,
  listenerPort: number,
  stallTimeoutMs: number,
  handler: NodeHttpTransportOptions["handler"],
): Promise<void> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    if (!abort.signal.aborted) abort.abort(new Error("HTTP connection closed"));
    void reader?.cancel(abort.signal.reason).catch(() => {});
  };
  incoming.once("aborted", cancel);
  incoming.once("error", cancel);
  outgoing.once("close", cancel);
  outgoing.once("error", cancel);
  try {
    if (incoming.aborted || outgoing.destroyed) cancel();
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index];
      const value = incoming.rawHeaders[index + 1];
      if (name !== undefined && value !== undefined) headers.append(name, value);
    }
    const method = incoming.method ?? "GET";
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method,
      headers,
      signal: abort.signal,
      ...(method === "GET" || method === "HEAD" ? {} : {
        body: Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
        duplex: "half",
      }),
    });
    const response = await handler(request, listenerPort);
    if (abort.signal.aborted) {
      await response.body?.cancel(abort.signal.reason);
      return;
    }
    outgoing.statusCode = response.status;
    if (response.statusText) outgoing.statusMessage = response.statusText;
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") outgoing.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
    if (response.body === null || method === "HEAD") {
      await response.body?.cancel();
      outgoing.end();
      return;
    }
    reader = response.body.getReader();
    outgoing.flushHeaders();
    while (!abort.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (let offset = 0; offset < chunk.value.byteLength; offset += WRITE_CHUNK_BYTES) {
        abort.signal.throwIfAborted();
        if (!outgoing.write(chunk.value.subarray(offset, offset + WRITE_CHUNK_BYTES))) {
          await waitForDrain(outgoing, abort.signal, stallTimeoutMs);
        }
      }
    }
    if (!abort.signal.aborted) outgoing.end();
  } catch {
    cancel();
    if (!outgoing.headersSent && !outgoing.destroyed) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "text/plain; charset=utf-8");
      outgoing.end("Internal server error");
    } else {
      outgoing.destroy();
    }
  } finally {
    if (reader !== undefined) {
      if (abort.signal.aborted) await reader.cancel(abort.signal.reason).catch(() => {});
      reader.releaseLock();
    }
    incoming.off("aborted", cancel);
    incoming.off("error", cancel);
    outgoing.off("close", cancel);
    outgoing.off("error", cancel);
  }
}

function waitForDrain(outgoing: ServerResponse, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      outgoing.off("drain", drained);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP client stopped accepting response bytes"));
    }, timeoutMs);
    timer.unref();
    outgoing.once("drain", drained);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
