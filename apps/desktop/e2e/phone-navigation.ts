import type { Page } from "playwright-core";

/** Navigate the production phone UI; never change app state through test hooks. */
export async function openPhoneTaskList(page: Page): Promise<void> {
  const list = page.getByTestId("task-list");
  if (await list.isVisible()) return;
  const deviceBack = page.getByRole("button", { name: "返回", exact: true });
  if (await deviceBack.isVisible()) await deviceBack.click();
  if (!await list.isVisible()) {
    await page.getByRole("button", { name: "打开任务列表", exact: true }).click();
  }
  await list.waitFor({ state: "visible" });
}

export async function selectPhoneTask(page: Page, title: string): Promise<void> {
  await openPhoneTaskList(page);
  await page.getByTestId("task-list").getByText(title, { exact: true }).click();
  await page.getByTestId("transcript").waitFor({ state: "visible" });
}

export async function selectPhoneSendMode(page: Page, mode: "queue" | "steer"): Promise<void> {
  const send = page.getByTestId(mode === "queue" ? "queue-send" : "steer-send");
  if (!await send.count()) {
    await page.getByRole("button", { name: /^选择发送方式，当前/u }).click();
    const sheet = page.getByRole("dialog", { name: "这条指令如何处理", exact: true });
    await sheet.getByRole("button", { name: mode === "queue" ? /^排队发送/u : /^补充当前任务/u }).click();
    await sheet.waitFor({ state: "hidden" });
  }
  await send.waitFor({ state: "visible" });
}

async function openPhoneDevice(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "电脑与连接", exact: true });
  if (!await heading.isVisible()) {
    await page.getByRole("button", { name: /^查看电脑连接：/u }).click();
  }
  await heading.waitFor({ state: "visible" });
}

export async function disconnectPhone(page: Page): Promise<void> {
  await openPhoneDevice(page);
  await page.getByTestId("disconnect").click();
}

export async function reconnectPhone(page: Page): Promise<void> {
  await openPhoneDevice(page);
  await page.getByTestId("reconnect").click();
}

export async function returnToPhoneTask(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^回到当前任务/u }).click();
  await page.getByTestId("transcript").waitFor({ state: "visible" });
}

export async function refreshPhoneTask(page: Page): Promise<void> {
  await page.getByRole("button", { name: "更多任务操作", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "当前任务", exact: true });
  await sheet.getByRole("button", { name: /^刷新任务/u }).click();
  if (await sheet.isVisible()) await sheet.getByRole("button", { name: "关闭", exact: true }).click();
}
