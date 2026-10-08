import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createPortProbe } from "node:net";
import { isAbsolute, join } from "node:path";
import { _electron as electron, firefox, type BrowserContext, type ElectronApplication, type Page } from "playwright-core";
import { openAdvancedTaskDialog, openPhoneSettings } from "./conversation-design.js";
import { runCommand, trustTestAuthorityInProfile, waitUntil } from "./remote-control-fixtures.js";
import { selectPhoneTask } from "./phone-navigation.js";
import type { BrowserControlClient } from "../../../packages/remote-control/src/browser-client.js";
import type { ControlClientPlatform, NativeControlHttpRequest, NativeControlHttpResponse } from "../../../packages/remote-control/src/client-platform.js";
import type { DeviceRecoveryRecord } from "../../../packages/remote-control/src/device-recovery.js";
import type { RemoteDesktopSnapshot, RemoteDesktopSessionList } from "../src/main/remote-control-adapter.js";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";
import type { ChiliRemoteDesktopApi, RemoteDesktopRequest, RemoteDesktopState } from "../src/shared/remote-control-contracts.js";

const repositoryRoot = requiredEnvironment("CHILI_E2E_REPOSITORY_ROOT");
const temporaryRoot = requiredEnvironment("CHILI_MOBILE_E2E_ROOT");
const bunPath = requiredEnvironment("CHILI_E2E_BUN_PATH");
const desktopRoot = join(repositoryRoot, "apps/desktop");
const workspace = join(temporaryRoot, "workspace");
const userData = join(temporaryRoot, "desktop-user-data");
const isolatedHome = join(temporaryRoot, "home");
const processTmp = join(temporaryRoot, "process-tmp");
const artifacts = join(temporaryRoot, "artifacts");
const webRoot = join(temporaryRoot, "web");
const profile = join(temporaryRoot, "firefox-profile");
const certificate = {
  cert: join(temporaryRoot, "certificate/localhost.pem"),
  key: join(temporaryRoot, "certificate/localhost-key.pem"),
  authority: join(temporaryRoot, "certificate/authority.pem"),
};
const fixtureKey = "chili-mobile-continuity-local-model-only";
const taskTitle = "Mobile continuity real runtime";
const inputPrompt = "Ask the mobile continuity question";
const uiInputPrompt = "Ask the mobile React UI question";
const resumedPrompt = "Continue from the reopened phone";
const answerLabel = "Continue";
const question = { id: "next_step", header: "Next step", question: "Continue the mobile continuity task?", options: [
  { label: answerLabel, description: "Continue the existing task." },
  { label: "Pause", description: "Wait for the desktop user." },
] };
for (const path of [workspace, userData, isolatedHome, processTmp, artifacts]) await mkdir(path, { recursive: true });
await writeFile(join(workspace, "README.md"), "# Isolated mobile continuity E2E\n");
await runCommand("/usr/bin/git", ["init", "--quiet", workspace]);
if (process.env.CHILI_MOBILE_E2E_SKIP_BUILD !== "1") {
  process.stdout.write("[mobile-e2e] Building the real desktop and sidecar\n");
  await runCommand(bunPath, ["run", "desktop:build"], repositoryRoot);
}
await cp(join(repositoryRoot, "apps/control-web/dist"), webRoot, { recursive: true });
await runCommand(bunPath, ["build", "packages/remote-control/src/browser.ts", "--target=browser",
  `--outfile=${join(webRoot, "assets/e2e-mobile-client.js")}`], repositoryRoot);
