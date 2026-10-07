import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryCard } from "./DeliveryCard.js";
import type { DesktopResult } from "./result-model.js";

const result: DesktopResult = { id: "output/report.md", path: "output/report.md", label: "竞品调研报告", description: "结论与原始来源。", source: "tool", messageId: "call-secret", updatedAt: 123 };

test("delivery card shows the deliverable and a clear open action without runtime metadata", () => {
  const html = renderToStaticMarkup(<DeliveryCard result={result} onOpen={() => {}} />);
  expect(html).toContain('aria-label="打开交付文件：竞品调研报告"');
  expect(html).toContain("结论与原始来源。");
  expect(html).toContain("Markdown 文档");
  for (const internal of ["call-secret", "output/report.md", "updatedAt", "messageId"]) expect(html).not.toContain(internal);
});

test("delivery card handles files without previews and escapes delivered text", () => {
  const { description, ...withoutDescription } = result;
  const html = renderToStaticMarkup(<DeliveryCard result={{ ...withoutDescription, path: "report.pdf", label: "<script>report</script>" }} onOpen={() => {}} />);
  expect(html).toContain("PDF 文件");
  expect(html).toContain("&lt;script&gt;report&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("delivery-card-description");
});
