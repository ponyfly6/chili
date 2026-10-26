import assert from "node:assert/strict";
import type { Page } from "playwright-core";

/** Run after the harness sets the native window width; leave the sidebar closed. */
export async function assertResponsiveNavigation(page: Page): Promise<void> {
  const taskTitle = await page.locator(".conversation-heading h1").textContent();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const sidebar = page.locator(".sidebar");

  try {
    await hidePanel(page, "sidebar");
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await waitForPanelBounds(page, ".sidebar");
    await assertSidebarResize(page);
    await sidebar.getByRole("button", { name: "打开设置", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Show sidebar", exact: true }).waitFor();
    await assertFocusOutsideHiddenPanels(page);
    // Start at the sidebar toggle and cross the header into the conversation.
    // A collapsed sidebar must never become an intermediate keyboard stop.
    await page.getByRole("button", { name: "Show sidebar", exact: true }).focus();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      await assertFocusOutsideHiddenPanels(page);
    }

    assert.equal(await page.locator(".inspector").count(), 0);
    assert.equal(await page.getByRole("button", { name: /workbench/i }).count(), 0);
    assert.equal(await page.locator(".conversation-heading h1").textContent(), taskTitle,
      "Navigation and a closed settings dialog must preserve the current task");
  } finally {
    if (await dialog.isVisible()) {
      await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    await hidePanel(page, "sidebar");
  }
}

async function assertSidebarResize(page: Page): Promise<void> {
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const handle = page.getByRole("separator", { name: "调整侧边栏宽度", exact: true });
  if (viewportWidth <= 640) {
    assert.equal(await handle.count(), 0, "The mobile overlay has no resize handle");
    return;
  }
  const initialWidth = Number(await handle.getAttribute("aria-valuenow"));
  const minWidth = Number(await handle.getAttribute("aria-valuemin"));
  const maxWidth = Number(await handle.getAttribute("aria-valuemax"));
  const bounds = await handle.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + 50, { steps: 6 });
  await assertSidebarWidth(page, initialWidth + 48);
  await page.mouse.move(viewportWidth - 1, bounds.y + 50);
  await assertSidebarWidth(page, maxWidth);
  await page.mouse.move(1, bounds.y + 50);
  await assertSidebarWidth(page, minWidth);
  await page.mouse.up();
  assert.equal(await handle.getAttribute("data-dragging"), "false");

  await handle.press("ArrowRight");
  await assertSidebarWidth(page, minWidth + 8);
  await page.keyboard.press("Meta+b");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).waitFor();
  assert.equal(await handle.count(), 0, "Collapsing removes the handle from keyboard navigation");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Show sidebar");
  await page.keyboard.press("Meta+b");
  await assertSidebarWidth(page, minWidth + 8);
  await handle.dblclick();
  await assertSidebarWidth(page, viewportWidth > 1080 ? 224 : 208);
  await waitForPanelBounds(page, ".sidebar");
}

async function assertSidebarWidth(page: Page, width: number): Promise<void> {
  await page.waitForFunction((expected) => {
    const sidebar = document.querySelector(".sidebar");
    const conversation = document.querySelector(".conversation");
    return sidebar && conversation && Math.abs(sidebar.getBoundingClientRect().width - expected) < 1
      && conversation.getBoundingClientRect().width >= 360
      && document.documentElement.scrollWidth <= window.innerWidth;
  }, width, { timeout: 8_000 });
}

async function hidePanel(page: Page, panel: "sidebar"): Promise<void> {
  const toggle = page.getByRole("button", { name: `Hide ${panel}`, exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: `Show ${panel}`, exact: true }).waitFor();
}

async function assertFocusOutsideHiddenPanels(page: Page): Promise<void> {
  const hiddenFocus = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.closest('[aria-hidden="true"], [inert]')
      ? { tag: active.tagName, label: active.getAttribute("aria-label"), text: active.textContent?.slice(0, 100) }
      : null;
  });
  assert.equal(hiddenFocus, null, `Keyboard focus entered a hidden panel: ${JSON.stringify(hiddenFocus)}`);
}

async function waitForPanelBounds(page: Page, selector: ".sidebar"): Promise<void> {
  // Poll through the existing grid transition, then require complete panel bounds.
  // Overlapping the conversation is intentional for an absolute-positioned panel.
  await page.waitForFunction((panelSelector) => {
    const workspace = document.querySelector(".workspace-grid");
    const conversation = document.querySelector(".conversation");
    const panel = document.querySelector(panelSelector);
    if (!workspace || !conversation || !panel || panel.getAttribute("aria-hidden") === "true") return false;
    const bounds = workspace.getBoundingClientRect();
    const conversationBounds = conversation.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const inside = (rect: DOMRect) => rect.width > 100 && rect.height > 0
      && rect.left >= Math.max(0, bounds.left) - 1
      && rect.right <= Math.min(window.innerWidth, bounds.right) + 1
      && rect.top >= Math.max(0, bounds.top) - 1
      && rect.bottom <= Math.min(window.innerHeight, bounds.bottom) + 1;
    if (!inside(conversationBounds) || !inside(panelBounds)) return false;
    if (getComputedStyle(panel).position === "absolute") return true;
    return panelBounds.right <= conversationBounds.left + 1;
  }, selector, { polling: "raf", timeout: 8_000 });
}
