import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopResultRead } from "../shared/result-preview.js";
import { ResultPreviewContent, ResultsPanel } from "./ResultsPanel.js";
import type { DesktopResult } from "./result-model.js";
import type { ControlTransport } from "./transport.js";

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

const deliveries: DesktopResult[] = [
  { id: "first.md", path: "first.md", label: "首份报告", description: "已经交付的说明。", source: "tool", messageId: "first", updatedAt: 1 },
  { id: "second.html", path: "second.html", label: "页面原型", source: "tool", messageId: "second", updatedAt: 2 },
];

test("the empty result panel does not invent a preview or offer modification", () => {
  const html = renderToStaticMarkup(<ResultsPanel transport={{} as ControlTransport} sessionId="session" workspace="/work" results={[]} onContinue={() => {}} />);
  expect(html).toContain('aria-label="交付文件"');
  expect(html).toContain("还没有交付文件");
  expect(html).not.toContain("继续修改");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("results-source");
});

test("controlled selection opens the requested delivery and modification waits for a successful read", () => {
  const html = renderToStaticMarkup(<ResultsPanel transport={{} as ControlTransport} sessionId="session" workspace="/work" results={deliveries} selectedPath="second.html" onSelect={() => {}} onContinue={() => {}} />);
  expect(html).toContain("<h2>页面原型</h2>");
  expect(html).toContain('aria-label="交付文件列表"');
  expect(html).toContain('aria-pressed="true" title="second.html"');
  expect(html).toContain('disabled="">继续修改');
  expect(html).toContain("正在读取文件");
  expect(html).not.toContain("<iframe");
});

test("uncontrolled or removed selections fall back to an available delivery", () => {
  for (const selection of [{}, { selectedPath: "removed.md" }]) {
    const html = renderToStaticMarkup(<ResultsPanel transport={{} as ControlTransport} sessionId="session" workspace="/work" results={deliveries} {...selection} />);
    expect(html).toContain("<h2>首份报告</h2>");
    expect(html).toContain("已经交付的说明。");
  }
});
