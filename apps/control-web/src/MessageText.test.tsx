import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./MessageText.js";

function render(text: string): string {
  return renderToStaticMarkup(<MessageText text={text} />);
}

describe("message text", () => {
  test("keeps plain paragraphs and single line breaks readable", () => {
    const html = render("第一行\r\n第二行\r\n\r\n另一段 & 内容");
    expect(html).toBe('<div class="message-content"><p><span>第一行</span><br/><span>第二行</span></p><p><span>另一段 &amp; 内容</span></p></div>');
    expect(render("")).toBe('<div class="message-content"></div>');
  });

  test("renders headings, simple lists, bold and inline code", () => {
    const html = render("# 一\n## 二\n### 三\n\n- **重点**\n- `const x = 1`\n\n3. 第三项\n4. 第四项\n\n正文 **含 `code`**。");
    expect(html).toContain("<h1>一</h1><h2>二</h2><h3>三</h3>");
    expect(html).toContain("<ul><li><strong>重点</strong></li><li><code>const x = 1</code></li></ul>");
    expect(html).toContain('<ol start="3"><li>第三项</li><li>第四项</li></ol>');
    expect(html).toContain("<strong>含 <code>code</code></strong>");
  });

  test("fenced code preserves text without rendering formatting or resources", () => {
    const html = render("```html\n<img src=https://example.com/pixel>\n**literal** [link](https://example.com)\n```\n\n结束");
    expect(html).toContain('<div class="message-code-language">html</div>');
    expect(html).toContain('<pre class="message-code"><code>&lt;img src=https://example.com/pixel&gt;\n**literal** [link](https://example.com)</code></pre>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("<p><span>结束</span></p>");
  });

  test("code fences close only with a matching marker of sufficient length", () => {
    const html = render("````text\n```\n~~~\n````\n\n~~~js\nlet a = 1;\n~~~~");
    expect(html.match(/<pre /g)).toHaveLength(2);
    expect(html).toContain("<code>```\n~~~</code>");
    expect(html).toContain("<code>let a = 1;</code>");
  });

  test("unfinished fences preserve their marker and the rest as plain text", () => {
    const html = render("开头\n\n```js\n# still code\n**still literal**\n<script>alert(1)</script>");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("```js");
    expect(html).toContain("# still code");
    expect(html).toContain("**still literal**");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("unmatched and escaped inline syntax stays visible", () => {
    const html = render("**unfinished `unfinished [unfinished](\n\\**literal** \\[literal](https://example.com)");
    expect(html).toContain("**unfinished `unfinished [unfinished](");
    expect(html).toContain("\\**literal** \\[literal](https://example.com)");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a ");
  });

  test("raw HTML, attributes and Markdown images remain escaped text", () => {
    const html = render('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n**<svg onload=alert(1)>**\n![pixel](https://example.com/track.png)\n<a href="javascript:alert(1)">click</a>');
    expect(html).not.toMatch(/<(?:script|img|svg|a)[ >]/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("<strong>&lt;svg onload=alert(1)&gt;</strong>");
    expect(html).toContain("![pixel](https://example.com/track.png)");
  });

  test("safe links use only absolute HTTP and HTTPS with external navigation protections", () => {
    const html = render("[**站点**](HTTPS://example.com/path?q=a&b=c) 和 [文档](http://example.com/a%20b)");
    expect(html).toContain('<a href="https://example.com/path?q=a&amp;b=c" target="_blank" rel="noreferrer noopener"><strong>站点</strong></a>');
    expect(html).toContain('<a href="http://example.com/a%20b" target="_blank" rel="noreferrer noopener">文档</a>');
  });

  test("unsafe, ambiguous or credential-bearing URLs remain visible without links", () => {
    const unsafeUrls = [
      "javascript:alert", "data:text/html,script", "ftp://example.com", "//example.com", "/relative",
      "https://user:password@example.com", "https://user@example.com", "https://@example.com",
      "https://example.com/a\tb", "https://example.com/a\nb", "https://example.com/a\rb",
      "https://example.com/\u0000", "https://example.com/\u007f", "https://example.com/\u0085",
      "https://example.com/%0A", "https://example.com/%00", "https://example.com/%7f",
      "https://example.com/%E2%80%A8", "https://example.com/\\path", "https://example.com/%invalid",
    ];
    for (const url of unsafeUrls) {
      const html = render(`[可疑]( ${url}) [可疑](${url})`);
      expect(html).not.toContain("<a ");
      expect(html).toContain("[可疑](");
    }
  });

  test("a maximum-length unfinished message stays intact", () => {
    const text = "[".repeat(32_768);
    expect(render(text)).toBe(`<div class="message-content"><p><span>${text}</span></p></div>`);
  });
});