await trustTestAuthorityInProfile(profile, certificate.authority);
const remotePort = await reservePort();
const remoteOrigin = `https://127.0.0.1:${remotePort}`;
const provider = await startProvider();
let application: ElectronApplication | undefined;
let desktop: Page | undefined;
let browser: BrowserContext | undefined;
let phone: Page | undefined;
let recovery: DeviceRecoveryRecord | undefined;
let failure: unknown;
const runtimeErrors: string[] = [];
const browserErrors: string[] = [];
const transportObservations: { pathname: string; status: number; nativeHeader: boolean; originAbsent: boolean }[] = [];
const evidence: Record<string, unknown> = {
  physicalDeviceTested: false,
  nativePluginExecuted: false,
  secureStorageTested: false,
  nativeBoundary: "Node HTTPS and memory-vault contract fixtures; not Capacitor, Keychain or Android Keystore",
  productionPath: "Firefox WebCrypto + BrowserControlClient + HTTPS HostBridge + Electron shared control service + compiled sidecar/runtime",
  model: "local deterministic HTTP responses, including an actual request_user_input tool call",
  certificateValidation: "normal TLS verification, isolated NSS profile CA and Node test-only CA; no OS trust changes",
  desktopRestartResumesTrust: false,
};
let stderr = "";
try {
  await launchDesktop();
  await createTask();
  await openPhoneSettings(desktop!);
  await desktop!.getByTestId("remote-enable").click();
  await desktop!.getByTestId("remote-status").waitFor();
  await openPhone();
  await installNativeBoundary(phone!);
  await pairNative();
  assert.ok(recovery, "Native pairing must deliver a recovery record to its explicit store");
  assert.equal(recovery.baseUrl, remoteOrigin);
  assert.equal("credential" in recovery, false, "Recovery stores an identity, not a replayable control credential");
  assert.equal("channel" in recovery, false, "Recovery must not persist the active encryption channel");
  assert.equal(await phone!.evaluate(() => localStorage.length), 0, "Native identity must not leak into web localStorage");
  const tasks = await remoteRequest("sessions.list", {}) as RemoteDesktopSessionList;
  const session = tasks.sessions.find((row) => row.title === taskTitle);
  assert.ok(session);
  const sessionId = session.id;
  let snapshot: RemoteDesktopSnapshot | undefined;
  await waitUntil("real request_user_input reaches phone projection", async () => {
    snapshot = await remoteRequest("session.snapshot", { sessionId }) as RemoteDesktopSnapshot;
    return snapshot.inputRequests.length === 1;
  });
  const input = snapshot!.inputRequests[0]!;
  assert.deepEqual(input.questions, [question]);
  assert.equal(snapshot!.session.needsDesktop.input, false, "An answerable first-party question must not require desktop");
  const invalid = await remoteFailure("session.answerInput", { sessionId, inputId: input.id, answers: { next_step: ["unoffered option"] } });
  assert.ok(invalid, "An unoffered option must be rejected at the real service boundary");
  assert.equal(provider.answered.length, 0, "Rejected answers must not unblock the real tool");
  assert.deepEqual(await remoteRequest("session.answerInput", { sessionId, inputId: input.id, answers: { next_step: [answerLabel] } }), { resolved: true });
  await waitUntil("model receives actual resolved tool result", () => provider.answered.length === 1);
  assert.ok(provider.answered[0]!.includes(answerLabel));
  await waitUntil("answer completes the original runtime turn", async () => {
    snapshot = await remoteRequest("session.snapshot", { sessionId }) as RemoteDesktopSnapshot;
    return snapshot.inputRequests.length === 0 && snapshot.messages.some((row) => row.text.includes("Mobile answer received"));
  });
  assert.ok(await remoteFailure("session.answerInput", { sessionId, inputId: input.id, answers: { next_step: [answerLabel] } }),
    "A second, newly identified answer must not resolve an already resolved input again");
  const resolvedEvents = JSON.parse(await runCommand("/usr/bin/sqlite3", ["-readonly", "-json", join(workspace, ".chili/chili.sqlite"),
    "select count(*) as count from events where type = 'user_input.resolved'"])) as { count: number }[];
  assert.equal(resolvedEvents[0]?.count, 1, "The real runtime must durably resolve the input exactly once");
  evidence.answerInput = { projectedQuestionExact: true, invalidOptionRejected: true, resolved: true,
    modelContinuationCount: provider.answered.length, durableResolvedEvents: 1, staleAnswerRejected: true };

  process.stdout.write("[mobile-e2e] Close the browser process and recover the existing device identity\n");
  const deviceId = recovery.deviceId;
  await browser!.close(); browser = undefined; phone = undefined;
  await openPhone();
  await installNativeBoundary(phone!);
  await resumeNative();
  assert.equal((await remoteState()).devices.filter((item) => item.deviceId === deviceId).length, 1,
    "Recovery must reuse the authorized device, not silently pair a duplicate");
  assert.equal((await remoteRequest("sessions.list", {}) as RemoteDesktopSessionList).sessions.some((row) => row.id === sessionId), true);
  await remoteRequest("session.send", { sessionId, text: resumedPrompt, mode: "queue" });
  await waitUntil("recovered phone sends into the same real task", () => provider.requests.filter((text) => text === resumedPrompt).length === 1);
  await waitUntil("resumed message completes", async () => {
    const result = await remoteRequest("session.snapshot", { sessionId }) as RemoteDesktopSnapshot;
    return result.messages.some((row) => row.text.includes(`Mobile fixture response: ${resumedPrompt}`));
  });
  evidence.appProcessRecovery = { browserProcessActuallyClosed: true, sameDeviceId: true, sameRuntimeTask: true,
    localConfirmationCount: 1, newPromptExecutionCount: 1 };

  // Resume a second client while the first is alive. The host must rotate the
  // active grant so the first client cannot keep using its old credential.
  const oldPhone = phone!;
  const newPhone = await browser!.newPage();
  await newPhone.goto(remoteOrigin);
  await installNativeBoundary(newPhone);
  phone = newPhone;
  await resumeNative();
  assert.ok(await oldPhone.evaluate(async () => {
    try { await (window as unknown as NativeProbeWindow).mobileClient.request("sessions.list", {}); return false; }
    catch { return true; }
  }), "A successful resume must invalidate the old active grant");
  await oldPhone.close();
  evidence.recoveryRotatesGrant = true;

  process.stdout.write("[mobile-e2e] Revocation blocks recovery, and ordinary web pairing stays ephemeral\n");
  await remoteInvoke({ type: "device.revoke", deviceId });
  await phone!.evaluate(() => (window as unknown as NativeProbeWindow).mobileClient.dispose());
  assert.ok(await resumeFailure(), "A revoked device must not regain authority through recovery");
  evidence.revocationBlocksRecovery = true;
  await proveWebPairingEphemeral(sessionId);

  // A fresh native device proves the documented enable-epoch boundary: desktop
  // shutdown loses device trust, and reopening the app does not auto-enable it.
  await installNativeBoundary(phone!);
  await pairNative();
  await browser!.close(); browser = undefined; phone = undefined;
  await application!.close(); application = undefined; desktop = undefined;
  await launchDesktop();
  assert.equal((await remoteState()).enabled, false);
  await remoteInvoke({ type: "enable" });
  await openPhone();
  await installNativeBoundary(phone!);
  assert.ok(await resumeFailure(), "A previous desktop epoch must require new local pairing");
  evidence.desktopRestart = { remoteDefaultsOff: true, oldIdentityRecoveryRejected: true, requiresLocalPairing: true };
  assert.deepEqual(provider.failures, []);
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(browserErrors, []);
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.passed = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  await phone?.screenshot({ path: join(artifacts, "phone-failure.png"), fullPage: true }).catch(() => undefined);
  await desktop?.screenshot({ path: join(artifacts, "desktop-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser?.close().catch(() => undefined);
  await application?.close().catch(() => undefined);
  await provider.stop();
  evidence.transport = { requests: transportObservations.length,
    allOriginlessWithNativeHeader: transportObservations.every((row) => row.nativeHeader && row.originAbsent),
    paths: [...new Set(transportObservations.map((row) => row.pathname))],
  };
  evidence.browserErrors = browserErrors;
  evidence.runtimeErrors = runtimeErrors;
  await writeFile(join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(join(artifacts, "desktop-stderr.log"), stderr);
  process.stdout.write(`[mobile-e2e] Evidence: ${join(artifacts, "evidence.json")}\n`);
}
if (failure) throw failure;
process.stdout.write("[mobile-e2e] Native contract continuity and real runtime answerInput passed (no physical-device claim)\n");

interface DesktopProbeWindow extends Window { chiliDesktop: ChiliDesktopApi; chiliRemote: ChiliRemoteDesktopApi }
interface NativeProbeWindow extends Window {
  mobileClient: BrowserControlClient;
  mobilePlatform: ControlClientPlatform;
  nativePost(request: Omit<NativeControlHttpRequest, "signal">): Promise<NativeControlHttpResponse>;
  saveRecovery(record: DeviceRecoveryRecord): Promise<void>;
  nativePairing?: Promise<void>;
}
function requiredEnvironment(name: string): string {
  const value = process.env[name]; assert.ok(value && isAbsolute(value), `Missing ${name}`); return value;
}
async function reservePort(): Promise<number> {
  const probe = createPortProbe();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function launchDesktop(): Promise<void> {
  application = await electron.launch({ args: [desktopRoot], cwd: repositoryRoot, timeout: 30_000, env: {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", HOME: isolatedHome,
    CHILI_HOME: isolatedHome, TMPDIR: processTmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", CHILI_BUN_PATH: bunPath,
    CHILI_DESKTOP_WORKSPACE: workspace, CHILI_DESKTOP_USER_DATA: userData, CHILI_DESKTOP_DISABLE_DEVTOOLS: "1",
    CHILI_DESKTOP_MODEL: "deepseek", ELECTRON_RENDERER_URL: `${provider.origin}/renderer/index.html`,
    DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: provider.origin, DEEPSEEK_MODEL: "deepseek-v4-pro",
    CHILI_REMOTE_BIND_ADDRESS: "127.0.0.1", CHILI_REMOTE_PORT: String(remotePort), CHILI_REMOTE_ORIGIN: remoteOrigin,
    CHILI_REMOTE_TLS_CERT: certificate.cert, CHILI_REMOTE_TLS_KEY: certificate.key, CHILI_REMOTE_WEB_ROOT: webRoot,
  } });
  application.process().stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-256_000); });
  desktop = await application.firstWindow();
  desktop.setDefaultTimeout(30_000);
  desktop.on("pageerror", (error) => runtimeErrors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setFocusable(false); });
  await waitUntil("real sidecar healthy", async () => /healthy/iu.test(await desktop!.locator('[title="Local runtime status"]').innerText()));
}
async function createTask(): Promise<void> {
  const dialog = await openAdvancedTaskDialog(desktop!);
  await dialog.getByLabel("Task title", { exact: true }).fill(taskTitle);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(inputPrompt);
  const model = dialog.getByLabel("Model", { exact: true });
  const options = await model.locator("option").evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, value: (node as HTMLOptionElement).value })));
  const selected = options.find((option) => /^DeepSeek V4 Pro\b/iu.test(option.text ?? "")); assert.ok(selected);
  await model.selectOption(selected.value);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
