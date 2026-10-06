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
      const completed = snapshot.events.some((event) => event.type === "message.part_added"
        && event.sessionId === agent.agentId && event.payload.part.type === "text"
        && event.payload.part.text === "I read the file and the tool loop works.");
      return completed && agent.state === "idle" ? agent.path : undefined;
    });
    if (!agentPath) await delay(100);
  }
  assert.ok(agentPath, "The real delegated read task must complete before inspecting its result");
  await page.locator(".timeline").getByText("I read the file and the tool loop works.", { exact: true }).waitFor();
  assert.equal(await page.locator(".inspector").count(), 0);
  await page.screenshot({ path: join(artifacts, "delegated-conversation.png") });
}
