import { openAdvancedTaskDialog } from "./conversation-design.js";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";

export const TIMELINE_FOLLOW_PROMPT = "electron controlled timeline follow fixture";
const TITLE = "Live timeline follow E2E";

/** A real provider stream whose next chunk is controlled by UI assertions. */
export class TimelineFollowFixture {
  private response: ServerResponse | undefined;
  private id = 0;
  private content = "";
  private settled = false;

  open(request: IncomingMessage, response: ServerResponse, observed: { aborted: boolean }, id: number): void {
    assert.equal(this.response, undefined, "Timeline fixture must receive exactly one request");
    this.response = response;
    this.id = id;
    const abort = (): void => {
      if (this.settled) return;
      this.settled = true;
      observed.aborted = true;
      if (!response.writableEnded) response.end();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    });
    this.writeEvent({
      type: "response.created",
      response: { id: `chili_e2e_${id}`, model: "deepseek-v4-pro", status: "in_progress", output: [] },
    });
    this.writeEvent({
      type: "response.output_item.added", output_index: 0,
      item: { id: `msg_chili_e2e_${id}`, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    this.append("Short live response.");
  }

  append(content: string): void {
    assert.ok(this.response && !this.settled, "Timeline provider stream must remain active");
    this.content += content;
    this.writeEvent({
      type: "response.output_text.delta", item_id: `msg_chili_e2e_${this.id}`,
      output_index: 0, content_index: 0, delta: content,
    });
  }

  finish(): void {
    assert.ok(this.response && !this.settled, "Timeline stream must finish normally");
    this.settled = true;
    const item = {
      id: `msg_chili_e2e_${this.id}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: this.content, annotations: [] }],
    };
    this.writeEvent({
      type: "response.output_text.done", item_id: item.id,
      output_index: 0, content_index: 0, text: this.content,
    });
    this.writeEvent({ type: "response.output_item.done", output_index: 0, item });
    this.writeEvent({
      type: "response.completed",
      response: {
        id: `chili_e2e_${this.id}`, model: "deepseek-v4-pro", status: "completed", output: [item],
        usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
      },
    });
    this.response.end();
  }

  private writeEvent(event: Record<string, unknown>): void {
    assert.ok(this.response, "Timeline provider stream must be open");
    this.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

export async function assertTimelineFollowStream(page: Page, fixture: TimelineFollowFixture, artifacts: string): Promise<void> {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const dialog = await openAdvancedTaskDialog(page);
  await dialog.waitFor();
  await dialog.getByLabel("Task title", { exact: true }).fill(TITLE);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(TIMELINE_FOLLOW_PROMPT);
  const model = dialog.getByLabel("Model", { exact: true });
  const deepseek = await model.locator("option").evaluateAll((nodes) => nodes
    .map((node) => ({ value: (node as HTMLOptionElement).value, text: node.textContent ?? "" }))
    .find((option) => /deepseek.*v4.*pro/iu.test(option.text)));
  assert.ok(deepseek, "The local fixture must use the configured DeepSeek model");
  await model.selectOption(deepseek.value);
  await dialog.getByLabel("Permission profile", { exact: true }).selectOption("full-access");
  await dialog.getByLabel("Delegation", { exact: true }).selectOption("proactive");
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: TITLE, exact: true }).waitFor();
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.click();
  const timeline = page.locator(".timeline");
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  const contains = async (text: string): Promise<boolean> => (await timeline.innerText()).includes(text);
  const bottom = async (): Promise<boolean> => timeline.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
  const readHistory = async (): Promise<void> => {
    await timeline.hover();
    await page.mouse.wheel(0, -10000);
    await jump.waitFor();
    await until("history scroll settles", async () => await timeline.evaluate((element) => element.scrollTop) <= 2);
  };
  await until("initial live provider chunk", () => contains("Short live response."));
  assert.equal(await jump.isVisible(), false, "A short live response needs no jump button");

  fixture.append(paragraphs("Initial flowing row", 60));
  await until("large stream rendered and followed", async () => await contains("Initial flowing row 60.") && await bottom());
  await readHistory();
  const readingTop = await timeline.evaluate((element) => element.scrollTop);
  fixture.append(paragraphs("Output while reading", 10));
  await until("new content while reading history", () => contains("Output while reading 10."));
  await delay(150);
  assert.ok(Math.abs(await timeline.evaluate((element) => element.scrollTop) - readingTop) <= 2,
    "Live output must preserve the user's history position");
  await jump.click();
  await until("jump resumes following", bottom);
  fixture.append(paragraphs("Resumed follow row", 10));
  await until("later output remains followed", async () => await contains("Resumed follow row 10.") && await bottom());
  assert.equal(await jump.isVisible(), false, "Restored following must hide the jump button");

  await readHistory();
  await switchProject(page, "project-b");
  await page.getByRole("heading", { name: "Independent project B task", exact: true }).waitFor();
  await until("project scope clears old timeline", async () => !(await contains("Initial flowing row")));
  assert.equal(await jump.isVisible(), false, "A short second project must not inherit the old paused state");
  await switchProject(page, "workspace");
  await page.getByRole("heading", { name: TITLE, exact: true }).waitFor();
  await until("returning to the task resets following", async () => await contains("Resumed follow row 10.") && await bottom());
  fixture.append(paragraphs("Restored project follow", 5));
  await until("restored project follows new live output", async () => await contains("Restored project follow 5.") && await bottom());
  fixture.finish();
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  await readHistory();
  const jumpBounds = await jump.boundingBox();
  const composerBounds = await page.locator(".composer").boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  assert.equal(width, 390, "Native width regression must exercise the narrow desktop window");
  assert.ok(jumpBounds && composerBounds);
  assert.ok(jumpBounds.x >= 0 && jumpBounds.x + jumpBounds.width <= width);
  assert.ok(jumpBounds.y + jumpBounds.height <= composerBounds.y, "Jump button must not cover the composer");
  await page.screenshot({ path: join(artifacts, "timeline-follow-390.png") });
  await jump.click();
  await until("final jump reaches latest output", bottom);
  assert.equal(await page.locator(".inspector").count(), 0);

}

async function switchProject(page: Page, project: string): Promise<void> {
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole("button", { name: `Open project ${project}`, exact: true }).click();
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hide.isVisible()) await hide.click();
}

function paragraphs(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `\n\n${prefix} ${index + 1}.`).join("");
}

async function until(description: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
