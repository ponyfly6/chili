import { relative, resolve } from "node:path";

export const RENDERER_SCHEME = "chili";
export const RENDERER_HOST = "app";
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
].join("; ");

export interface RendererTrustPolicy {
  packaged: boolean;
  developmentRendererUrl?: string | undefined;
}

export type RendererAssetDecision =
  | { status: 200; target: string }
  | { status: 400 | 404 };

export function isTrustedRendererUrl(input: string, policy: RendererTrustPolicy): boolean {
  const parsed = parseUrl(input);
  if (!parsed || parsed.username || parsed.password) return false;
  if (policy.packaged) {
    return parsed.protocol === `${RENDERER_SCHEME}:`
      && parsed.hostname === RENDERER_HOST
      && parsed.port === "";
  }

  const expected = policy.developmentRendererUrl
    ? parseUrl(policy.developmentRendererUrl)
    : undefined;
  if (!expected || (expected.protocol !== "http:" && expected.protocol !== "https:")) return false;
  if (expected.username || expected.password || parsed.username || parsed.password) return false;
  return parsed.origin === expected.origin;
}

export function decideRendererAsset(
  input: string,
  rendererRoot: string,
  pathExists: (path: string) => boolean,
): RendererAssetDecision {
  const url = parseUrl(input);
  if (!url) return { status: 400 };
  if (
    url.protocol !== `${RENDERER_SCHEME}:`
    || url.hostname !== RENDERER_HOST
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
  ) return { status: 404 };

  const rawPathname = rawAbsoluteUrlPathname(input);
  if (rawPathname === undefined) return { status: 400 };
  const pathname = decodeSafePathname(rawPathname);
  if (pathname === undefined) return { status: 400 };

  const requested = pathname === "/" || pathname === ""
    ? "index.html"
    : pathname.replace(/^\/+/, "");
  const target = resolve(rendererRoot, requested);
  const rel = relative(rendererRoot, target);
  if (!rel || rel.startsWith("..") || rel.split(/[\\/]/u).includes("..") || !pathExists(target)) {
    return { status: 404 };
  }
  return { status: 200, target };
}

export function productionSecurityHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  headers.set("Content-Security-Policy", PRODUCTION_CSP);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

export function responseSecurityHeaders(
  input: Readonly<Record<string, string[] | undefined>> | undefined,
  csp: string,
): Record<string, string[]> {
  const headers = { ...input } as Record<string, string[]>;
  headers["Content-Security-Policy"] = [csp];
  headers["Cross-Origin-Opener-Policy"] = ["same-origin"];
  headers["X-Content-Type-Options"] = ["nosniff"];
  headers["Referrer-Policy"] = ["no-referrer"];
  return headers;
}

function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function rawAbsoluteUrlPathname(input: string): string | undefined {
  const match = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*([^?#]*)/u.exec(input);
  return match?.[1];
}

function decodeSafePathname(input: string): string | undefined {
  let pathname = input;
  for (let pass = 0; pass < 5; pass += 1) {
    if (unsafePathSegments(pathname)) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded === pathname) return pathname;
    pathname = decoded;
  }
  // Refuse paths whose meaning still changes after repeated decoding.
  try {
    return decodeURIComponent(pathname) === pathname && !unsafePathSegments(pathname)
      ? pathname
      : undefined;
  } catch {
    return undefined;
  }
}

function unsafePathSegments(input: string): boolean {
  if (input.includes("\0")) return true;
  return input.replaceAll("\\", "/").split("/").some((segment) => segment === "." || segment === "..");
}
