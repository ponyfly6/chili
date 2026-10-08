import type { NativeControlHttpRequest, NativeControlHttpResponse } from "@chili/remote-control/browser";

export interface NativeBridge {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  postJson(options: {
    id: string;
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    maxResponseBytes: number;
  }): Promise<NativeControlHttpResponse>;
  cancel(options: { id: string }): Promise<void>;
}

const encoder = new TextEncoder();
const MAX_BYTES = 1_048_576;
const ALLOWED_HEADERS = new Set(["content-type", "authorization", "x-chili-control-client"]);

export function createNativePostJson(bridge: NativeBridge, randomId: () => string = () => crypto.randomUUID()) {
  return async (request: NativeControlHttpRequest): Promise<NativeControlHttpResponse> => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.pathname.startsWith("/api/") ||
        !Number.isInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > MAX_BYTES ||
        encoder.encode(request.body).byteLength > MAX_BYTES ||
        Object.entries(request.headers).some(([name, value]) => !ALLOWED_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(value))) {
      throw nativeError("INVALID_NATIVE_REQUEST");
    }
    if (request.signal.aborted) throw abortError();
    const id = randomId();
    let abort: (() => void) | undefined;
    const response = await new Promise<NativeControlHttpResponse>((resolve, reject) => {
      // Enqueue the native request before its cancel message, including when the
      // signal fires synchronously. Cancellation never implies a write failed.
      const pending = bridge.postJson({ id, url: request.url, headers: request.headers, body: request.body,
        maxResponseBytes: request.maxResponseBytes });
      abort = () => {
        void bridge.cancel({ id }).catch(() => undefined);
        reject(abortError());
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      pending.then(resolve, reject);
    }).finally(() => { if (abort) request.signal.removeEventListener("abort", abort); });
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== "string") {
      throw nativeError("INVALID_HTTP_RESPONSE");
    }
    if (response.status >= 300 && response.status < 400) throw nativeError("REDIRECT_NOT_ALLOWED");
    if (encoder.encode(response.body).byteLength > request.maxResponseBytes) throw nativeError("RESPONSE_TOO_LARGE");
    return response;
  };
}

function abortError() { return new DOMException("Request cancelled", "AbortError"); }
function nativeError(code: string) { return Object.assign(new Error(code), { code }); }
