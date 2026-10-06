import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeInputQueue, RuntimeSessionInput } from "@chili/protocol";
import type { RuntimeAgentRecord } from "@chili/sdk";
import { AgentDetailsCard, AgentDetailsPanel } from "./AgentDetailsPanel.js";
import {
  AGENT_RECEIPT_PAGE_SIZE,
  AGENT_TREE_PAGE_SIZE,
  agentDetailsScopeKey,
  agentListPage,
  buildAgentDetailsModel,
  sessionDescendantAgents,
  visibleAgentRows,
} from "./agent-details-model.js";

test("root-only snapshots hide the child section and root identities never receive child lifecycle controls", () => {
  const root = agent("session", { name: "ROOT_IDENTITY_MARKER", path: "/root", state: "paused" });
  const child = agent("review", { parentAgentId: root.agentId, state: "running" });
  const rootOnly = Object.freeze([root]);
  expect(sessionDescendantAgents(rootOnly, root.agentId)).toEqual([]);
  expect(sessionDescendantAgents(undefined, root.agentId)).toEqual([]);
  expect(sessionDescendantAgents([root, child], undefined)).toEqual([]);
  const snapshotAgents = Object.freeze([root, child]);
  const descendants = sessionDescendantAgents(snapshotAgents, root.agentId);
  expect(descendants).toEqual([child]);
  expect(snapshotAgents).toEqual([root, child]);
  const model = buildAgentDetailsModel(descendants);
  expect(model.counts.total).toBe(1);
  expect(model.nodes.has(root.agentId)).toBe(false);
  const callback = async () => {};
  const html = renderToStaticMarkup(<>{[...model.nodes.values()].map((node) => <AgentDetailsCard key={node.agentId} node={node} onClose={() => {}} onStop={callback} onResume={callback} />)}</>);
  expect(html).toContain("Pause agent");
  expect(html).not.toContain("Continue agent");
  expect(html).not.toContain("ROOT_IDENTITY_MARKER");
});

test("counts unique identities in their current idle, running or paused state", () => {
  const model = buildAgentDetailsModel([
    agent("review", { state: "running" }),
    agent("writer", { state: "running" }),
    agent("reader", { state: "idle" }),
    agent("review", { state: "paused" }),
  ]);
  expect(model.counts).toEqual({ total: 3, idle: 1, running: 1, paused: 1 });
  expect(model.nodes.get("review")?.state).toBe("paused");
});

test("uses parent IDs for hierarchy even when display paths disagree or repeat", () => {
  const model = buildAgentDetailsModel([
    agent("root", { path: "/root" }),
    agent("review", { path: "/display/review", parentAgentId: "root" }),
    agent("same-path", { path: "/display/review", parentAgentId: "root" }),
    agent("unrelated", { path: "/root/nested" }),
    agent("check", { path: "/elsewhere", parentAgentId: "review" }),
  ]);
  expect(model.roots).toEqual(["root", "unrelated"]);
  expect(model.nodes.get("root")?.children).toEqual(["review", "same-path"]);
  expect(visibleAgentRows(model, new Set(["root", "review"])).map(({ node, depth }) => [node.agentId, depth]))
    .toEqual([["root", 0], ["review", 1], ["check", 2], ["same-path", 1], ["unrelated", 0]]);
});

test("keeps identity and expansion across pause, resume and display path changes", () => {
  const expanded = new Set(["owner", "review"]);
  const snapshot = (state: RuntimeAgentRecord["state"], path: string) => buildAgentDetailsModel([
    agent("owner"),
    agent("review", { parentAgentId: "owner", path, state }),
    agent("nested", { parentAgentId: "review" }),
  ]);
  const paused = snapshot("paused", "/old/review");
  const resumed = snapshot("running", "/new/review");
  expect(paused.nodes.get("review")?.children).toEqual(["nested"]);
  expect(resumed.nodes.get("review")?.children).toEqual(["nested"]);
  expect(visibleAgentRows(paused, expanded).map(({ node }) => node.agentId))
    .toEqual(visibleAgentRows(resumed, expanded).map(({ node }) => node.agentId));
  expect(resumed.counts).toEqual({ total: 3, idle: 2, running: 1, paused: 0 });
});

