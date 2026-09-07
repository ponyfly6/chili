import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffViewer } from "./DiffViewer.js";

const patch = [
  "# turn diff incomplete: 1 tool call(s) had no snapshot baseline",
  "diff --git a/src/project.ts b/src/project.ts",
  "--- a/src/project.ts",
  "+++ b/src/project.ts",
  "@@ -10,2 +10,3 @@",
  " const projects = [];",
  "-const active = null;",
  "+const active = projects[0];",
  "+const ready = true;",
  "diff --git a/assets/icon.png b/assets/icon.png",
  "Binary files a/assets/icon.png and b/assets/icon.png differ",
].join("\n");

test("review shows file navigation, totals, original notes and semantic line numbers", () => {
  const html = renderToStaticMarkup(<DiffViewer text={patch} />);
  expect(html).toContain("2 files");
  expect(html).toContain('aria-label="2 added lines"');
  expect(html).toContain('aria-label="1 removed lines"');
  expect(html).toContain('aria-label="Next changed file"');
  expect(html).toContain("assets/icon.png");
  expect(html).toContain("# turn diff incomplete: 1 tool call(s) had no snapshot baseline");
  expect(html).toContain('class="diff-review-number">10</td>');
  expect(html).toContain('class="diff-review-number">12</td>');
  expect(html).toContain("diff-review-line-addition");
  expect(html).toContain("diff-review-line-deletion");
  // Other files are selectable, but only the selected patch is mounted.
  expect(html).not.toContain("Binary files a/assets/icon.png and b/assets/icon.png differ");
});

test("runtime truncation stays distinct from bounded rendering of a large complete patch", () => {
  const text = ["diff --git a/large.ts b/large.ts", "--- a/large.ts", "+++ b/large.ts", "@@ -0,0 +1,20000 @@", ...Array.from({ length: 20_000 }, (_, index) => `+export const value${index} = ${index};`)].join("\n");
  expect(text.length).toBeGreaterThan(512 * 1024);
  const html = renderToStaticMarkup(<DiffViewer text={text} />);
  expect(html).toContain("Rows 1–400 of");
  expect(html).toContain("20000 added lines");
  expect(html.match(/<tr class="diff-review-line /g)?.length).toBe(400);
  expect(html).not.toContain("This diff is incomplete");
  expect(html).not.toContain("value19999");
  expect(renderToStaticMarkup(<DiffViewer text={patch} truncated />)).toContain("This diff is incomplete");
});

test("patch paths and content remain text even when they resemble HTML", () => {
  const text = [
    'diff --git "a/<img onerror=alert(1)>" "b/<img onerror=alert(1)>"',
    '--- "a/<img onerror=alert(1)>"',
    '+++ "b/<img onerror=alert(1)>"',
    "@@ -0,0 +1 @@",
    '+<script>location.href="https://example.invalid"</script>',
  ].join("\n");
  const html = renderToStaticMarkup(<DiffViewer text={text} />);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img ");
  expect(html).not.toContain("<a ");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img onerror=alert(1)&gt;");
});

test("warnings after an unselected file remain visible without navigating to it", () => {
  const warning = "# turn diff incomplete: no readable snapshot was created";
  const html = renderToStaticMarkup(<DiffViewer text={`${patch}\n${warning}`} />);
  expect(html).toContain(warning);
});

test("empty, unknown and loading output remains reviewable", () => {
  expect(renderToStaticMarkup(<DiffViewer text="" />)).toContain("No changes to review.");
  expect(renderToStaticMarkup(<DiffViewer text={"Not a Git repository.\nA diagnostic follows."} />)).toContain("Not a Git repository.\nA diagnostic follows.");
  const loading = renderToStaticMarkup(<DiffViewer text="" loading />);
  expect(loading).toContain('aria-busy="true"');
  expect(loading).toContain("Loading changes…");
  expect(loading).not.toContain("No changes to review.");
});
