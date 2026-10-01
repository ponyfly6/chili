import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";

/** Exercise the integrated panels using a real delegated fake-model task and Git diff. */
export async function assertWorkbenchPanels(page: Page, workspace: string, artifacts: string): Promise<void> {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "workbench-panel-fixture", private: true }));
  await writeFile(join(workspace, "panel-review.ts"), "export const workbenchPanelAnswer = 42;\n");
  await page.getByRole("button", { name: /^New task\b/iu }).click();
  const dialog = page.getByRole("dialog", { name: "Create a new task", exact: true });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("Task title", { exact: true }).fill("Workbench panels E2E");
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill("delegate read");
  await dialog.getByLabel("Permission profile", { exact: true }).selectOption("full-access");
  await dialog.getByLabel("Delegation", { exact: true }).selectOption("proactive");
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Workbench panels E2E", exact: true }).waitFor();

  const openWorkbench = page.getByRole("button", { name: "Show workbench", exact: true });
  if (await openWorkbench.count()) await openWorkbench.click();
  await page.getByRole("tab", { name: /^Activity\b/iu }).click();
  const agents = page.locator(".agent-details-panel");
  let agentPath: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!agentPath && Date.now() < deadline) {
    agentPath = await page.evaluate(async () => {
      const api = (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop;
      const sessions = await api.invoke({ type: "sessions.list" });
      const session = sessions.find((candidate) => candidate.title === "Workbench panels E2E");
      if (!session) return undefined;
      const snapshot = await api.invoke({ type: "session.snapshot", sessionId: String(session.id) });
      return snapshot.tasks.find((task) => task.prompt === "read package" && task.status === "completed")?.path;
    });
    if (!agentPath) await delay(100);
  }
  assert.ok(agentPath, "The real delegated read task must complete before inspecting its result");
  await agents.getByTitle(agentPath, { exact: true }).click();
  const details = agents.locator(".agent-details-card");
  await details.getByRole("button", { name: "Task instructions", exact: true }).click();
  await details.getByLabel("Task instructions text", { exact: true }).waitFor();
  assert.equal(await details.getByLabel("Task instructions text", { exact: true }).innerText(), "read package");
  await details.getByRole("button", { name: "Result", exact: true }).waitFor();
  await details.getByRole("button", { name: "Result", exact: true }).click();
  await details.getByLabel("Result text", { exact: true }).waitFor();
  assert.match(await details.getByLabel("Result text", { exact: true }).innerText(), /tool loop works/iu);
  await page.screenshot({ path: join(artifacts, "workbench-agent-details.png") });

  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  const review = page.getByRole("region", { name: "Changes review", exact: true });
  const picker = review.getByLabel("Changed file", { exact: true });
  await picker.waitFor();
  const fileOption = await picker.locator("option").evaluateAll((options) => options
    .map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent ?? "" }))
    .find((option) => option.text.includes("panel-review.ts")));
  assert.ok(fileOption, "The integrated diff viewer must expose the real untracked file");
  await picker.selectOption(fileOption.value);
  await review.getByText("export const workbenchPanelAnswer = 42;", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "workbench-diff-review.png") });
  await review.getByRole("button", { name: "Raw", exact: true }).click();
  assert.match(await review.getByLabel("Raw diff", { exact: true }).innerText(), /workbenchPanelAnswer = 42/u);
  await review.getByRole("button", { name: "Patch", exact: true }).click();
  await page.getByRole("tab", { name: /^Activity\b/iu }).click();
}