test("expanding one branch leaves its sibling descendants collapsed", () => {
  const model = buildAgentDetailsModel([
    agent("root"),
    agent("review", { parentAgentId: "root" }),
    agent("build", { parentAgentId: "root" }),
    agent("check", { parentAgentId: "review" }),
    agent("test", { parentAgentId: "build" }),
  ]);
  expect(visibleAgentRows(model, new Set()).map(({ node }) => node.agentId)).toEqual(["root"]);
  expect(visibleAgentRows(model, new Set(["root", "review"])).map(({ node }) => node.agentId))
    .toEqual(["root", "build", "review", "check"]);
});

test("partial and cyclic parent metadata never hide an identity or loop traversal", () => {
  const agents = [
    agent("orphan", { parentAgentId: "missing" }),
    agent("self", { parentAgentId: "self" }),
    agent("a", { parentAgentId: "b" }),
    agent("b", { parentAgentId: "c" }),
    agent("c", { parentAgentId: "a" }),
    agent("child", { parentAgentId: "b" }),
  ];
  const expanded = new Set(agents.map((item) => item.agentId));
  const model = buildAgentDetailsModel(agents);
  const reversed = buildAgentDetailsModel([...agents].reverse());
  const rows = visibleAgentRows(model, expanded);
  expect(rows).toHaveLength(agents.length);
  expect(new Set(rows.map(({ node }) => node.agentId)).size).toBe(agents.length);
  expect(model.roots).toEqual(["a", "orphan", "self"]);
  expect(rows.map(({ node, depth }) => [node.agentId, depth]))
    .toEqual(visibleAgentRows(reversed, expanded).map(({ node, depth }) => [node.agentId, depth]));
});

test("deep hierarchies remain traversable without recursive stack growth or source mutation", () => {
  const agents = Object.freeze(Array.from({ length: 5_000 }, (_, index) => Object.freeze(agent(String(index), index === 0 ? {} : { parentAgentId: String(index - 1) }))));
  const model = buildAgentDetailsModel(agents);
  const rows = visibleAgentRows(model, new Set(agents.map((item) => item.agentId)));
  expect(rows).toHaveLength(5_000);
  expect(rows.at(-1)?.depth).toBe(4_999);
  expect(agents[0]).not.toHaveProperty("children");
});

test("scope keys separate projects and sessions even when names contain separators", () => {
  expect(agentDetailsScopeKey("a:b", "c")).not.toBe(agentDetailsScopeKey("a", "b:c"));
  expect(agentDetailsScopeKey("project-a", "session")).not.toBe(agentDetailsScopeKey("project-b", "session"));
  expect(agentDetailsScopeKey("project-a", "first")).not.toBe(agentDetailsScopeKey("project-a", "second"));
});

test("list pages retain every identity and clamp pages after hierarchy collapse", () => {
  const items = Array.from({ length: 241 }, (_, index) => index);
  expect(agentListPage(items, 1, 100)).toEqual({ items: items.slice(100, 200), page: 1, total: 3 });
  expect(agentListPage(items, 9, 100).items).toEqual(items.slice(200));
  expect(agentListPage(["root"], 2, 100)).toEqual({ items: ["root"], page: 0, total: 1 });
});

test("initial panel renders current states and waits for selection before mounting receipts", () => {
  const html = renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId="session" agents={[
    agent("root", { name: "Coordinator" }),
    agent("review", { parentAgentId: "root", name: "Review runtime", state: "paused" }),
  ]} inputQueues={{ review: queue([input({ inputId: "PRIVATE_RECEIPT_MARKER" })]) }} />);
  expect(html).toContain("Agent hierarchy");
  expect(html).toContain('aria-label="Collapse Coordinator"');
  expect(html).toContain("Review runtime");
  expect(html).toContain("1 paused");
  expect(html).toContain("1 idle");
  expect(html).not.toContain("PRIVATE_RECEIPT_MARKER");
  expect(html).not.toContain("agent-details-card");
});

test("large hierarchies only mount one page while retaining a next-page control", () => {
  const children = Array.from({ length: 220 }, (_, index) => agent(`agent-${index}`, { parentAgentId: "root" }));
  const html = renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId="session" agents={[agent("root"), ...children]} />);
  expect(html.match(/<li /g)).toHaveLength(AGENT_TREE_PAGE_SIZE);
  expect(html).toContain('aria-label="Next agent tree page"');
});

