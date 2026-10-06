import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { parseChiliEvent, type SessionId } from "@chili/protocol";
import { applyRuntimeEvent, createRuntimeView } from "@chili/sdk";
import { resolveTuiTheme } from "../theme/index.js";
import { AgentsView, agentsViewModel } from "./AgentsView.js";

const theme = resolveTuiTheme("chili-dark", {});
const parentId = "session_main" as SessionId;

test("Agents view renders stable identities from child Session events", async () => {
  const runtimeView = createRuntimeView();
  for (const [name, status] of [["reader", "running"], ["reviewer", "idle"]] as const) {
    const sessionId = `session_${name}`;
    applyRuntimeEvent(runtimeView, parseChiliEvent({
      id: `created_${name}`, type: "session.created", time: 1, sessionId,
      payload: { sessionId, cwd: "/repo", agent: { parentSessionId: parentId, name, path: `/root/${name}`, policy: {} } },
    }));
    applyRuntimeEvent(runtimeView, parseChiliEvent({
      id: `status_${name}`, type: "session.status_changed", time: 2, sessionId,
      payload: { sessionId, status },
    }));
  }
  const model = agentsViewModel({
    runtimeView,
    sessionId: parentId,
    delegationConfig: { sessionId: parentId, policy: "explicit", source: "session" },
  });
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<AgentsView model={model} theme={theme} />, { width: 120, height: 12, exitOnCtrlC: false });
  });
  try {
    await act(async () => { await app.renderOnce(); });
    const frame = app.captureCharFrame();
    expect(frame).toContain("Agents · 1 active, 2 total");
    expect(frame).toContain("Delegation on request (source session)");
    expect(frame).toContain("reader · running");
    expect(frame).toContain("session_reader · /root/reader");
    expect(frame).toContain("reviewer · idle");
    expect(frame).toContain("session_reviewer · /root/reviewer");
    expect(frame).not.toContain("Team");
    expect(frame).not.toContain("Ad-hoc");
  } finally {
    await act(async () => { app.renderer.destroy(); });
  }
});

test("empty Agents view explains how to create an Agent", async () => {
  const model = agentsViewModel({ runtimeView: createRuntimeView(), sessionId: parentId });
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(<AgentsView model={model} theme={theme} />, { width: 120, height: 8, exitOnCtrlC: false });
  });
  try {
    await act(async () => { await app.renderOnce(); });
    const frame = app.captureCharFrame();
    expect(frame).toContain("Agents · 0 active, 0 total");
    expect(frame).toContain("No agents in this session.");
    expect(frame).toContain("Ask Chili to create agents and describe their work.");
  } finally {
    await act(async () => { app.renderer.destroy(); });
  }
});
