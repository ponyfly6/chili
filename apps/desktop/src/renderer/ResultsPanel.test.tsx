import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopResultRead } from "../shared/result-preview.js";
import { ResultPreviewContent } from "./ResultsPanel.js";

const htmlResult: Extract<DesktopResultRead, { status: "ready" }> = {
  status: "ready", kind: "html", path: "page.html", mimeType: "text/html", bytes: 28,
  content: "<script>alert(1)</script>",
  previewUrl: "chili-result://cc9423e9-49c2-41c1-b5de-606a9b866c50/page.html",
};

test("HTML preview receives an opaque sandbox with no script, form or same-origin allowances", () => {
  const html = renderToStaticMarkup(<ResultPreviewContent result={htmlResult} label="网页" />);
  expect(html).toContain('sandbox=""');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).toContain('src="chili-result://');
  expect(html).not.toContain("allow-");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("srcDoc");
});

test("source view and untrusted preview addresses always remain escaped text", () => {
  for (const result of [htmlResult, { ...htmlResult, previewUrl: "https://evil.test/page.html" }, { ...htmlResult, previewUrl: "chili://app/index.html" }]) {
    const html = renderToStaticMarkup(<ResultPreviewContent result={result} label="网页" source={result === htmlResult} />);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<script");
  }
});

test("markdown is rendered through the caller's existing safe renderer and code stays escaped", () => {
  const markdown = { ...htmlResult, kind: "markdown" as const, content: "# Actual output" };
  const html = renderToStaticMarkup(<ResultPreviewContent result={markdown} label="文档" renderMarkdown={(text) => <p>{text}</p>} />);
  expect(html).toContain("<p># Actual output</p>");
  const code = renderToStaticMarkup(<ResultPreviewContent result={{ ...htmlResult, kind: "code" }} label="代码" />);
  expect(code).toContain("&lt;script&gt;");
});
