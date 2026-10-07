import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Frame, Locator, Page } from "playwright-core";
import { startEmptyConversation, waitForConversationIdle } from "./conversation-design.js";

const EXTERNAL_IMAGE = "https://chili-result-preview.invalid/canary.png";
const RESULT_PATH = "result-fixture/index.html";
const RESULT_LABEL = "花间首页";

/** Exercise real delivery tool calls, desktop IPC, and the sandboxed result scheme. */
export async function assertDesktopResults(page: Page, workspace: string, artifacts: string, app: ElectronApplication): Promise<void> {
  const fixtureDirectory = join(workspace, "result-fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(join(fixtureDirectory, "index.html"), resultHtml("花间 · 日常的花"));
  await writeFile(join(fixtureDirectory, "local.css"), "h1 { color: rgb(26, 94, 58); } .local-style { border-top: 7px solid rgb(195, 123, 64); }\n");
  await writeFile(join(fixtureDirectory, "flower.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(fixtureDirectory, "other.html"), "<!doctype html><h1>Navigation must remain blocked</h1>");

  let externalRequests = 0;
  await page.route(EXTERNAL_IMAGE, async (route) => {
    externalRequests += 1;
    await route.abort();
  });
  await app.evaluate(({ shell }) => {
    const audit = globalThis as unknown as ResultPreviewMainAudit;
    audit.resultPreviewExternalOpens = [];
    audit.resultPreviewOriginalOpenExternal = shell.openExternal;
    shell.openExternal = async (url) => { audit.resultPreviewExternalOpens!.push(url); };
  });
  try {
    const composer = page.getByLabel("Message composer", { exact: true });
    await startEmptyConversation(page);
    const referencePrompt = `仅引用 [${RESULT_LABEL}](${RESULT_PATH})`;
    await composer.fill(referencePrompt);
    await composer.press("Enter");
    await page.locator(".timeline .message-assistant").getByText(`Echo: ${referencePrompt}`, { exact: true }).waitFor();
    await waitForConversationIdle(page);
    // The session list title arrives in a separate refresh from the reply.
    // Do not capture its temporary "新会话" label as a session identifier.
    await page.locator(".conversation-heading").getByRole("heading", { name: /^仅引用 \[花间首页\]/u }).waitFor();
    assert.equal(await page.locator(".delivery-card").count(), 0, "A local reference is not a delivered file");
    assert.equal(await page.getByRole("button", { name: "交付文件", exact: true }).count(), 0);
    const deliverySessionTitle = await page.locator(".conversation-heading h1").innerText();

    await submitDelivery(page, RESULT_LABEL);
    const results = page.getByRole("region", { name: "交付文件", exact: true });
    assert.equal(await results.isVisible(), false, "An explicit delivery keeps its preview closed until requested");
    assert.equal(await page.getByRole("navigation", { name: "查看方式", exact: true }).count(), 0,
      "The conversation has no result/chat replacement modes");
    await page.locator(".conversation-body").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "交付文件", exact: true }).click();
    await results.waitFor();
    await page.locator(".conversation-body").waitFor({ state: "visible" });
    await page.getByRole("complementary", { name: "会话侧栏", exact: true }).waitFor();
    const iframe = results.locator("iframe");
    const frame = await resultFrame(iframe);
    await assertStaticResult(frame, "花间 · 日常的花");
    const initialUrl = frame.url();
    assert.match(initialUrl, /^chili-result:\/\/[a-f\d-]+\/result-fixture\/index\.html$/u);
    assert.equal(await iframe.getAttribute("sandbox"), "");
    assert.equal(await iframe.getAttribute("referrerpolicy"), "no-referrer");
    const security = await frame.evaluate(() => ({
      scriptRan: document.documentElement.dataset.inlineScriptRan,
      bridgeAvailable: "chiliDesktop" in window,
      localImageWidth: document.querySelector<HTMLImageElement>("#local-image")?.naturalWidth,
      externalImageWidth: document.querySelector<HTMLImageElement>("#external-image")?.naturalWidth,
    }));
    assert.equal(security.scriptRan, undefined, "The preview's inline script cannot execute");
    assert.equal(security.bridgeAvailable, false, "The preview does not receive the desktop bridge");
    assert.equal(security.localImageWidth, 1, "Contained local raster images render in the result frame");
    assert.equal(security.externalImageWidth, 0);
    assert.equal(externalRequests, 0, "CSP rejects external image requests before reaching the network");
    assert.equal(frame.url(), initialUrl, "The document's meta refresh cannot replace the preview");
    await frame.getByRole("link", { name: "另一个文件", exact: true }).click();
    await frame.waitForTimeout(150);
    assert.equal(frame.url(), initialUrl, "A result link cannot navigate its iframe to another local document");
    const windowCount = app.windows().length;
    await frame.getByRole("link", { name: "外部窗口", exact: true }).click();
    await frame.waitForTimeout(150);
    assert.equal(app.windows().length, windowCount, "A sandboxed noreferrer link cannot create a popup");
    assert.deepEqual(await app.evaluate(() => (globalThis as unknown as ResultPreviewMainAudit).resultPreviewExternalOpens), [],
      "Result links never reach shell.openExternal, including target=_blank with an empty referrer");
    await frame.getByRole("heading", { name: "花间 · 日常的花", exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, "conversation-result-preview.png") });

    await results.getByRole("button", { name: "源码", exact: true }).click();
    const source = results.getByLabel("交付文件内容", { exact: true });
    await source.waitFor();
    assert.match(await source.innerText(), /data-inline-script-ran|inlineScriptRan/u);
    assert.equal(await iframe.count(), 0, "Source mode displays text rather than rendering another document");
    await results.getByRole("button", { name: "预览", exact: true }).click();
    await assertStaticResult(await resultFrame(iframe), "花间 · 日常的花");

    await writeFile(join(fixtureDirectory, "index.html"), resultHtml("花间 · 每天一束花"));
    const beforeRefresh = await iframe.getAttribute("src");
    await results.getByRole("button", { name: "刷新交付文件", exact: true }).click();
    await page.waitForFunction((previous) => {
      const frame = document.querySelector<HTMLIFrameElement>(".results-html-frame");
      return Boolean(frame?.src && frame.src !== previous);
    }, beforeRefresh);
    await assertStaticResult(await resultFrame(iframe), "花间 · 每天一束花");
    await page.locator(".conversation-body").waitFor({ state: "visible" });
    await page.screenshot({ path: join(artifacts, "conversation-result-split.png") });

    await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
    await results.waitFor({ state: "hidden" });
    const revisedLabel = `${RESULT_LABEL} · 已更新`;
    await submitDelivery(page, revisedLabel);
    assert.equal(await page.locator(".delivery-card").count(), 1, "Repeated delivery updates the same file card");
    assert.equal(await results.isVisible(), false, "A later delivery does not reopen the closed panel");
    await page.getByRole("button", { name: `打开交付文件：${revisedLabel}`, exact: true }).click();
    await results.waitFor();
    await results.getByRole("heading", { name: revisedLabel, exact: true }).waitFor();

    await results.getByRole("button", { name: "继续修改", exact: true }).click();
    await page.locator(".composer-result-target").getByText(`正在修改：${RESULT_PATH}`, { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message composer"]') === document.activeElement);

    await startEmptyConversation(page);
    assert.equal(await results.isVisible(), false, "A new conversation does not inherit another conversation's preview");
    assert.equal(await page.locator(".composer-result-target").count(), 0, "A new conversation does not inherit the file editing target");
    assert.equal(await page.locator(".delivery-card").count(), 0);
    await composer.fill("独立的交付隔离检查");
    await composer.press("Enter");
    await page.getByText("Echo: 独立的交付隔离检查", { exact: true }).waitFor();
    await waitForConversationIdle(page);
    await page.locator(".conversation-heading").getByRole("heading", { name: "独立的交付隔离检查", exact: true }).waitFor();
    await page.locator(".session-row").filter({ has: page.getByText(deliverySessionTitle, { exact: true }) }).click();
    await page.getByRole("heading", { name: deliverySessionTitle, exact: true }).waitFor();
    await page.locator(".composer-result-target").getByText(`正在修改：${RESULT_PATH}`, { exact: true }).waitFor();
    await composer.fill("把标题再简短一点");
    await composer.press("Enter");
    const expectedPrompt = `请修改文件「${RESULT_PATH}」：\n把标题再简短一点`;
    const editRequest = page.locator(".timeline .message-user .message-body").filter({ hasText: "把标题再简短一点" });
    const editReply = page.locator(".timeline .message-assistant .message-body").filter({ hasText: "把标题再简短一点" });
    await editRequest.waitFor();
    await editReply.waitFor();
    assert.equal(await editRequest.innerText(), expectedPrompt, "The edit message includes the selected file path");
    assert.equal(await editReply.innerText(), `Echo: ${expectedPrompt}`);
    await waitForConversationIdle(page);
    assert.equal(await page.locator(".composer-result-target").count(), 0, "The target clears after the edit request is accepted");
    if (await results.isVisible()) await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
    await assertNarrowDeliveryPanel(page, app, artifacts, revisedLabel);
    await startEmptyConversation(page);
  } finally {
    await page.unroute(EXTERNAL_IMAGE);
    await app.evaluate(({ shell }) => {
      const audit = globalThis as unknown as ResultPreviewMainAudit;
      if (audit.resultPreviewOriginalOpenExternal) shell.openExternal = audit.resultPreviewOriginalOpenExternal;
      delete audit.resultPreviewOriginalOpenExternal;
      delete audit.resultPreviewExternalOpens;
    });
  }
}

async function submitDelivery(page: Page, title: string): Promise<void> {
  const composer = page.getByLabel("Message composer", { exact: true });
  const responsesBefore = await page.locator(".timeline .message-assistant").count();
  await composer.fill(`desktop delivery fixture: ${JSON.stringify({ filePath: RESULT_PATH, title })}`);
  await composer.press("Enter");
  await page.getByRole("button", { name: `打开交付文件：${title}`, exact: true }).waitFor();
  await page.waitForFunction((previousCount) => document.querySelectorAll(".timeline .message-assistant").length > previousCount, responsesBefore);
  await page.locator(".timeline .message-assistant").last().getByText("I read the file and the tool loop works.", { exact: true }).waitFor();
  await waitForConversationIdle(page);
}

async function assertNarrowDeliveryPanel(page: Page, app: ElectronApplication, artifacts: string, title: string): Promise<void> {
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 820, false));
    await page.waitForFunction(() => window.innerWidth === 390);
    await page.getByRole("button", { name: `打开交付文件：${title}`, exact: true }).click();
    const panel = page.getByRole("dialog", { name: "交付文件", exact: true });
    await panel.waitFor();
    await page.getByRole("button", { name: "关闭侧栏", exact: true }).waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391, "The preview fits a narrow desktop window");
    await assertStaticResult(await resultFrame(panel.locator("iframe")), "花间 · 每天一束花");
    const footer = await panel.locator(".results-panel-footer").boundingBox();
    assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= 821,
      `The file actions remain inside the narrow viewport before scrolling: ${JSON.stringify(footer)}`);
    const continueButton = await panel.getByRole("button", { name: "继续修改", exact: true }).boundingBox();
    assert.ok(continueButton && continueButton.x >= 0 && continueButton.x + continueButton.width <= 391
      && continueButton.y >= 0 && continueButton.y + continueButton.height <= 821,
      `Continue editing is reachable without scrolling the drawer: ${JSON.stringify(continueButton)}`);
    await page.screenshot({ path: join(artifacts, "conversation-delivery-narrow.png") });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "交付文件", exact: true }).click();
    await panel.waitFor();
    const frame = await resultFrame(panel.locator("iframe"));
    await frame.getByRole("heading", { name: "花间 · 每天一束花", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.tagName === "IFRAME");
    // CDP keyboard injection bypasses Electron's before-input-event for an
    // iframe. Exercise the same native input route as a user's Escape key.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    });
    await panel.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "交付文件", exact: true }).click();
    await panel.waitFor();
    await panel.getByRole("button", { name: "继续修改", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector('[aria-label="Message composer"]') === document.activeElement);
    await page.locator(".composer-result-target").getByText(`正在修改：${RESULT_PATH}`, { exact: true }).waitFor();
  } finally {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!, false), original);
    await page.waitForFunction((width) => window.innerWidth === width, original[0]);
  }
}

