import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";

export async function assertDesktopAppearance(page: Page, artifacts: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "system", "light");
  const trigger = page.getByRole("button", { name: "Appearance settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Appearance", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("radio", { name: /System/ }).isChecked(), true);
  assert.equal(await page.locator(".app-shell").evaluate((element) => element instanceof HTMLElement && element.inert), true);

  await dialog.getByRole("radio", { name: /Dark/ }).check();
  await assertTheme(page, "dark", "dark");
  await page.screenshot({ path: join(artifacts, "appearance-dark.png") });
  // Explicit choices remain stable even when the OS appearance changes.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "dark", "dark");

  await dialog.getByRole("radio", { name: /Light/ }).check();
  await assertTheme(page, "light", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme(page, "light", "light");
  await page.screenshot({ path: join(artifacts, "appearance-light.png") });

  await dialog.getByRole("radio", { name: /System/ }).check();
  await assertTheme(page, "system", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme(page, "system", "light");

  // Native radio keyboard navigation changes the preference immediately.
  await dialog.getByRole("radio", { name: /System/ }).focus();
  await page.keyboard.press("ArrowRight");
  await assertTheme(page, "dark", "dark");
  await page.keyboard.press("ArrowRight");
  await assertTheme(page, "light", "light");
  await page.waitForFunction(() => {
    const done = document.querySelector<HTMLButtonElement>(".appearance-dialog .primary");
    return done && !done.disabled;
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Appearance settings");
  assert.equal(await page.locator(".app-shell").evaluate((element) => element instanceof HTMLElement && element.inert), false);

  await page.reload();
  await assertDesktopAppearanceRestored(page);
  await page.screenshot({ path: join(artifacts, "workspace-light.png") });
}

export async function assertDesktopAppearanceRestored(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme(page, "light", "light");
  await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Appearance", exact: true });
  assert.equal(await dialog.getByRole("radio", { name: /Light/ }).isChecked(), true);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
}

async function assertTheme(page: Page, preference: string, resolved: "light" | "dark"): Promise<void> {
  const background = resolved === "light" ? "rgb(255, 253, 249)" : "rgb(24, 24, 23)";
  await page.waitForFunction(({ preference, background }) => {
    const conversation = document.querySelector(".conversation");
    return document.documentElement.dataset.theme === preference
      && conversation && getComputedStyle(conversation).backgroundColor === background;
  }, { preference, background });
}
