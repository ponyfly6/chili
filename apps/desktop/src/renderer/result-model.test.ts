import { expect, test } from "bun:test";
import type { ChatTranscriptItem } from "@chili/sdk";
import { discoverDesktopResults, localResultPath } from "./result-model.js";

function message(text: string, role = "assistant", id = "message"): ChatTranscriptItem {
  return { kind: "message", role, id, createdAt: 1, parts: [{ type: "text", id: `${id}-text`, text }] } as ChatTranscriptItem;
}

test("discovers actual assistant local links, line links and images without external or sample artifacts", () => {
  const items = [message([
    "[报告](</work/output/final report.md>)",
    "![封面](/work/output/cover.png)",
    "[代码](/work/src/main.ts:12)",
    "[外部](https://example.com/a.html) [别处](/private/report.md)",
    "```md\n[示例](example.md)\n```",
  ].join("\n")), message("[用户输入](input.md)", "user")];
  expect(discoverDesktopResults(items, "/work").map((file) => file.path)).toEqual(["src/main.ts", "output/cover.png", "output/final report.md"]);
});

test("deduplicates repeated references and preserves the latest provenance", () => {
  const files = discoverDesktopResults([message("[旧名](file.md)", "assistant", "old"), message("[新名](file.md)", "assistant", "new")], "/work");
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ id: "file.md", label: "新名", messageId: "new", source: "assistant" });
});

test("recognizes successful write results while excluding reads, failed writes and removed patch files", () => {
  const tool = (toolName: string, displayStatus: string, input: unknown, output?: string) => ({ kind: "tool", id: toolName, status: "completed", displayStatus, toolName, input, inputSummary: { title: toolName }, waitingForApproval: false, updatedAt: 5, ...(output ? { output } : {}) }) as ChatTranscriptItem;
  const files = discoverDesktopResults([
    tool("read", "succeeded", { filePath: "private.md" }, "[参考资料](reference.md)"),
    tool("activate_skill", "succeeded", { name: "design-dna" }, "Read [guide](references/generation-guide.md)"),
    tool("write", "failed", { filePath: "failed.md" }),
    tool("write", "succeeded", { filePath: "created.html" }),
    tool("apply_patch", "succeeded", {}, "Success. Updated the following files:\nA new.ts\nM existing.md\nD deleted.md"),
  ], "/work");
  expect(files.map((file) => file.path)).toEqual(["existing.md", "new.ts", "created.html"]);
});

test("normalizes local references and rejects paths outside the workspace", () => {
  expect(localResultPath("file:///work/a%20b.md", "/work")).toBe("a b.md");
  expect(localResultPath("./a/../b.ts#L12", "/work")).toBe("b.ts");
  expect(localResultPath("C:\\work\\file.md", "C:\\work")).toBe("file.md");
  for (const value of ["../secret.md", "/workspace/secret.md", "file://evil/work/a.md", "javascript:alert(1)", "https://example.com/a.md", "data:text/html,no", "bad%00.md"]) {
    expect(localResultPath(value, "/work")).toBeUndefined();
  }
  expect(discoverDesktopResults([message("[file](a.md)")], undefined)).toEqual([]);
});

test("bounds the candidate list", () => {
  const items = Array.from({ length: 100 }, (_, index) => message(`[${index}](file-${index}.md)`));
  const files = discoverDesktopResults(items, "/work");
  expect(files).toHaveLength(80);
  expect(files[0]?.path).toBe("file-99.md");
});