/** Only the fixture's intentional script/image denials are expected console errors. */
export function isExpectedResultPreviewDiagnostic(message: string, url: string): boolean {
  const resultDocument = url.startsWith("chili-result://") || /["']chili-result:\/\//u.test(message);
  if (!resultDocument) return false;
  return /Blocked script execution.*sandboxed.*allow-scripts/u.test(message)
    || /(?:Executing|Refused to execute) inline script.*script-src 'none'/u.test(message)
    || (message.includes(EXTERNAL_IMAGE) && /(?:Loading|Refused to load) the image.*(?:Content Security Policy|img-src)/u.test(message))
    || /Blocked opening.*chili-result-preview\.invalid\/popup.*sandboxed.*allow-popups/u.test(message)
    || /Refused to execute.*refresh.*sandboxed.*allow-scripts/iu.test(message);
}

interface ResultPreviewMainAudit {
  resultPreviewExternalOpens?: string[];
  resultPreviewOriginalOpenExternal?: typeof import("electron").shell.openExternal;
}

async function resultFrame(iframe: Locator): Promise<Frame> {
  await iframe.waitFor();
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  assert.ok(frame, "The result should have its own Electron iframe");
  return frame;
}

async function assertStaticResult(frame: Frame, title: string): Promise<void> {
  await frame.getByRole("heading", { name: title, exact: true }).waitFor();
  await frame.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("#local-image");
    const external = document.querySelector<HTMLImageElement>("#external-image");
    return image?.complete && external?.complete
      && getComputedStyle(document.querySelector("h1")!).color === "rgb(26, 94, 58)";
  });
  const styles = await frame.evaluate(() => ({
    inline: getComputedStyle(document.body).backgroundColor,
    linked: getComputedStyle(document.querySelector(".local-style")!).borderTopWidth,
  }));
  assert.equal(styles.inline, "rgb(245, 242, 232)", "Inline styles remain available in the static preview");
  assert.equal(styles.linked, "7px", "Relative stylesheets resolve through the contained result scheme");
}

function resultHtml(title: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./other.html"><title>Desktop result fixture</title>
<link rel="stylesheet" href="./local.css"><style>body { margin: 0; padding: 48px; background: rgb(245, 242, 232); font: 16px system-ui; } h1 { font-size: 36px; } p { line-height: 1.8; } a { color: #1a5e3a; } .local-style { padding-top: 20px; }</style></head>
<body><p>花间 / FLOWERS FOR EVERY DAY</p><h1>${title}</h1><p class="local-style">一束花，让日常慢下来。</p>
<img id="local-image" alt="本地图片" src="./flower.png" width="24" height="24"><img id="external-image" alt="外部资源已停用" src="${EXTERNAL_IMAGE}">
<p><a href="./other.html">另一个文件</a> · <a href="https://chili-result-preview.invalid/popup" target="_blank" rel="noreferrer">外部窗口</a></p><script>document.documentElement.dataset.inlineScriptRan = "yes";</script></body></html>`;
}
