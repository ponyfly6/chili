import { openAdvancedTaskDialog } from "./conversation-design.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";

/** A delegated task still completes and reports through the conversation. */
export async function assertDelegatedConversation(page: Page, workspace: string, artifacts: string): Promise<void> {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "delegated-chat-fixture", private: true }));
  const dialog = await openAdvancedTaskDialog(page);
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("Task title", { exact: true }).fill("Delegated conversation E2E");
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill("delegate read");
  await dialog.getByLabel("Permission profile", { exact: true }).selectOption("full-access");
  await dialog.getByLabel("Delegation", { exact: true }).selectOption("proactive");
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Delegated conversation E2E", exact: true }).waitFor();
  // First verify the user's completed response, then inspect the delegated
  // result and its final runtime state.
  await page.locator(".timeline").getByText("I read the file and the tool loop works.", { exact: true }).waitFor();

  let agentPath: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!agentPath && Date.now() < deadline) {
    agentPath = await page.evaluate(async () => {
      const api = (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop;
      const sessions = await api.invoke({ type: "sessions.list" });
      const session = sessions.find((candidate) => candidate.title === "Delegated conversation E2E");
      if (!session) return undefined;
      const snapshot = await api.invoke({ type: "session.snapshot", sessionId: String(session.id) });
      const agent = snapshot.agents.find((candidate) => candidate.name === "reader");
      if (!agent) return undefined;
      if (snapshot.events.some((event) => event.sessionId === agent.agentId && event.type.startsWith("message."))) {
        throw new Error("Opening the root eagerly loaded child history");
      }
      const history = await api.invoke({ type: "conversation.page", sessionId: String(session.id), targetSessionId: agent.agentId });
      const completed = history.messages.some((message) => message.parts.some((part) => part.text === "I read the file and the tool loop works."));
      return completed && agent.state === "idle" ? agent.path : undefined;
    });
    if (!agentPath) await delay(100);
  }
  assert.ok(agentPath, "The real delegated read task must complete before inspecting its result");
  assert.equal(await page.locator(".inspector").count(), 0);
  assert.equal(await page.locator(".conversation-agents").count(), 0,
    "Delegation does not insert a management panel between the reply and composer");
  const panel = page.getByRole("complementary", { name: "会话侧栏", exact: true });
  assert.equal(await panel.isVisible(), false, "Delegation does not open the side panel automatically");
  await page.getByRole("button", { name: "进展", exact: true }).click();
  await panel.waitFor();
  const details = await panel.innerText();
  assert.doesNotMatch(details, /Agent ID|Parent agent ID|Nested agents|Queue|Steer|\/root\/|Agent message:|collaborator-provided/u,
    "Progress describes work without exposing runtime identifiers or delegation controls");
  assert.equal(await panel.locator(".agent-history-timeline").count(), 0, "Child history waits for an explicit selection");
  assert.equal(await panel.locator("select").count(), 0, "Task rows are the only child navigation");
  assert.match(details, /已完成/u, "Durable child outcome appears without loading child history");
  await page.screenshot({ path: join(artifacts, "delegated-task-list.png") });
  await panel.locator(".progress-entry").filter({ hasText: "reader" }).click();
  await panel.locator(".agent-history-timeline").getByText("I read the file and the tool loop works.", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "‹ 返回子任务", exact: true }).waitFor();
  await page.locator(".conversation-body").waitFor({ state: "visible" });
  await page.screenshot({ path: join(artifacts, "delegated-conversation.png") });
  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
}
