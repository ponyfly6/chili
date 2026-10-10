import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";

export async function assertHistoryPagination(page: Page, workspace: string, repositoryRoot: string, artifacts: string): Promise<void> {
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop;
    return (await api.invoke({ type: "sessions.create", title: "Long history E2E" })).sessionId;
  });
  await promisify(execFile)(process.env.CHILI_E2E_BUN_PATH!, [join(repositoryRoot, "apps/desktop/e2e/history-seed.ts"), join(workspace, ".chili/chili.sqlite"), sessionId], { timeout: 30_000 });
  await page.reload();
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.locator(".project-active .session-row").filter({ hasText: "Long history E2E" }).click();
  await page.locator('[data-message-id="history_message_60"]').waitFor();
  const timeline = page.locator(".conversation-dialogue .timeline");
  assert.equal(await timeline.locator("[data-message-id]").count(), 20);
  assert.doesNotMatch(await timeline.innerText(), /ARGUMENT_START|OUTPUT_START|History row 0\./u);

  await timeline.hover();
  await page.mouse.wheel(0, -500);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
  await page.waitForTimeout(150);
  const anchor = await timeline.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find((item) => item.getBoundingClientRect().top >= top)!;
    return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
  });
  const older = page.getByRole("button", { name: "加载更早的消息", exact: true });
  await older.evaluate((element) => (element as HTMLButtonElement).click());
  await page.locator('[data-message-id="history_message_21"]').waitFor({ state: "attached" });
  const after = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(Math.abs(after - anchor.top) <= 3, `Prepending must preserve the visible anchor (${anchor.top} → ${after})`);
  while (await older.count()) {
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".history-load")?.disabled);
    await older.evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForTimeout(100);
  }
  assert.equal(await timeline.locator("[data-message-id]").count(), 61, "Every message remains reachable across the oversized middle row");
  const processGroup = timeline.locator(".conversation-process").filter({ has: page.getByText("history_probe", { exact: true }) });
  await processGroup.locator(":scope > summary").click();
  const tool = timeline.locator("details.tool-details").filter({ has: page.getByText("history_probe", { exact: true }) });
  await tool.locator(":scope > summary").click();
  await tool.getByText("调用参数", { exact: true }).click();
  await tool.getByText(/ARGUMENT_START/u).waitFor();
  const input = tool.locator("details").filter({ has: page.getByText("调用参数", { exact: true }) });
  assert.ok((await input.locator("pre").innerText()).length <= 32768);
  await input.getByRole("button", { name: "下一段", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".history-content pre")?.textContent?.includes("ARGUMENT_START"));
  await tool.getByText("执行结果", { exact: true }).click();
  await tool.getByText(/OUTPUT_START/u).waitFor();
  await page.screenshot({ path: join(artifacts, "history-pagination.png") });
}
