import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText, MessagePart } from "./App.js";

test("renders common assistant markdown as semantic React content", () => {
  const html = renderToStaticMarkup(
    <MarkdownText text={[
      "## Result",
      "",
      "Use **one path** and `bun test`.",
      "",
      "1. Inspect",
      "2. Fix",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n")} />,
  );

  expect(html).toContain("<h3>Result</h3>");
  expect(html).toContain("<strong>one path</strong>");
  expect(html).toContain("<code>bun test</code>");
  expect(html).toContain("<ol>");
  expect(html).toContain("<pre><code>const ready = true;</code></pre>");
  expect(html).not.toContain("## Result");
  expect(html).not.toContain("```ts");
});

test("escapes model text and only activates explicit http links", () => {
  const html = renderToStaticMarkup(
    <MarkdownText text={'<script>alert("no")</script> [safe](https://example.com) [local](file:///tmp/no)'} />,
  );

  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toContain('href="file:///tmp/no"');
});

test("keeps an orphaned raw tool result collapsed by default", () => {
  const html = renderToStaticMarkup(<MessagePart part={{
    type: "tool_result",
    id: "part_result" as never,
    callId: "call_orphan" as never,
    output: '<p align="center">very long output</p>',
  }} />);

  expect(html).toStartWith('<details class="tool-details inline-tool-result">');
  expect(html).not.toContain("<details open");
  expect(html).toContain("Tool result");
  expect(html).toContain("&lt;p align=&quot;center&quot;&gt;");
});

test("preserves interrupted text and reasoning with an incomplete label", () => {
  const stopped = renderToStaticMarkup(<MessagePart part={{
    type: "text", id: "part_text" as never, text: "Partial **answer**", completion: "cancelled",
  }} />);
  expect(stopped).toContain("Partial <strong>answer</strong>");
  expect(stopped).toContain("已停止，内容未完成");
  const failed = renderToStaticMarkup(<MessagePart part={{
    type: "reasoning", id: "part_reasoning" as never, text: "Partial thinking", completion: "failed",
  }} />);
  expect(failed).toContain("Partial thinking");
  expect(failed).toContain("生成失败，内容未完成");
  const complete = renderToStaticMarkup(<MessagePart part={{
    type: "text", id: "part_complete" as never, text: "Done", completion: "completed",
  }} />);
  expect(complete).not.toContain("未完成");
});
