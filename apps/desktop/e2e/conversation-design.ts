import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";

export async function openDesktopSettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function openAdvancedTaskDialog(page: Page) {
  const composer = page.getByLabel("Message composer", { exact: true });
  if (await composer.isDisabled()) {
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('[aria-label="Message composer"]')?.disabled);
  }
  await composer.fill("/advanced");
  await composer.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create a new task", exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function assertConversationDesign(page: Page, artifacts: string): Promise<void> {
  await page.getByRole("heading", { name: "你想做点什么？", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "A fresh workspace must offer the composer directly");
  assert.equal(await page.locator(".inspector").getAttribute("aria-hidden"), "true");
  await page.screenshot({ path: join(artifacts, "conversation-new.png") });
  const composer = page.getByLabel("Message composer", { exact: true });
  await composer.fill("hello conversation redesign");
  await composer.press("Shift+Enter");
  assert.equal(await composer.inputValue(), "hello conversation redesign\n", "Shift+Enter inserts a newline without sending");
  await composer.press("Enter");
  await page.getByText("Echo: hello conversation redesign", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  await page.getByRole("heading", { name: "hello conversation redesign", exact: true }).waitFor();
  assert.equal(await page.locator(".timeline .message-user").count(), 1, "The first prompt is submitted once");
  assert.equal(await page.getByText("Echo: hello conversation redesign", { exact: true }).count(), 1, "Replies appear only once in the conversation");
  await composer.fill("continue this conversation");
  await composer.press("Enter");
  await page.getByText("Echo: continue this conversation", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  assert.equal(await page.locator(".timeline .message-user").count(), 2, "Follow-up messages stay in the same conversation");
  assert.equal(await page.locator(".timeline .message-assistant").count(), 2);
  assert.equal(await page.getByRole("region", { name: "成果", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /^(成果|并排查看)$/ }).count(), 0);
  await page.screenshot({ path: join(artifacts, "conversation-chat.png") });
  await composer.fill("保留这条未发送的想法");
  await page.getByRole("button", { name: "更多命令", exact: true }).click();
  await page.getByRole("option", { name: "/settings 打开设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.waitFor();
  for (const name of ["模型与账号", "权限与协作", "工具与技能", "偏好与记忆", "手机连接", "通用"]) {
    await settings.getByRole("button", { name, exact: true }).click();
    await settings.getByRole("heading", { name, exact: true }).waitFor();
  }
  assert.equal(await settings.getByRole("checkbox", { name: /完成后直接查看成果/ }).count(), 0);
  await settings.getByRole("checkbox", { name: /默认展开工作过程/ }).check();
  await settings.getByRole("button", { name: "模型与账号", exact: true }).click();
  await settings.getByLabel("Task model", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "conversation-settings.png") });
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), "保留这条未发送的想法", "Opening commands and settings must preserve an existing draft");
  await composer.fill("/mod");
  await composer.press("Enter");
  await settings.getByRole("heading", { name: "模型与账号", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await page.keyboard.press("Meta+n");
  await page.getByRole("heading", { name: "你想做点什么？", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "New conversation must never open the advanced configuration form");
  assert.equal(await composer.inputValue(), "");
  await assertProjectSessionList(page, artifacts);
}

async function assertProjectSessionList(page: Page, artifacts: string): Promise<void> {
  const composer = page.getByLabel("Message composer", { exact: true });
  const project = page.locator(".project-active");
  const rows = project.locator(".session-row");
  for (let index = 1; index <= 11; index++) {
    if (index > 1) await page.getByRole("button", { name: "New task", exact: true }).click();
    const title = `Sidebar conversation ${index}`;
    await composer.fill(title);
    await composer.press("Enter");
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.getByText(`Echo: ${title}`, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  }
  assert.equal(await rows.count(), 5, "A directory initially shows only five conversations");
  await composer.fill("保留折叠时的草稿");
  await project.getByRole("button", { name: "收起 workspace 的会话", exact: true }).click();
  assert.equal(await rows.count(), 0);
  assert.equal(await composer.inputValue(), "保留折叠时的草稿");
  await page.getByRole("heading", { name: "Sidebar conversation 11", exact: true }).waitFor();
  await project.getByRole("button", { name: "展开 workspace 的会话", exact: true }).press("Enter");
  assert.equal(await rows.count(), 5, "Reopening a directory resets it to the compact list");
  const more = project.getByRole("button", { name: /^展开更多会话/ });
  await more.click();
  assert.equal(await rows.count(), 10, "Each expansion reveals five more conversations");
  await more.click();
  assert.equal(await rows.count(), 12);
  assert.equal(await more.count(), 0, "The expansion button disappears after the last page");
  await composer.fill("");
  await rows.filter({ has: page.getByText("hello conversation redesign", { exact: true }) }).click();
  await page.getByRole("heading", { name: "hello conversation redesign", exact: true }).waitFor();
  await project.getByRole("button", { name: "收起更多会话", exact: true }).click();
  assert.equal(await rows.count(), 5);
  assert.equal(await rows.filter({ has: page.getByText("hello conversation redesign", { exact: true }) }).count(), 1,
    "An older current conversation remains visible when the list is shortened");
  await page.screenshot({ path: join(artifacts, "sidebar-compact.png") });
  await project.getByRole("button", { name: "Open project workspace", exact: true }).click();
  assert.equal(await rows.count(), 0, "The active directory name can also collapse the list");
  await page.getByRole("button", { name: "搜索会话", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search tasks", exact: true });
  await search.fill("Sidebar conversation 1");
  assert.equal(await rows.count(), 3, "Search reaches conversations outside the initial page and reveals the directory");
  await search.fill("no matching conversation");
  assert.equal(await rows.count(), 0);
  await project.getByText("没有找到匹配的会话。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "搜索会话", exact: true }).click();
  assert.equal(await rows.count(), 5);
  await project.getByRole("button", { name: "收起 workspace 的会话", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByRole("heading", { name: "你想做点什么？", exact: true }).waitFor();
  await project.getByRole("button", { name: "收起 workspace 的会话", exact: true }).waitFor();
  assert.equal(await rows.count(), 5, "A new conversation is revealed even if the directory was collapsed");
}

export async function openPhoneSettings(page: Page) {
  const dialog = await openDesktopSettings(page);
  await dialog.getByRole("button", { name: "手机连接", exact: true }).click();
  await dialog.locator(".remote-panel-embedded").waitFor();
  return dialog;
}
