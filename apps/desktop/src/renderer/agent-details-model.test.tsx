import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeAgentRunRecord, RuntimeAgentTaskRecord, RuntimeAgentTreeNode, RuntimeAgentTreeSnapshot } from "@chili/sdk";
import { AgentDetailsPanel, AgentTextDisclosure } from "./AgentDetailsPanel.js";
import {
  AGENT_TEXT_LIMIT,
  AGENT_TREE_PAGE_SIZE,
  agentDetailsScopeKey,
  agentDuration,
  agentListPage,
  agentTaskRun,
  agentTextPreview,
  agentTextPage,
  boundedAgentText,
  buildAgentDetailsModel,
  visibleAgentRows,
} from "./agent-details-model.js";

test("merges duplicated snapshot records and presents pending follow-ups instead of the previous completed run", () => {
  const original = task({ status: "completed", updatedAt: 20 });
  const followup = task({ status: "pending", generation: 2, updatedAt: 30 });
  const completedRun = run({ status: "completed", completedAt: 20 });
  const child = node("/root/review", { tasks: [original], runs: [completedRun] });
  const model = buildAgentDetailsModel(tree([node("/root", { children: [child] })], { agents: [completedRun], tasks: [original] }), [followup]);
  expect(model.counts).toEqual({ total: 1, running: 0, pending: 1, completed: 0, failed: 0, incomplete: 0, cancelled: 0 });
  expect(model.nodes.get("/root/review")?.tasks).toEqual([followup]);
  expect(model.nodes.get("/root/review")?.runs).toHaveLength(1);
  expect(model.nodes.get("/root/review")?.status).toBe("pending");
});

test("retains nested agents and expands one branch without exposing its sibling descendants", () => {
  const grandchild = node("/root/review/check", { tasks: [task({ id: "task_check" as never, path: "/root/review/check" as never })] });
  const review = node("/root/review", { children: [grandchild] });
  const build = node("/root/build", { children: [node("/root/build/test")] });
  const model = buildAgentDetailsModel(tree([node("/root", { children: [review, build] })]));
  expect(visibleAgentRows(model, new Set()).map((item) => item.node.path)).toEqual(["/root"]);
  const visible = visibleAgentRows(model, new Set(["/root", "/root/review"]));
  expect(visible.map((item) => item.node.path)).toEqual(["/root", "/root/build", "/root/review", "/root/review/check"]);
  expect(visible.at(-1)?.depth).toBe(2);
});

test("tasks omitted from nested node records remain inspectable from the snapshot task list", () => {
  const model = buildAgentDetailsModel(tree([]), [task()]);
  expect(model.roots).toEqual(["/root/review"]);
  expect(model.counts.running).toBe(1);
  expect(model.nodes.get("/root/review")?.tasks[0]?.prompt).toBe("Review concurrent state transitions.");
});

test("current run association never falls back to a different task's result", () => {
  const other = run({ id: "run_other" as never, taskId: "task_other" as never, createdAt: 90 });
  const model = buildAgentDetailsModel(tree([], { agents: [other, run()], tasks: [task()] }));
  const review = model.nodes.get("/root/review")!;
  expect(agentTaskRun(review, task())?.id).toBe("run_review" as never);
  expect(agentTaskRun(review, task({ currentRunId: "run_missing" as never }))).toBeUndefined();
});

test("scope keys separate projects and sessions even when names contain separators", () => {
  expect(agentDetailsScopeKey("a:b", "c")).not.toBe(agentDetailsScopeKey("a", "b:c"));
  expect(agentDetailsScopeKey("project-a", "session")).not.toBe(agentDetailsScopeKey("project-b", "session"));
  expect(agentDetailsScopeKey("project-a", "first")).not.toBe(agentDetailsScopeKey("project-a", "second"));
});

test("previews respect grapheme clusters and expanded text has an explicit bounded budget", () => {
  expect(agentTextPreview("👩🏽‍💻e\u0301你好", 2)).toBe("👩🏽‍💻e\u0301…");
  expect(agentTextPreview("  hello  ", 5)).toBe("hello");
  expect(boundedAgentText("a".repeat(AGENT_TEXT_LIMIT + 100))).toEqual({ text: "a".repeat(AGENT_TEXT_LIMIT), omitted: 100 });
  expect(boundedAgentText("a😀b", 2)).toEqual({ text: "a", omitted: 3 });
});

