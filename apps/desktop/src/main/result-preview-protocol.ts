import { randomUUID } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import { MAX_RESULT_TEXT_BYTES } from "../shared/result-preview.js";
import { readDesktopResult } from "./result-reader.js";

export const RESULT_PREVIEW_SCHEME = "chili-result";
export const MAX_RESULT_PREVIEWS = 16;

interface ResultPreviewEntry {
  workspace: string;
  path: string;
  html: string;
}

/** Each unguessable host is one bounded snapshot and its contained static assets. */
export class ResultPreviewRegistry {
  private readonly entries = new Map<string, ResultPreviewEntry>();

  issue(workspace: string, path: string, html: string): string {
    if (!safeRelativePath(path) || ![".html", ".htm"].includes(extname(path).toLowerCase())) {
      throw new Error("Invalid result preview document path");
    }
    if (Buffer.byteLength(html, "utf8") > MAX_RESULT_TEXT_BYTES) throw new Error("Result preview document is too large");
    const id = randomUUID();
    this.entries.set(id, { workspace, path, html });
    while (this.entries.size > MAX_RESULT_PREVIEWS) this.entries.delete(this.entries.keys().next().value!);
    return `${RESULT_PREVIEW_SCHEME}://${id}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  isDocumentUrl(input: string): boolean {
    const parsed = parsePreviewUrl(input);
    return parsed !== undefined && parsed.search === "" && this.entries.get(parsed.id)?.path === parsed.path;
  }

  async respond(request: Request): Promise<Response> {
    const parsed = parsePreviewUrl(request.url);
    const entry = parsed ? this.entries.get(parsed.id) : undefined;
    if (!parsed || !entry) return previewResponse("Not found", 404);
    if (request.method !== "GET") return previewResponse("Method not allowed", 405);
    const headers = resultPreviewHeaders(parsed.id);
    if (parsed.path === entry.path && parsed.search === "") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(entry.html, { headers });
    }
    // A stylesheet or raster image can never become another preview document.
    if (request.destination === "document" || request.destination === "iframe") return previewResponse("Not found", 404);
    const extension = extname(parsed.path).toLowerCase();
    if (![".css", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return previewResponse("Not found", 404);
    const result = await readDesktopResult(entry.workspace, parsed.path);
    if (result.status !== "ready") return previewResponse("Not found", 404);
    if (extension === ".css" && result.kind === "code" && extname(result.path).toLowerCase() === ".css") {
      headers.set("Content-Type", "text/css; charset=utf-8");
      return new Response(result.content, { headers });
    }
    if (result.kind === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(result.mimeType)) {
      headers.set("Content-Type", result.mimeType);
      return new Response(Buffer.from(result.content, "base64"), { headers });
    }
    return previewResponse("Not found", 404);
  }
}

const resultPreviews = new ResultPreviewRegistry();

export function issueResultPreview(workspace: string, path: string, html: string): string {
  return resultPreviews.issue(workspace, path, html);
}

export function isResultPreviewDocumentUrl(input: string): boolean {
  return resultPreviews.isDocumentUrl(input);
}

export async function installResultPreviewProtocol(): Promise<void> {
  const { protocol } = await import("electron");
  await protocol.handle(RESULT_PREVIEW_SCHEME, (request) => resultPreviews.respond(request));
}

export function resultPreviewHeaders(id?: string): Headers {
  const source = id ? `${RESULT_PREVIEW_SCHEME}://${id}` : "'none'";
  return new Headers({
    "Content-Security-Policy": [
      "sandbox",
      "default-src 'none'",
      "script-src 'none'",
      `style-src 'unsafe-inline' ${source}`,
      `img-src ${source} data:`,
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "font-src 'none'",
      "media-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
  });
}

function previewResponse(body: string, status: number): Response {
  const headers = resultPreviewHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { status, headers });
}

function parsePreviewUrl(input: string): { id: string; path: string; search: string } | undefined {
  if (input.length > 8_192 || /[\\\u0000-\u0020\u007f]/u.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== `${RESULT_PREVIEW_SCHEME}:` || url.username || url.password || url.port
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(url.hostname)) return undefined;
    // Check the raw path too: URL normalization must not hide literal traversal.
    const rawPath = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*\/([^?#]*)/u.exec(input)?.[1];
    if (rawPath === undefined) return undefined;
    const path = decodeURIComponent(rawPath);
    if (!safeRelativePath(path)) return undefined;
    return { id: url.hostname, path, search: url.search };
  } catch {
    return undefined;
  }
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 4_096 && !isAbsolute(path)
    && !/[\\\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