async function openPhone(): Promise<void> {
  browser = await firefox.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: false,
    firefoxUserPrefs: { "security.enterprise_roots.enabled": false }, viewport: { width: 390, height: 844 } });
  phone = await browser.newPage();
  phone.setDefaultTimeout(30_000);
  phone.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  assert.equal((await phone.goto(remoteOrigin))?.status(), 200);
  assert.equal(await phone.evaluate(() => isSecureContext), true);
}
async function installNativeBoundary(page: Page): Promise<void> {
  // Playwright cannot execute the OS bridge; this boundary deliberately and
  // visibly emulates its originless HTTPS contract without altering fetch.
  await page.exposeFunction("nativePost", nativePost).catch((error: unknown) => {
    if (!String(error).includes("already")) throw error;
  });
  await page.exposeFunction("saveRecovery", (record: DeviceRecoveryRecord) => { recovery = structuredClone(record); }).catch((error: unknown) => {
    if (!String(error).includes("already")) throw error;
  });
  await page.evaluate(async (origin) => {
    const module = await import(`${location.origin}/assets/e2e-mobile-client.js`) as typeof import("../../../packages/remote-control/src/browser.js");
    const target = window as unknown as NativeProbeWindow;
    target.mobilePlatform = module.createNativeControlPlatform({ baseUrl: origin, crypto: window.crypto,
      postJson: ({ signal: _signal, ...request }) => target.nativePost(request) });
  }, remoteOrigin);
}
async function pairNative(): Promise<void> {
  const state = await remoteInvoke({ type: "pairing.create" }); assert.ok(state.pairing);
  await phone!.evaluate(({ code }) => {
    const target = window as unknown as NativeProbeWindow;
    target.nativePairing = (async () => {
      const module = await import(`${location.origin}/assets/e2e-mobile-client.js`) as typeof import("../../../packages/remote-control/src/browser.js");
      target.mobileClient = await module.BrowserControlClient.pair({ baseUrl: target.mobilePlatform.baseUrl,
        platform: target.mobilePlatform, pairingCode: code, deviceLabel: "Native contract continuity E2E", rememberDevice: true,
        recoveryStore: { save: (record) => target.saveRecovery(record) } });
    })();
  }, { code: state.pairing.code });
  await waitUntil("native identity awaits local approval", async () => (await remoteState()).pending.length === 1);
  await remoteInvoke({ type: "pairing.approve", pairingId: (await remoteState()).pending[0]!.pairingId });
  await phone!.evaluate(async () => (window as unknown as NativeProbeWindow).nativePairing);
}
async function resumeNative(): Promise<void> {
  assert.ok(recovery);
  await phone!.evaluate(async (record) => {
    const module = await import(`${location.origin}/assets/e2e-mobile-client.js`) as typeof import("../../../packages/remote-control/src/browser.js");
    const target = window as unknown as NativeProbeWindow;
    target.mobileClient = await module.BrowserControlClient.resume({ record, platform: target.mobilePlatform });
  }, recovery);
}
async function resumeFailure(): Promise<boolean> {
  assert.ok(recovery);
  return phone!.evaluate(async (record) => {
    const module = await import(`${location.origin}/assets/e2e-mobile-client.js`) as typeof import("../../../packages/remote-control/src/browser.js");
    const target = window as unknown as NativeProbeWindow;
    try { target.mobileClient = await module.BrowserControlClient.resume({ record, platform: target.mobilePlatform }); return false; }
    catch { return true; }
  }, recovery);
}
async function remoteInvoke(request: RemoteDesktopRequest): Promise<RemoteDesktopState> {
  return desktop!.evaluate((request) => (window as unknown as DesktopProbeWindow).chiliRemote.invoke(request), request);
}
async function remoteState(): Promise<RemoteDesktopState> { return remoteInvoke({ type: "status" }); }
async function remoteRequest(operation: string, payload: Record<string, unknown>): Promise<unknown> {
  return phone!.evaluate(async ({ operation, payload }) => {
    const client = (window as unknown as NativeProbeWindow).mobileClient;
    return client.request(operation as Parameters<typeof client.request>[0], payload as Parameters<typeof client.request>[1]);
  }, { operation, payload });
}
async function remoteFailure(operation: string, payload: Record<string, unknown>): Promise<boolean> {
  return phone!.evaluate(async ({ operation, payload }) => {
    const client = (window as unknown as NativeProbeWindow).mobileClient;
    try { await client.request(operation as Parameters<typeof client.request>[0], payload as Parameters<typeof client.request>[1]); return false; }
    catch { return true; }
  }, { operation, payload });
}
async function proveWebPairingEphemeral(sessionId: string): Promise<void> {
  const page = await browser!.newPage(); await page.goto(remoteOrigin);
  const state = await remoteInvoke({ type: "pairing.create" }); assert.ok(state.pairing);
  await page.getByTestId("pairing-code").fill(state.pairing.code);
  await page.getByTestId("pair-submit").click();
  await waitUntil("web pairing approval", async () => (await remoteState()).pending.length === 1);
  await remoteInvoke({ type: "pairing.approve", pairingId: (await remoteState()).pending[0]!.pairingId });
  await page.getByTestId("task-list").waitFor();
  await desktop!.evaluate(({ sessionId, text }) => (window as unknown as DesktopProbeWindow).chiliDesktop.invoke({
    type: "session.send", sessionId, text, mode: "queue",
  }), { sessionId, text: uiInputPrompt });
  await selectPhoneTask(page, taskTitle);
  await page.getByRole("button", { name: "查看问题", exact: true }).click();
  const questionSheet = page.getByRole("dialog", { name: "需要你的回答", exact: true });
  const card = questionSheet.getByTestId("input-request-card");
  await card.waitFor();
  await card.getByRole("radio", { name: /^Continue/u }).check();
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(metrics.width === 390 && metrics.scrollWidth <= 391, "Input card must fit a 390px mobile viewport");
  await page.screenshot({ path: join(artifacts, "phone-answer-question-390.png"), fullPage: true });
  await card.getByRole("button", { name: "提交回答", exact: true }).click();
  await card.waitFor({ state: "hidden" });
  await questionSheet.waitFor({ state: "hidden" });
  await waitUntil("real mobile React answer reaches runtime", () => provider.answered.length === 2);
  await page.reload();
  await page.getByTestId("pairing-code").waitFor();
  assert.equal(await page.getByTestId("task-list").count(), 0);
  evidence.webPairing = { realReactUi: true, answerInputUiToRuntime: true, inputFits390px: true, refreshRequiresPairing: true };
  await page.close();
}
async function nativePost(request: Omit<NativeControlHttpRequest, "signal">): Promise<NativeControlHttpResponse> {
  const url = new URL(request.url); assert.equal(url.origin, remoteOrigin);
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers["origin"], undefined); assert.equal(headers["cookie"], undefined);
  assert.equal(Object.keys(headers).some((name) => name.startsWith("sec-fetch-")), false);
  assert.equal(headers["x-chili-control-client"], "native-v1");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", headers, ca: undefined, rejectUnauthorized: true }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > request.maxResponseBytes) { req.destroy(new Error("Native contract response limit")); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { reject(new Error("Native contract redirects forbidden")); return; }
        transportObservations.push({ pathname: url.pathname, status, nativeHeader: true, originAbsent: true });
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error("Native contract request timeout")));
    req.once("error", reject); req.end(request.body);
  });
}
async function startProvider(): Promise<{ origin: string; requests: string[]; answered: string[]; failures: string[]; stop(): Promise<void> }> {
  const requests: string[] = []; const answered: string[] = []; const failures: string[] = [];
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { failures.push(String(error)); response.writeHead(500); response.end("Fixture failure"); });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET") {
      const asset = url.pathname.replace(/^\/renderer\//u, ""); assert.ok(/^(index\.html|assets\/[\w.-]+)$/u.test(asset));
      response.writeHead(200, { "content-type": asset.endsWith("html") ? "text/html" : asset.endsWith("css") ? "text/css" : "text/javascript" });
      response.end(await readFile(join(desktopRoot, "out/renderer", asset))); return;
    }
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`); assert.ok(url.pathname.endsWith("/chat/completions"));
    let raw = ""; for await (const chunk of request) { raw += String(chunk); assert.ok(raw.length < 4_000_000); }
    const body = JSON.parse(raw) as { messages: { role: string; content: unknown; tool_call_id?: string }[] };
    const user = body.messages.findLast((message) => message.role === "user"); assert.equal(typeof user?.content, "string");
    const text = user!.content as string; requests.push(text);
    const isQuestion = text === inputPrompt || text === uiInputPrompt;
    const callId = text === uiInputPrompt ? "mobile_ui_question_call" : "mobile_question_call";
    const toolResult = body.messages.findLast((message) => message.role === "tool" && message.tool_call_id === callId);
    const ask = isQuestion && !toolResult;
    if (isQuestion && toolResult) answered.push(JSON.stringify(toolResult.content));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `mobile_fixture_${requests.length}`, model: "deepseek-v4-pro", choices: [{ index: 0,
      finish_reason: ask ? "tool_calls" : "stop", message: ask ? { role: "assistant", content: null,
        tool_calls: [{ id: callId, type: "function", function: { name: "request_user_input", arguments: JSON.stringify({ questions: [question] }) } }] }
        : { role: "assistant", content: isQuestion ? "Mobile answer received" : `Mobile fixture response: ${text}` } }],
      usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }));
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, requests, answered, failures,
    async stop() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
