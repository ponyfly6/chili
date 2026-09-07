import assert from "node:assert/strict";
import type { Page } from "playwright-core";

const LATEST_BUTTON_NAME = "Jump to latest";

/** Exercise native scrolling and ResizeObserver without sending a model request. */
export async function assertTimelineNavigation(page: Page): Promise<void> {
  const timeline = page.locator(".timeline");
  const content = timeline.locator(".timeline-content");
  const latest = page.getByRole("button", { name: LATEST_BUTTON_NAME, exact: true });
  const fixtureId = `timeline-navigation-${Date.now()}`;
  await content.waitFor({ state: "visible" });
  const viewportHeight = await timeline.evaluate((element) => element.clientHeight);
  assert.ok(viewportHeight > 0, "The timeline must have a visible scroll viewport");

  try {
    // Begin in the normal follow state even if an earlier check scrolled upward.
    await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await waitForBottom(page);
    await latest.waitFor({ state: "hidden" });
    await content.evaluate((element, fixture) => {
      const block = document.createElement("div");
      block.dataset.timelineNavigationFixture = fixture.id;
      block.setAttribute("aria-hidden", "true");
      block.style.cssText = `height:${fixture.height}px;flex:none;min-width:0;pointer-events:none`;
      element.append(block);
    }, { id: fixtureId, height: Math.max(1_200, viewportHeight * 3) });
    await waitForBottom(page);

    await timeline.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - Math.max(240, element.clientHeight));
    });
    await latest.waitFor({ state: "visible" });
    const paused = await timeline.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }));

    await growFixture(page, fixtureId, Math.max(600, viewportHeight));
    await page.waitForFunction((previousHeight) => {
      const element = document.querySelector(".timeline");
      return element !== null && element.scrollHeight > previousHeight;
    }, paused.height, { polling: "raf", timeout: 8_000 });
    await waitForLayout(page);
    const afterGrowth = await timeline.evaluate((element) => element.scrollTop);
    assert.ok(Math.abs(afterGrowth - paused.top) <= 1,
      `New content must preserve the reader's scroll position (${paused.top} → ${afterGrowth})`);
    assert.equal(await latest.isVisible(), true, "New content must retain the route back to the latest output");

    await latest.click();
    await waitForBottom(page);
    await latest.waitFor({ state: "hidden" });

    // A successful click must resume future following, rather than only jump once.
    await growFixture(page, fixtureId, Math.max(600, viewportHeight));
    await waitForBottom(page);
    await latest.waitFor({ state: "hidden" });
  } finally {
    await content.evaluate((element, id) => {
      for (const block of Array.from(element.querySelectorAll<HTMLElement>("[data-timeline-navigation-fixture]"))) {
        if (block.dataset.timelineNavigationFixture === id) block.remove();
      }
    }, fixtureId);
  }
}

async function growFixture(page: Page, fixtureId: string, height: number): Promise<void> {
  await page.locator(".timeline-content").evaluate((element, fixture) => {
    const block = Array.from(element.querySelectorAll<HTMLElement>("[data-timeline-navigation-fixture]"))
      .find((candidate) => candidate.dataset.timelineNavigationFixture === fixture.id);
    if (!block) throw new Error("The timeline navigation fixture disappeared");
    block.style.height = `${block.offsetHeight + fixture.height}px`;
  }, { id: fixtureId, height });
}

async function waitForBottom(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const element = document.querySelector(".timeline");
    return element !== null && element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
  }, undefined, { polling: "raf", timeout: 8_000 });
}

async function waitForLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}
