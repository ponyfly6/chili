import { describe, expect, test } from "bun:test";
import { parseDiff } from "./diff-model.js";

function patch(...lines: string[]): string {
  return lines.join("\n");
}

const fileHeader = ["diff --git a/example.ts b/example.ts", "--- a/example.ts", "+++ b/example.ts"];

describe("parseDiff", () => {
  test("retains empty states, stderr, and warning preambles", () => {
    expect(parseDiff("")).toEqual({ files: [], preamble: [], added: 0, removed: 0, truncated: false });
    const text = "fatal: not a git repository\n\nNo turn activity yet.\n";
    expect(parseDiff(text).preamble).toEqual(["fatal: not a git repository", "", "No turn activity yet."]);
    expect(parseDiff(text).files).toEqual([]);
  });

  test("numbers context and changes across multiple hunks while preserving exact source", () => {
    const text = patch("# omitted another file", ...fileHeader, "@@ -4,3 +4,4 @@ function example()", " same", "-old", "+new", "+extra", " tail", "@@ -20 +21 @@", "-before", "+after", "");
    const result = parseDiff(text);
    expect(result.preamble).toEqual(["# omitted another file"]);
    expect(result).toMatchObject({ added: 3, removed: 2, truncated: false });
    expect(result.files[0]).toMatchObject({ path: "example.ts", kind: "modified", added: 3, removed: 2 });
    expect(result.files[0]!.raw).toBe(text.slice(text.indexOf("diff --git")));
    expect(result.files[0]!.lines.slice(4)).toEqual([
      { kind: "context", text: " same", oldNumber: 4, newNumber: 4 },
      { kind: "deletion", text: "-old", oldNumber: 5 },
      { kind: "addition", text: "+new", newNumber: 5 },
      { kind: "addition", text: "+extra", newNumber: 6 },
      { kind: "context", text: " tail", oldNumber: 6, newNumber: 7 },
      { kind: "hunk", text: "@@ -20 +21 @@" },
      { kind: "deletion", text: "-before", oldNumber: 20 },
      { kind: "addition", text: "+after", newNumber: 21 },
    ]);
  });

  test("handles added and deleted files including zero-length ranges and newline markers", () => {
    const result = parseDiff(patch(
      "diff --git a/added b/added", "new file mode 100644", "--- /dev/null", "+++ b/added", "@@ -0,0 +1,2 @@", "+first", "+last", "\\ No newline at end of file", "",
      "diff --git a/deleted b/deleted", "deleted file mode 100644", "--- a/deleted", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone", "\\ No newline at end of file",
    ));
    expect(result.files.map(({ path, kind, added, removed }) => ({ path, kind, added, removed }))).toEqual([
      { path: "added", kind: "added", added: 2, removed: 0 },
      { path: "deleted", kind: "deleted", added: 0, removed: 1 },
    ]);
    expect(result.files[0]!.lines.find((line) => line.text === "+first")).toMatchObject({ newNumber: 1 });
    expect(result.files[1]!.lines.at(-1)).toEqual({ kind: "metadata", text: "\\ No newline at end of file" });
  });

  test("keeps empty files, modes, binary patches, and renames visible", () => {
    const result = parseDiff(patch(
      "diff --git a/empty b/empty", "new file mode 100644", "",
      "diff --git a/script b/script", "old mode 100644", "new mode 100755", "",
      "diff --git a/image.png b/image.png", "Binary files a/image.png and b/image.png differ", "",
      "diff --git a/data b/data", "GIT binary patch", "literal 3", "+binary payload is not an addition", "",
      "diff --git a/old name b/new name", "similarity index 100%", "rename from old name", "rename to new name",
    ));
    expect(result.files.map((file) => file.kind)).toEqual(["added", "metadata", "binary", "binary", "renamed"]);
    expect(result.files[4]).toMatchObject({ path: "new name", previousPath: "old name" });
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  test("decodes backend JSON paths and git octal UTF-8 paths", () => {
    const jsonPath = "目录/a \"quoted\" \\ path.ts";
    const result = parseDiff(patch(
      `diff --git ${JSON.stringify(`a/${jsonPath}`)} ${JSON.stringify(`b/${jsonPath}`)}`, "old mode 100644", "new mode 100755", "",
      'diff --git "a/\\346\\226\\207\\344\\273\\266.txt" "b/\\346\\226\\207\\344\\273\\266.txt"', "old mode 100644", "new mode 100755",
    ));
    expect(result.files.map((file) => file.path)).toEqual([jsonPath, "文件.txt"]);
    expect(result.files[1]!.raw).toContain('"a/\\346\\226\\207');
  });

  test("disambiguates equal unquoted git paths containing spaces and b/", () => {
    const path = "one b/two b/three";
    const result = parseDiff(patch(`diff --git a/${path} b/${path}`, "old mode 100644", "new mode 100755"));
    expect(result.files[0]!.path).toBe(path);
    expect(result.files[0]!.previousPath).toBeUndefined();
  });

  test("supports mixed quoted and unquoted rename headers", () => {
    const result = parseDiff(patch(
      'diff --git a/plain "b/new\\tname"', "",
      'diff --git "a/old\\tname" b/plain',
    ));
    expect(result.files[0]).toMatchObject({ path: "new\\tname", previousPath: "plain", kind: "renamed" });
    expect(result.files[1]).toMatchObject({ path: "plain", previousPath: "old\\tname", kind: "renamed" });
  });

  test("visibly escapes control characters and bidi formatting only in navigation labels", () => {
    const path = "tab\tline\nreturn\r\u0000\u001b\u0085\u061c\u200f\u202e\u2066\u2069\u2028.txt";
    const text = patch(`diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}`, "old mode 100644", "new mode 100755");
    const result = parseDiff(text);
    expect(result.files[0]!.path).toBe("tab\\tline\\nreturn\\r\\u0000\\u001b\\u0085\\u061c\\u200f\\u202e\\u2066\\u2069\\u2028.txt");
    expect(result.files[0]!.raw).toBe(text);
    expect(result.files[0]!.lines[0]!.text).toBe(text.split("\n")[0]!);
    const cEscapes = parseDiff('diff --git "a/\\a\\b\\t\\n\\v\\f\\r" "b/\\a\\b\\t\\n\\v\\f\\r"');
    expect(cEscapes.files[0]!.path).toBe("\\u0007\\b\\t\\n\\u000b\\f\\r");
  });

  test("retains standalone unified patches with timestamp headers and multiple files", () => {
    const result = parseDiff(patch(
      "--- old name\t2026-09-07", "+++ new name\t2026-09-07", "@@ -1 +1 @@", "-old", "+new",
      "--- /dev/null", "+++ new file", "@@ -0,0 +1 @@", "+hello",
    ));
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ path: "new name", previousPath: "old name", kind: "renamed" });
    expect(result.files[1]).toMatchObject({ path: "new file", kind: "added", added: 1 });
  });

  test("distinguishes source resembling headers from actual patch metadata", () => {
    const result = parseDiff(patch(...fileHeader, "@@ -1,2 +1,3 @@", "--- old source", "-@@ -1 +1 @@", "+++ new source", "+@@ -900 +900 @@", "+<script>alert('untrusted')</script>"));
    expect(result).toMatchObject({ added: 3, removed: 2 });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.lines.slice(4).map((line) => line.kind)).toEqual(["deletion", "deletion", "addition", "addition", "addition"]);
    expect(result.files[0]!.lines.at(-1)!.text).toBe("+<script>alert('untrusted')</script>");
  });

  test("does not count out-of-hunk prefixes, malformed headers, or exhausted ranges", () => {
    const result = parseDiff(patch(
      "+preamble", "@@ -1 +1 @@", "-preamble", ...fileHeader,
      "+metadata", "@@ -1 +1 @@junk", "-metadata", "+metadata", "@@ -0 +1 @@", "+metadata",
      "@@ -1 +1 @@", "-old", "+new", "+excess", "-excess", " same", "@@ -1,9007199254740992 +1 @@", "+metadata",
    ));
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.files[0]!.lines.filter((line) => line.kind === "hunk")).toHaveLength(1);
    expect(result.files[0]!.lines.at(-1)).toEqual({ kind: "metadata", text: "+metadata" });
  });

  test("requires paired valid path headers before accepting a hunk", () => {
    const result = parseDiff(patch("diff --git a/file b/file", "@@ -1 +1 @@", "-not a patch", "+not a patch"));
    expect(result.files[0]).toMatchObject({ kind: "metadata", added: 0, removed: 0 });
  });

  test("retains truncation warnings after partial hunks and honors explicit truncation", () => {
    const text = patch(...fileHeader, "@@ -1,2 +1,2 @@", "-old", "+new", "# diff output truncated by the safety limit");
    const result = parseDiff(text);
    expect(result.truncated).toBe(true);
    expect(result.files[0]!.lines.at(-1)).toEqual({ kind: "metadata", text: "# diff output truncated by the safety limit" });
    expect(result.files[0]!.raw).toBe(text);
    expect(parseDiff("No changes", true).truncated).toBe(true);
    expect(parseDiff("# diff output truncated by the safety limit").truncated).toBe(true);
    expect(parseDiff(patch(...fileHeader, "@@ -0,0 +1 @@", "+# diff output truncated by the safety limit")).truncated).toBe(false);
  });

  test("preserves embedded warnings and blank lines between patches", () => {
    const first = patch(...fileHeader, "# comparison omitted", "", "");
    const second = "diff --git a/second b/second\n# unreadable file\n";
    const result = parseDiff(first + second);
    expect(result.files.map((file) => file.raw).join("")).toBe(first + second);
    expect(result.files[0]!.lines.at(-1)).toEqual({ kind: "metadata", text: "" });
    expect(result.files[1]!.lines.at(-1)).toEqual({ kind: "metadata", text: "# unreadable file" });
  });

  test("assigns distinct deterministic ids to duplicate paths", () => {
    const text = patch(...fileHeader, "@@ -1 +1 @@", "-a", "+b", ...fileHeader, "@@ -1 +1 @@", "-b", "+c");
    const first = parseDiff(text);
    expect(new Set(first.files.map((file) => file.id)).size).toBe(2);
    expect(first.files.map((file) => file.id)).toEqual(parseDiff(text).files.map((file) => file.id));
    expect(first.files.map((file) => file.path)).toEqual(["example.ts", "example.ts"]);
    const withInsertedFile = parseDiff(`diff --git a/other b/other\nold mode 100644\nnew mode 100755\n${text}`);
    expect(withInsertedFile.files.slice(1).map((file) => file.id)).toEqual(first.files.map((file) => file.id));
  });

  test("keeps ids distinct when escaped display labels coincide", () => {
    const paths = ["line\nfeed", "line\\nfeed"];
    const result = parseDiff(paths.map((path) => `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}`).join("\n"));
    expect(result.files[0]!.path).toBe(result.files[1]!.path);
    expect(result.files[0]!.id).not.toBe(result.files[1]!.id);
  });

  test("preserves an octal encoded UTF-8 BOM in a filename as a visible label", () => {
    const result = parseDiff('diff --git "a/\\357\\273\\277name" "b/\\357\\273\\277name"');
    expect(result.files[0]!.path).toBe("\\ufeffname");
  });

  test("falls back to metadata without throwing on malformed quoted paths", () => {
    const headers = [
      'diff --git "a/unterminated b/unterminated',
      'diff --git "a/\\q" "b/\\q"',
      'diff --git "a/\\777" "b/\\777"',
      'diff --git "a/\\377" "b/\\377"',
      'diff --git "a/\\u123" "b/\\u123"',
      "diff --git missing",
    ];
    for (const header of headers) {
      const result = parseDiff(patch(header, "--- \"bad\\q\"", "+++ \"bad\\q\"", "@@ -1 +1 @@", "-old", "+new"));
      expect(result.files[0]).toMatchObject({ path: "Unrecognized diff", kind: "metadata", added: 0, removed: 0 });
      expect(result.files[0]!.raw).toStartWith(header);
    }
  });

  test("keeps HTML in filenames as literal text", () => {
    const path = '<img src=x onerror="alert(1)">.txt';
    const result = parseDiff(`diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}`);
    expect(result.files[0]!.path).toBe(path);
  });

  test("retains CRLF bytes while parsing hunk framing", () => {
    const text = [...fileHeader, "@@ -1 +1 @@", "-old", "+new", ""].join("\r\n");
    const result = parseDiff(text);
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.files[0]!.path).toBe("example.ts");
    expect(result.files[0]!.raw).toBe(text);
    expect(result.files[0]!.lines.at(-1)).toEqual({ kind: "addition", text: "+new\r", newNumber: 1 });
  });

  test("handles a 512 KB patch without dropping content or line numbers", () => {
    const count = 8192;
    const additions = Array.from({ length: count }, (_, index) => `+${index.toString().padStart(4, "0")}${"x".repeat(58)}`);
    const text = patch(...fileHeader, `@@ -0,0 +1,${count} @@`, ...additions);
    expect(text.length).toBeGreaterThan(512 * 1024);
    const result = parseDiff(text);
    expect(result).toMatchObject({ added: count, removed: 0 });
    expect(result.files[0]!.raw).toBe(text);
    expect(result.files[0]!.lines.at(-1)).toEqual({ kind: "addition", text: additions.at(-1)!, newNumber: count });
  });
});
