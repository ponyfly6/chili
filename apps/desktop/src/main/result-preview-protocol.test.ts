import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RESULT_TEXT_BYTES } from "../shared/result-preview.js";
import { MAX_RESULT_PREVIEWS, ResultPreviewRegistry, resultPreviewHeaders } from "./result-preview-protocol.js";
import { isAllowedExternalWindowOpen, isAllowedResultFrameNavigation, PRODUCTION_CSP } from "./window-security.js";

async function fixture(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "chili-result-protocol-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  try { await run(workspace, outside); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function resourceUrl(document: string, path: string): string {
  return new URL(path, document).href;
}

test("issues opaque capability hosts and serves the issued HTML snapshot", async () => {
  await fixture(async (workspace) => {
    const registry = new ResultPreviewRegistry();
    const path = "页面 #1.html";
    const url = registry.issue(workspace, path, "<h1>Snapshot</h1>");
    await writeFile(join(workspace, path), "<h1>Changed after issue</h1>");
    expect(url).toMatch(/^chili-result:\/\/[a-f\d-]{36}\//u);
    expect(url).not.toContain(workspace);
    expect(registry.isDocumentUrl(url)).toBe(true);
    expect(registry.isDocumentUrl(`${url}?other`)).toBe(false);
    expect(registry.isDocumentUrl(resourceUrl(url, "other.html"))).toBe(false);
    const response = await registry.respond(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<h1>Snapshot</h1>");
  });
});

test("every response enforces a scriptless opaque sandbox and no remote resources", () => {
  const source = "chili-result://713ebda6-7855-43f0-ae81-86cb68b3efc6";
  const headers = resultPreviewHeaders(source.split("//")[1]);
  const policy = headers.get("Content-Security-Policy")!;
  expect(policy).toStartWith("sandbox;");
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("script-src 'none'");
  expect(policy).toContain(`style-src 'unsafe-inline' ${source}`);
  expect(policy).toContain(`img-src ${source} data:`);
  for (const directive of ["connect-src", "object-src", "frame-src", "worker-src", "font-src", "media-src", "base-uri", "form-action"])
    expect(policy).toContain(`${directive} 'none'`);
  for (const permission of ["allow-scripts", "allow-same-origin", "allow-popups", "allow-forms", "allow-top-navigation", "https:", "http:", "file:"])
    expect(policy).not.toContain(permission);
  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(headers.get("Cache-Control")).toBe("no-store");
  expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(headers.get("X-DNS-Prefetch-Control")).toBe("off");
});

test("allows only registered child documents opened or replaced by the trusted main frame", () => {
  const initial = {
    registeredDocument: true, parentIsMainFrame: true,
    initiatorIsMainFrame: false, hasInitiator: false, currentUrl: "about:blank",
  };
  expect(isAllowedResultFrameNavigation(initial)).toBe(true);
  expect(isAllowedResultFrameNavigation({ ...initial, initiatorIsMainFrame: true, hasInitiator: true })).toBe(true);
  expect(isAllowedResultFrameNavigation({ ...initial, hasInitiator: true })).toBe(false);
  expect(isAllowedResultFrameNavigation({ ...initial, registeredDocument: false })).toBe(false);
  expect(isAllowedResultFrameNavigation({ ...initial, parentIsMainFrame: false })).toBe(false);
  const opened = { ...initial, currentUrl: "chili-result://preview/index.html" };
  expect(isAllowedResultFrameNavigation(opened)).toBe(false);
  expect(isAllowedResultFrameNavigation({ ...opened, hasInitiator: true })).toBe(false);
  expect(isAllowedResultFrameNavigation({ ...opened, hasInitiator: true, initiatorIsMainFrame: true })).toBe(true);
  expect(PRODUCTION_CSP).toContain("frame-src chili-result:");
  expect(PRODUCTION_CSP).toContain("script-src 'self'");
  expect(PRODUCTION_CSP).toContain("style-src 'self'");
  expect(PRODUCTION_CSP).not.toContain("unsafe-inline");
});

test("preserves noreferrer Markdown links while rejecting untrusted referrers and unsafe external targets", () => {
  const production = { packaged: true };
  for (const url of ["https://example.com/docs", "http://localhost:3000", "mailto:person@example.com"]) {
    expect(isAllowedExternalWindowOpen(url, "", production)).toBe(true);
    expect(isAllowedExternalWindowOpen(url, "chili://app/index.html", production)).toBe(true);
    expect(isAllowedExternalWindowOpen(url, "chili-result://713ebda6-7855-43f0-ae81-86cb68b3efc6/index.html", production)).toBe(false);
    expect(isAllowedExternalWindowOpen(url, "https://evil.test", production)).toBe(false);
  }
  for (const url of ["file:///private/file", "javascript:alert(1)", "data:text/html,test", "chili://app/index.html", "not a url"]) {
    expect(isAllowedExternalWindowOpen(url, "", production)).toBe(false);
    expect(isAllowedExternalWindowOpen(url, "chili://app/index.html", production)).toBe(false);
  }
  const development = { packaged: false, developmentRendererUrl: "http://localhost:5173" };
  expect(isAllowedExternalWindowOpen("https://example.com", "http://localhost:5173/index.html", development)).toBe(true);
  expect(isAllowedExternalWindowOpen("https://example.com", "http://localhost:5174/index.html", development)).toBe(false);
});

test("only contained CSS and verified raster images are served as assets", async () => {
  await fixture(async (workspace) => {
    const registry = new ResultPreviewRegistry();
    const url = registry.issue(workspace, "index.html", "<h1>Result</h1>");
    const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
    await Promise.all([
      writeFile(join(workspace, "style.css"), "h1 { color: red; }"),
      writeFile(join(workspace, "image.png"), png),
      writeFile(join(workspace, "other.html"), "<script>alert(1)</script>"),
      writeFile(join(workspace, "code.js"), "alert(1)"),
      writeFile(join(workspace, "data.json"), "{}"),
      writeFile(join(workspace, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
      writeFile(join(workspace, "fake.png"), "<html>not a raster</html>"),
    ]);
    const css = await registry.respond(new Request(resourceUrl(url, "style.css?v=2")));
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1 { color: red; }");
    const image = await registry.respond(new Request(resourceUrl(url, "image.png")));
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    for (const path of ["other.html", "code.js", "data.json", "image.svg", "fake.png", "missing.css"]) {
      expect((await registry.respond(new Request(resourceUrl(url, path)))).status).toBe(404);
    }
    const documentRequest = new Request(resourceUrl(url, "style.css"));
    Object.defineProperty(documentRequest, "destination", { value: "iframe" });
    expect((await registry.respond(documentRequest)).status).toBe(404);
  });
});

test("rejects symlink escapes, asset type substitution, and invalid document paths", async () => {
  await fixture(async (workspace, outside) => {
    const registry = new ResultPreviewRegistry();
    const url = registry.issue(workspace, "index.html", "Hello");
    await writeFile(join(outside, "secret.css"), "private data");
    await writeFile(join(workspace, "script.js"), "private script");
    await Promise.all([
      symlink(join(outside, "secret.css"), join(workspace, "escape.css")),
      symlink(join(workspace, "script.js"), join(workspace, "fake.css")),
      symlink(outside, join(workspace, "outside")),
    ]);
    for (const path of ["escape.css", "fake.css", "outside/secret.css", "%2e%2e/outside/secret.css", "bad%00.css", "bad%5cpath.css"]) {
      expect((await registry.respond(new Request(resourceUrl(url, path)))).status).toBe(404);
    }
    for (const path of ["../index.html", "/index.html", "a/../index.html", "a\\index.html", "a\0.html", "a//index.html", "script.js"]) {
      expect(() => registry.issue(workspace, path, "Hello")).toThrow();
    }
    expect(() => registry.issue(workspace, "index.html", "x".repeat(MAX_RESULT_TEXT_BYTES + 1))).toThrow("too large");
  });
});

test("rejects forged capability URLs and non-GET requests without leaking paths", async () => {
  const registry = new ResultPreviewRegistry();
  const url = registry.issue("/private/workspace", "index.html", "Hello");
  const host = new URL(url).hostname;
  for (const forged of [
    `chili-result://user@${host}/index.html`,
    `chili-result://${host}:42/index.html`,
    `chili-result://${host}.evil/index.html`,
    "chili-result://713ebda6-7855-43f0-ae81-86cb68b3efc6/index.html",
    `https://${host}/index.html`,
    `chili-result://${host}/bad%ZZ.css`,
  ]) {
    expect(registry.isDocumentUrl(forged)).toBe(false);
    const response = await registry.respond(new Request(forged));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox;");
  }
  expect((await registry.respond(new Request(url, { method: "POST", body: "no" }))).status).toBe(405);
});

test("evicts old preview capabilities at a fixed limit", async () => {
  const registry = new ResultPreviewRegistry();
  const first = registry.issue("/workspace", "first.html", "First");
  let latest = first;
  for (let index = 0; index < MAX_RESULT_PREVIEWS; index += 1) latest = registry.issue("/workspace", `file-${index}.html`, "Latest");
  expect(registry.isDocumentUrl(first)).toBe(false);
  expect((await registry.respond(new Request(first))).status).toBe(404);
  expect(registry.isDocumentUrl(latest)).toBe(true);
  expect(await (await registry.respond(new Request(latest))).text()).toBe("Latest");
});
