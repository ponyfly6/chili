import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";
import { openAdvancedTaskDialog, waitForConversationIdle } from "./conversation-design.js";

export const DELETED_CONVERSATION_TITLES = ["Delete active conversation E2E", "Delete archived conversation E2E"] as const;
const OUTPUT_PATH = "retained-conversation-output.md";
const OUTPUT_CONTENT = "# Conversation output\nThis workspace file survives deleting its conversation.\n";

/** Exercise deletion through the real menus and confirmation dialog, including archived history. */
export async function assertConversationDeletion(page: Page, workspace: string, artifacts: string): Promise<void> {
  await writeFile(join(workspace, OUTPUT_PATH), OUTPUT_CONTENT, "utf8");
  const searchToggle = page.getByRole("button", { name: "搜索会话", exact: true });
  if (await searchToggle.getAttribute("aria-expanded") === "true") await searchToggle.click();

  for (const [index, title] of DELETED_CONVERSATION_TITLES.entries()) {
    const taskDialog = await openAdvancedTaskDialog(page);
    await taskDialog.getByLabel("Task title", { exact: true }).fill(title);
    await taskDialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(
      `desktop delivery fixture: ${JSON.stringify({ filePath: OUTPUT_PATH, title: "Retained conversation output" })}`,
    );
    await taskDialog.getByRole("button", { name: "Create & run", exact: true }).click();
    await taskDialog.waitFor({ state: "hidden" });
    const heading = page.getByRole("heading", { name: title, exact: true });
    await heading.waitFor();
    await page.getByRole("button", { name: "打开交付文件：Retained conversation output", exact: true }).waitFor();
    await waitForConversationIdle(page);
    const row = page.locator(".project-active .session-row").filter({ has: page.getByText(title, { exact: true }) });
    const actions = page.getByRole("button", { name: `Task actions for ${title}`, exact: true });
    const menu = page.getByRole("menu", { name: `Task actions for ${title}`, exact: true });

    if (index === 1) {
      await actions.click();
      await menu.getByRole("menuitem", { name: "归档会话", exact: true }).click();
      const archiveDialog = page.getByRole("dialog", { name: "Archive task?", exact: true });
      await archiveDialog.getByRole("button", { name: "归档会话", exact: true }).click();
      await archiveDialog.waitFor({ state: "hidden" });
      await row.waitFor({ state: "hidden" });
      await heading.waitFor({ state: "hidden" });
      if (await searchToggle.getAttribute("aria-expanded") !== "true") await searchToggle.click();
      await page.getByRole("tablist", { name: "Task status", exact: true }).getByRole("tab", { name: /^已归档/u }).click();
      await row.click();
      await heading.waitFor();
    }

    const draft = "Keep this draft if deletion is cancelled";
    if (index === 0) await page.getByLabel("Message composer", { exact: true }).fill(draft);
    await actions.click();
    await menu.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "删除会话？", exact: true });
    const cancel = deleteDialog.getByRole("button", { name: "取消", exact: true });
    await deleteDialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "取消");
    await cancel.click();
    await deleteDialog.waitFor({ state: "hidden" });
    await heading.waitFor();
    await row.waitFor();
    if (index === 0) assert.equal(await page.getByLabel("Message composer", { exact: true }).inputValue(), draft,
      "Cancelling deletion preserves the conversation and its draft");

    await actions.click();
    await menu.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    await deleteDialog.waitFor();
    if (index === 0) await page.screenshot({ path: join(artifacts, "conversation-delete-confirmation.png") });
    await deleteDialog.getByRole("button", { name: "删除会话", exact: true }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    await row.waitFor({ state: "hidden" });
    await heading.waitFor({ state: "hidden" });
    assert.notEqual(await page.getByLabel("Message composer", { exact: true }).inputValue(), draft,
      "A deleted conversation cannot leave its draft in the next conversation");
    assert.equal(await readFile(join(workspace, OUTPUT_PATH), "utf8"), OUTPUT_CONTENT,
      "Deleting a conversation preserves files delivered into the workspace");
  }

  if (await searchToggle.getAttribute("aria-expanded") === "true") await searchToggle.click();
  await page.reload();
  await page.getByRole("button", { name: "New task", exact: true }).waitFor();
  await assertDeletedConversationsStayRemoved(page, workspace);
  await searchToggle.click();
  const search = page.getByLabel("Search tasks", { exact: true });
  await search.fill("Delete ");
  const tabs = page.getByRole("tablist", { name: "Task status", exact: true });
  for (const tabName of [/^会话/u, /^已归档/u]) {
    await tabs.getByRole("tab", { name: tabName }).click();
    await page.getByText("没有找到匹配的会话。", { exact: true }).waitFor();
    assert.equal(await page.locator(".project-active .session-row").count(), 0,
      "Deleted conversations do not return in active or archived search after reload");
  }
  await searchToggle.click();
}

export async function assertDeletedConversationsStayRemoved(page: Page, workspace: string): Promise<void> {
  await page.waitForFunction(async (titles) => {
    const api = (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop;
    const state = await api.invoke({ type: "app.state" });
    if (state.sidecar.phase !== "healthy") return false;
    const sessions = await api.invoke({ type: "sessions.list", status: "all" });
    return sessions.length > 0 && sessions.every((session) => !titles.some((title) => title === session.title));
  }, [...DELETED_CONVERSATION_TITLES]);
  assert.equal(await readFile(join(workspace, OUTPUT_PATH), "utf8"), OUTPUT_CONTENT,
    "Conversation deletion never removes workspace output, including after restart");
}
