import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { openDesktopSettings } from "./conversation-design.js";

export async function assertDesktopAppearance(page: Page, artifacts: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "system", "light");
  const dialog = await openDesktopSettings(page);
  const select = dialog.getByLabel("颜色主题", { exact: true });
  assert.equal(await select.inputValue(), "system");
  assert.equal(await page.locator(".app-shell").evaluate((element) => element instanceof HTMLElement && element.inert), true);
  await select.selectOption("dark");
  await assertTheme(page, "dark", "dark");
  await page.screenshot({ path: join(artifacts, "appearance-dark.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "dark", "dark");
  await select.selectOption("light");
  await assertTheme(page, "light", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme(page, "light", "light");
  await page.screenshot({ path: join(artifacts, "appearance-light.png") });
  await select.selectOption("system");
  await assertTheme(page, "system", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "system", "light");
  await select.selectOption("light");
  await assertTheme(page, "light", "light");
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".app-shell").evaluate((element) => element instanceof HTMLElement && element.inert), false);
  await page.reload();
  await assertDesktopAppearanceRestored(page);
  await page.screenshot({ path: join(artifacts, "workspace-light.png") });
}

export async function assertDesktopAppearanceRestored(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme(page, "light", "light");
  const dialog = await openDesktopSettings(page);
  assert.equal(await dialog.getByLabel("颜色主题", { exact: true }).inputValue(), "light");
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
}

async function assertTheme(page: Page, preference: string, resolved: "light" | "dark"): Promise<void> {
  const background = resolved === "light" ? "rgb(252, 252, 250)" : "rgb(28, 29, 27)";
  await page.waitForFunction(({ preference, background }) => {
    const conversation = document.querySelector(".conversation");
    return document.documentElement.dataset.theme === preference
      && conversation && getComputedStyle(conversation).backgroundColor === background;
  }, { preference, background });
}