test("every section of a long result remains readable without splitting normal graphemes or mounting the entire output", () => {
  const text = "👩🏽‍💻e\u0301你好".repeat(4_000) + "FINAL_RESULT_MARKER";
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    const page = agentTextPage(text, start);
    expect(page.text.length).toBeLessThanOrEqual(AGENT_TEXT_LIMIT);
    expect(page.end).toBeGreaterThan(start);
    pages.push(page.text);
    start = page.end;
  }
  expect(pages.join("")).toBe(text);
  expect(pages.at(-1)).toEndWith("FINAL_RESULT_MARKER");
  expect(agentTextPage("a👩🏽‍💻b", 0, 7).text).toBe("a");
  expect(agentTextPage("a👩🏽‍💻b", 1, 8).text).toBe("👩🏽‍💻b");
  expect(agentTextPage("e" + "\u0301".repeat(AGENT_TEXT_LIMIT * 2), 0).text.length).toBe(AGENT_TEXT_LIMIT);
});

test("list pages preserve access to all agents and clamp pages when a tree collapses", () => {
  const items = Array.from({ length: 241 }, (_, index) => index);
  expect(agentListPage(items, 1, 100)).toEqual({ items: items.slice(100, 200), page: 1, total: 3 });
  expect(agentListPage(items, 9, 100).items).toEqual(items.slice(200));
  expect(agentListPage(["root"], 2, 100)).toEqual({ items: ["root"], page: 0, total: 1 });
});

test("durations use terminal timestamps and clamp skewed clocks", () => {
  expect(agentDuration(1_000, 62_000, 9_999_999)).toBe("1m 1s");
  expect(agentDuration(10_000, undefined, 9_000)).toBe("0s");
  expect(agentDuration(0, undefined, 3_660_000)).toBe("1h 1m");
  expect(agentDuration(Number.NaN, undefined, 1)).toBe("Unavailable");
});

test("initial agent panel leaves instructions and results unmounted until an agent is selected", () => {
  const html = renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId="session" tree={tree([node("/root", { children: [node("/root/review", { tasks: [task({ summary: "PRIVATE_RESULT_MARKER" })] })] })])} />);
  expect(html).toContain("Delegated agent hierarchy");
  expect(html).toContain('aria-label="Collapse Main agent"');
  expect(html).toContain("Review runtime");
  expect(html).not.toContain("PRIVATE_RESULT_MARKER");
  expect(html).not.toContain("Review concurrent state transitions.");
  expect(html).not.toContain("agent-details-card");
});

test("large trees only mount one page of rows while retaining a next-page control", () => {
  const children = Array.from({ length: 220 }, (_, index) => node(`/root/agent-${index}`));
  const html = renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId="session" tree={tree([node("/root", { children })])} />);
  expect(html.match(/<li /g)).toHaveLength(AGENT_TREE_PAGE_SIZE);
  expect(html).toContain('aria-label="Next agent tree page"');
});

test("result and error bodies are escaped, collapsed and not merely hidden in a large DOM", () => {
  const html = renderToStaticMarkup(<AgentTextDisclosure label="Error" text={'<script>alert("no")</script>\n' + "a".repeat(500) + "END_MARKER"} error />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<pre");
  expect(html).not.toContain("END_MARKER");
  expect(html.length).toBeLessThan(1_000);
});

test("empty and loading states distinguish an unselected task from an empty snapshot", () => {
  const render = (sessionId: string | undefined, snapshot: RuntimeAgentTreeSnapshot | undefined) => renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId={sessionId} tree={snapshot} />);
  expect(render(undefined, undefined)).toContain("Select a task");
  expect(render("session", undefined)).toContain("Loading delegated agents");
  expect(render("session", tree([]))).toContain("No agents delegated yet");
});

function task(overrides: Partial<RuntimeAgentTaskRecord> = {}): RuntimeAgentTaskRecord {
  return { id: "task_review" as never, path: "/root/review" as never, taskName: "Review runtime", status: "running", generation: 1, prompt: "Review concurrent state transitions.", createdAt: 10, updatedAt: 10, ...overrides };
}

function run(overrides: Partial<RuntimeAgentRunRecord> = {}): RuntimeAgentRunRecord {
  return { id: "run_review" as never, taskId: "task_review" as never, path: "/root/review" as never, taskName: "Review runtime", status: "running", createdAt: 10, ...overrides };
}

function node(path: string, overrides: Partial<RuntimeAgentTreeNode> = {}): RuntimeAgentTreeNode {
  return { path: path as never, taskName: "", status: "empty", runIds: [], runs: [], tasks: [], mailbox: [], children: [], createdAt: 10, updatedAt: 10, ...overrides };
}

function tree(nodes: RuntimeAgentTreeNode[], overrides: Partial<RuntimeAgentTreeSnapshot> = {}): RuntimeAgentTreeSnapshot {
  return { nodes, agents: [], tasks: [], mailbox: [], ...overrides };
}
