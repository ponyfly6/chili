import { expect, test } from "bun:test";
import type { ChatTranscriptItem } from "@chili/sdk";
import { discoverDesktopResults, localResultPath } from "./result-model.js";

type ToolRow = Extract<ChatTranscriptItem, { kind: "tool" }>;
function tool(toolName: string, input: unknown, output?: string, overrides: Partial<ToolRow> = {}): ChatTranscriptItem {
  return { kind: "tool", id: toolName, status: "completed", displayStatus: "succeeded", toolName, input,
    inputSummary: { title: toolName }, waitingForApproval: false, updatedAt: 5, ...(output ? { output } : {}), ...overrides } as ChatTranscriptItem;
}
function delivery(path: string, fields: Record<string, unknown> = {}, overrides: Partial<ToolRow> = {}): ChatTranscriptItem {
  return tool("present_file", { path }, JSON.stringify({ type: "presented_file", path, ...fields }), overrides);
}
function message(text: string): ChatTranscriptItem {
  return { kind: "message", role: "assistant", id: "message", createdAt: 1,
    parts: [{ type: "text", id: "message-text", text }, { type: "image", id: "image", mimeType: "image/png", sourcePath: "/work/cover.png" }] } as ChatTranscriptItem;
}

test("only successful explicit delivery output creates a result, including formats without an inline preview", () => {
  const results = discoverDesktopResults([
    delivery("/work/output/report.md", { title: " 调研报告 ", description: " 最终结论及来源。 " }),
    delivery("/work/output/report.pdf"),
  ], "/work");
  expect(results).toEqual([
    { id: "output/report.pdf", path: "output/report.pdf", label: "report.pdf", source: "tool", messageId: "present_file", updatedAt: 5 },
    { id: "output/report.md", path: "output/report.md", label: "调研报告", description: "最终结论及来源。", source: "tool", messageId: "present_file", updatedAt: 5 },
  ]);
});

test("assistant links, images, tool inputs, reads and writes do not implicitly deliver files", () => {
  const output = JSON.stringify({ type: "presented_file", path: "/work/report.md" });
  expect(discoverDesktopResults([
    message("[报告](/work/report.md) ![封面](/work/cover.png)"),
    tool("read", { path: "/work/report.md" }, output),
    tool("write", { filePath: "/work/report.md" }, output),
    tool("write_file", { path: "/work/report.md" }, output),
    tool("edit", { file_path: "/work/report.md" }, output),
    tool("apply_patch", {}, "Success. Updated the following files:\nA report.md\nM page.html"),
    tool("present_file", { path: "/work/report.md", title: "Only an input" }),
  ], "/work")).toEqual([]);
});

test("failed, cancelled, running, malformed and non-delivery tool output is ignored", () => {
  const malformed = ["not json", "null", "[]", "{}", JSON.stringify({ type: "other", path: "/work/a.md" }),
    JSON.stringify({ type: "presented_file", path: 123 }), JSON.stringify({ type: "presented_file", path: "/work/a.md", title: {} }),
    JSON.stringify({ type: "presented_file", path: "/work/a.md", description: false })];
  const result = discoverDesktopResults([
    ...["queued", "running", "failed", "cancelled", "rejected", "waiting_permission"].map((displayStatus) => delivery("/work/a.md", {}, { displayStatus: displayStatus as ToolRow["displayStatus"] })),
    delivery("/work/a.md", {}, { error: "file missing" }),
    ...malformed.map((output) => tool("present_file", {}, output)),
    delivery("a.md"), delivery("file:///work/a.md"), delivery("/outside/a.md"),
  ], "/work");
  expect(result).toEqual([]);
  expect(discoverDesktopResults([delivery("/work/a.md")], undefined)).toEqual([]);
});

test("deduplicates by file and keeps the newest delivery even when transcript order differs", () => {
  const files = discoverDesktopResults([
    delivery("/work/file.md", { title: "新名", description: "新版" }, { id: "new" as ToolRow["id"], updatedAt: 10 }),
    delivery("/work/other.md", {}, { id: "other" as ToolRow["id"], updatedAt: 7 }),
    delivery("/work/file.md", { title: "旧名" }, { id: "old" as ToolRow["id"], updatedAt: 1 }),
    tool("edit", { filePath: "/work/file.md" }, "Updated", { updatedAt: 20 }),
  ], "/work");
  expect(files.map((result) => result.path)).toEqual(["file.md", "other.md"]);
  expect(files[0]).toMatchObject({ label: "新名", description: "新版", messageId: "new", updatedAt: 10, source: "tool" });
  const sameTime = discoverDesktopResults([delivery("/work/file.md", { title: "第一版" }), delivery("/work/file.md", { title: "第二版" })], "/work");
  expect(sameTime).toHaveLength(1);
  expect(sameTime[0]?.label).toBe("第二版");
});

test("uses successful output provenance instead of the requested file or title", () => {
  const files = discoverDesktopResults([tool("present_file", { path: "/work/input.md", title: "输入" },
    JSON.stringify({ type: "presented_file", path: "/work/canonical.md", title: "已交付" }))], "/work");
  expect(files[0]).toMatchObject({ path: "canonical.md", label: "已交付" });
});

test("preserves canonical filename characters and rejects noncanonical or outside paths", () => {
  expect(localResultPath("/work/a%20b.md", "/work/")).toBe("a%20b.md");
  expect(localResultPath("/work/a.md#L12", "/work")).toBe("a.md#L12");
  expect(localResultPath("/work/a.md:12", "/work")).toBe("a.md:12");
  expect(localResultPath("C:\\work\\file.md", "C:\\work")).toBe("file.md");
  expect(localResultPath("c:\\WORK\\file.md", "C:\\work")).toBe("file.md");
  expect(localResultPath("/file.md", "/")).toBe("file.md");
  for (const value of ["a.md", "../secret.md", "/work", "/work/", "/work/../secret.md", "/work/./a.md", "/work//a.md", "/workspace/a.md", "file:///work/a.md", "https://example.com/a.md", "/work/bad\0.md"]) {
    expect(localResultPath(value, "/work")).toBeUndefined();
  }
});

test("keeps earlier explicit deliveries through long conversations and bounds display metadata", () => {
  const items = [delivery("/work/report.md", { title: "x".repeat(200), description: "y".repeat(1_000) }),
    ...Array.from({ length: 5_001 }, () => message("Reading another file."))];
  const files = discoverDesktopResults(items, "/work");
  expect(files).toHaveLength(1);
  expect(files[0]?.label).toHaveLength(120);
  expect(files[0]?.description).toHaveLength(500);
});
