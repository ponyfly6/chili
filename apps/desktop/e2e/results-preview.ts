import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Frame, Locator, Page } from "playwright-core";
import { openDesktopSettings } from "./conversation-design.js";

const EXTERNAL_IMAGE = "https://chili-result-preview.invalid/canary.png";
const RESULT_PATH = "result-fixture/index.html";
const RESULT_LABEL = "花间首页";

/** Exercise real assistant messages, desktop IPC, and the sandboxed result scheme. */
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
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await composer.fill(`展示 [${RESULT_LABEL}](${RESULT_PATH})`);
    await composer.press("Enter");
    const results = page.getByRole("region", { name: "会话结果", exact: true });
    await results.waitFor();
    const viewbar = page.getByRole("navigation", { name: "查看方式", exact: true });
    assert.equal(await viewbar.getByRole("button", { name: /^成果(?:\s|$)/u }).getAttribute("aria-pressed"), "true",
      "The finished local result opens automatically");
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
    const source = results.getByLabel("结果文件内容", { exact: true });
    await source.waitFor();
    assert.match(await source.innerText(), /data-inline-script-ran|inlineScriptRan/u);
    assert.equal(await iframe.count(), 0, "Source mode displays text rather than rendering another document");
    await results.getByRole("button", { name: "预览", exact: true }).click();
    await assertStaticResult(await resultFrame(iframe), "花间 · 日常的花");

    await writeFile(join(fixtureDirectory, "index.html"), resultHtml("花间 · 每天一束花"));
    const beforeRefresh = await iframe.getAttribute("src");
    await results.getByRole("button", { name: "刷新结果", exact: true }).click();
    await page.waitForFunction((previous) => {
      const frame = document.querySelector<HTMLIFrameElement>(".results-html-frame");
      return Boolean(frame?.src && frame.src !== previous);
    }, beforeRefresh);
    await assertStaticResult(await resultFrame(iframe), "花间 · 每天一束花");
    await viewbar.getByRole("button", { name: "并排查看", exact: true }).click();
    await results.waitFor();
    await page.locator(".conversation-body").waitFor({ state: "visible" });
    await page.screenshot({ path: join(artifacts, "conversation-result-split.png") });

    await results.getByRole("button", { name: "继续修改", exact: true }).click();
    await page.locator(".composer-result-target").getByText(`正在修改：${RESULT_PATH}`, { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message composer"]') === document.activeElement);
    await composer.fill("把标题再简短一点");
    await composer.press("Enter");
    const expectedPrompt = `请修改文件「${RESULT_PATH}」：\n把标题再简短一点`;
    const editRequest = page.locator(".timeline .message-user .message-body").filter({ hasText: "把标题再简短一点" });
    const editReply = page.locator(".timeline .message-assistant .message-body").filter({ hasText: "把标题再简短一点" });
    await editRequest.waitFor();
    await editReply.waitFor();
    assert.equal(await editRequest.innerText(), expectedPrompt, "The edit message includes the selected file path");
    assert.equal(await editReply.innerText(), `Echo: ${expectedPrompt}`);
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
    await viewbar.getByRole("button", { name: "对话", exact: true }).click();
    assert.equal(await page.locator(".composer-result-target").count(), 0, "The target clears after the edit request is accepted");

    const settings = await openDesktopSettings(page);
    await settings.getByRole("button", { name: "通用", exact: true }).click();
    const autoOpen = settings.getByRole("checkbox", { name: /完成后直接查看成果/ });
    await autoOpen.uncheck();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await composer.fill(`再次展示 [${RESULT_LABEL}](${RESULT_PATH})`);
    await composer.press("Enter");
    await page.locator(".timeline .message-assistant").getByText(`Echo: 再次展示 [${RESULT_LABEL}](${RESULT_PATH})`, { exact: true }).waitFor();
    assert.equal(await viewbar.getByRole("button", { name: "对话", exact: true }).getAttribute("aria-pressed"), "true",
      "Turning off automatic result viewing preserves the conversation on a new result");
    await openDesktopSettings(page);
    await settings.getByRole("button", { name: "通用", exact: true }).click();
    await autoOpen.check();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "New task", exact: true }).click();
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