test("details keep agent state separate from settled input outcomes and omit legacy histories", () => {
  const node = buildAgentDetailsModel([agent("review", { state: "idle", parentAgentId: "owner" })]).nodes.get("review")!;
  const html = renderToStaticMarkup(<AgentDetailsCard node={node} onClose={() => {}} inputQueue={queue([
    input({ inputId: "input_success", state: "settled", outcome: "completed" }),
    input({ inputId: "input_cancelled", state: "settled", outcome: "cancelled" }),
  ])} />);
  expect(html).toContain('class="agent-details-status agent-details-idle">Idle');
  expect(html).toContain("<dt>Agent ID</dt><dd>review</dd>");
  expect(html).toContain("<dt>Parent agent ID</dt><dd>owner</dd>");
  expect(html).toContain("input_success");
  expect(html).toContain("settled · queue · completed");
  expect(html).toContain("settled · queue · cancelled");
  expect(html).not.toContain("Task history");
  expect(html).not.toContain("Run history");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("Pause agent");
});

test("paused identities offer continue and idle or running identities offer pause", () => {
  const callback = async () => {};
  for (const state of ["idle", "running", "paused"] as const) {
    const node = buildAgentDetailsModel([agent("review", { state })]).nodes.get("review")!;
    const html = renderToStaticMarkup(<AgentDetailsCard node={node} onClose={() => {}} onStop={callback} onResume={callback} onSend={callback} />);
    expect(html).toContain(state === "paused" ? "Continue agent" : "Pause agent");
    expect(html).not.toContain(state === "paused" ? "Pause agent" : "Continue agent");
    expect(html).toContain('value="queue"');
    expect(html).toContain('value="steer"');
    expect(html).toContain('<button type="submit" disabled="">Send message</button>');
  }
});

test("receipt lists paginate and escape errors without exposing input bodies", () => {
  const node = buildAgentDetailsModel([agent("review")]).nodes.get("review")!;
  const items = Array.from({ length: 45 }, (_, index) => input({ inputId: `input_${index}`, text: "PRIVATE_PROMPT_MARKER", ...(index === 0 ? { error: '<script>alert("no")</script>' } : {}) }));
  const html = renderToStaticMarkup(<AgentDetailsCard node={node} onClose={() => {}} inputQueue={queue(items)} />);
  expect(html.match(/<li>/g)).toHaveLength(AGENT_RECEIPT_PAGE_SIZE);
  expect(html).toContain('aria-label="Next input receipts page"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("PRIVATE_PROMPT_MARKER");
  expect(html).not.toContain("input_44");
});

test("empty and loading states distinguish unselected sessions from empty snapshots", () => {
  const render = (sessionId: string | undefined, agents: RuntimeAgentRecord[] | undefined) => renderToStaticMarkup(<AgentDetailsPanel projectId="a" sessionId={sessionId} agents={agents} />);
  expect(render(undefined, undefined)).toContain("Select a session");
  expect(render("session", undefined)).toContain("Loading agents");
  expect(render("session", [])).toContain("No agents created yet");
});

test("receipt availability distinguishes missing snapshots from a loaded empty queue", () => {
  const node = buildAgentDetailsModel([agent("review")]).nodes.get("review")!;
  expect(renderToStaticMarkup(<AgentDetailsCard node={node} onClose={() => {}} />)).toContain("Input receipts are unavailable");
  expect(renderToStaticMarkup(<AgentDetailsCard node={node} onClose={() => {}} inputQueue={queue([])} />)).toContain("No queued input receipts");
});

function agent(agentId: string, overrides: Partial<RuntimeAgentRecord> = {}): RuntimeAgentRecord {
  return { agentId, name: agentId, path: `/display/${agentId}`, state: "idle", ...overrides };
}

function input(overrides: Partial<RuntimeSessionInput> = {}): RuntimeSessionInput {
  return {
    inputId: "input_review", submissionId: "submission_review", sessionId: "review" as RuntimeSessionInput["sessionId"],
    mode: "queue", state: "pending", revision: 1, sequence: 1, text: "Review the source.", acceptedAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function queue(items: RuntimeSessionInput[]): RuntimeInputQueue {
  return {
    sessionId: "review" as RuntimeInputQueue["sessionId"], paused: false, revision: 1,
    pendingCount: items.filter((item) => item.state === "pending").length,
    interruptedCount: items.filter((item) => item.outcome === "interrupted").length,
    items,
  };
}
