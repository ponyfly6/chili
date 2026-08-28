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
