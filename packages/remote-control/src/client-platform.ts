/** Explicit native boundary. The default browser client never uses this adapter. */
export interface NativeControlHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

export interface NativeControlHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ControlClientPlatform {
  readonly kind: "native";
  readonly baseUrl: string;
  readonly crypto: Crypto;
  /** Must verify system TLS, reject redirects, omit cookies and browser origin headers. */
  readonly postJson: (request: NativeControlHttpRequest) => Promise<NativeControlHttpResponse>;
}

const nativePlatforms = new WeakSet<ControlClientPlatform>();

/** Bind a native transport to one HTTPS origin before supplying it to the client. */
export function createNativeControlPlatform(options: Omit<ControlClientPlatform, "kind">): ControlClientPlatform {
  const baseUrl = canonicalControlOrigin(options.baseUrl);
  if (!options.crypto?.subtle || typeof options.crypto.getRandomValues !== "function"
    || typeof options.postJson !== "function") throw new Error("NATIVE_PLATFORM_INVALID");
  const platform: ControlClientPlatform = Object.freeze({
    kind: "native", baseUrl, crypto: options.crypto, postJson: options.postJson,
  });
  nativePlatforms.add(platform);
  return platform;
}

export function assertNativeControlPlatform(platform: ControlClientPlatform, baseUrl: string): void {
  if (!nativePlatforms.has(platform) || platform.kind !== "native" || platform.baseUrl !== baseUrl) {
    throw new Error("NATIVE_PLATFORM_ORIGIN_MISMATCH");
  }
}

export function canonicalControlOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("TRUSTED_HTTPS_REQUIRED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TRUSTED_HTTPS_REQUIRED");
  }
  return url.origin;
}
