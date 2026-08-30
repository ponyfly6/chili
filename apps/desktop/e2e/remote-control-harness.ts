import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { createServer as createPortProbe } from "node:net";
import { isAbsolute, join } from "node:path";
import { _electron as electron, firefox, type BrowserContext, type ElectronApplication, type Page } from "playwright-core";
import { FIXTURE_KEY, runCommand, startModelFixture, trustTestAuthorityInProfile, waitUntil } from "./remote-control-fixtures.js";
import { openRelayEnvelope, type PairingGrant } from "../../../packages/remote-control/src/pairing-security.js";
import { decodeWireEnvelope } from "../../../packages/remote-control/src/http-wire.js";
import type { RemoteControlFrame, RemoteControlRequestFrame } from "../../../packages/remote-control/src/protocol.js";

const temporaryRoot = process.env.CHILI_REMOTE_E2E_ROOT;
assert.ok(temporaryRoot && isAbsolute(temporaryRoot));
const certificate = {
  certificate: join(temporaryRoot, "certificate/localhost.pem"), key: join(temporaryRoot, "certificate/localhost-key.pem"),
  authority: join(temporaryRoot, "certificate/authority.pem"),
  fingerprint: createHash("sha256").update(new X509Certificate(await readFile(join(temporaryRoot, "certificate/localhost.pem"))).raw).digest("hex"),
};
const profile = join(temporaryRoot, "firefox-trusted-profile");
await trustTestAuthorityInProfile(profile, certificate.authority);
let browser: BrowserContext | undefined;
const server = createServer({ cert: await readFile(certificate.certificate), key: await readFile(certificate.key) }, (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Chili HTTPS trust probe</title><p>Trusted private HTTPS</p>");
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `https://127.0.0.1:${address.port}`;
try {
  const untrusted = await firefox.launch({ headless: true });
  let untrustedError = "";
  try {
    const page = await untrusted.newPage({ ignoreHTTPSErrors: false });
    await page.goto(origin).catch((error: unknown) => { untrustedError = String(error); });
    assert.match(untrustedError, /SEC_ERROR_UNKNOWN_ISSUER|SEC_ERROR_UNTRUSTED_ISSUER|SSL_ERROR/u);
  } finally { await untrusted.close(); }
  browser = await firefox.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: false,
    firefoxUserPrefs: { "security.enterprise_roots.enabled": false }, viewport: { width: 390, height: 844 } });
  const page = await browser.newPage();
  const response = await page.goto(origin);
  assert.equal(response?.status(), 200);
  const crypto = await page.evaluate(async () => {
    const key = await window.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const text = new TextEncoder().encode("Chili browser encryption capability proof");
    const signature = await window.crypto.subtle.sign("Ed25519", key.privateKey, text);
    return { secureContext: window.isSecureContext, verified: await window.crypto.subtle.verify("Ed25519", key.publicKey, signature, text) };
  });
  assert.deepEqual(crypto, { secureContext: true, verified: true });
  const evidence = { browser: "Playwright Firefox", browserVersion: browser.browser()?.version(),
    certificateValidation: "normal TLS verification; temporary CA trusted only in disposable NSS profile",
    systemTrustModified: false, ignoreHTTPSErrors: false, certificateFingerprint: certificate.fingerprint,
    untrustedBrowserRejected: true, crypto, origin, physicalDeviceTested: false };
  await writeFile(join(temporaryRoot, "https-trust-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`[remote-e2e] HTTPS trust probe passed: ${join(temporaryRoot, "https-trust-evidence.json")}\n`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (process.env.CHILI_REMOTE_E2E_TRUST_PROBE_ONLY === "1") process.exit(0);

const repositoryRoot = process.env.CHILI_E2E_REPOSITORY_ROOT;
const bunPath = process.env.CHILI_E2E_BUN_PATH;
assert.ok(repositoryRoot && isAbsolute(repositoryRoot));
assert.ok(bunPath && isAbsolute(bunPath));
const desktopRoot = join(repositoryRoot, "apps/desktop");
const workspace = join(temporaryRoot, "workspace");
const userData = join(temporaryRoot, "desktop-user-data");
const isolatedHome = join(temporaryRoot, "home");
const processTemporaryRoot = join(temporaryRoot, "process-tmp");
const artifacts = join(temporaryRoot, "artifacts");
for (const directory of [workspace, userData, isolatedHome, processTemporaryRoot, artifacts]) {
  await mkdir(directory, { recursive: true });
}
await writeFile(join(workspace, "README.md"), "# Real remote browser E2E workspace\n");
await runCommand("/usr/bin/git", ["init", "--quiet", workspace]);
if (process.env.CHILI_REMOTE_E2E_SKIP_BUILD !== "1") {
  process.stdout.write("[remote-e2e] Building real desktop, sidecar and mobile browser page\n");
  await runCommand(bunPath, ["run", "--cwd", "apps/control-web", "build"], repositoryRoot);
  await runCommand(bunPath, ["run", "desktop:build"], repositoryRoot);
}
// A test-only ES module serves the exact production BrowserControlClient. No
// mobile, adapter, HostBridge, service or sidecar implementation is substituted.
await runCommand(bunPath, ["build", "packages/remote-control/src/browser.ts", "--target=browser",
  "--outfile=apps/control-web/dist/assets/e2e-browser-client.js"], repositoryRoot);
const remoteBindAddress = process.env.CHILI_REMOTE_E2E_BIND_ADDRESS ?? "127.0.0.1";
const remotePort = await reservePort(remoteBindAddress);
const remoteOrigin = `https://${remoteBindAddress}:${remotePort}`;
const fixture = await startModelFixture(desktopRoot);
let desktop: ElectronApplication | undefined;
let desktopPage: Page | undefined;
let mobile: Page | undefined;
const errors: string[] = [];
const browserErrors: string[] = [];
const evidence: Record<string, unknown> = {
  physicalDeviceTested: false,
  network: remoteBindAddress === "127.0.0.1" ? "real loopback HTTPS socket (no available LAN interface)" : "real HTTPS socket via existing RFC1918/CGNAT interface; browser and host on same computer",
  remoteOrigin,
  runtime: "real Electron + HostBridge + shared DesktopControlService + compiled sidecar/runtime",
  onlyFixture: "local model HTTP responses",
  certificateValidation: "temporary NSS profile CA; ignoreHTTPSErrors false; untrusted negative above",
  viewport: { width: 390, height: 844 },
};
let desktopStdout = "";
let desktopStderr = "";
let failure: unknown;
try {
  const launchOptions = { args: [desktopRoot], cwd: repositoryRoot, timeout: 30_000,
    env: {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh",
      TMPDIR: processTemporaryRoot, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", HOME: isolatedHome,
      NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", CHILI_BUN_PATH: bunPath,
      ELECTRON_RENDERER_URL: `${fixture.origin}/renderer/index.html`, CHILI_DESKTOP_WORKSPACE: workspace,
      CHILI_DESKTOP_USER_DATA: userData, CHILI_DESKTOP_DISABLE_DEVTOOLS: "1", CHILI_DESKTOP_MODEL: "deepseek",
      CHILI_HOME: isolatedHome, DEEPSEEK_API_KEY: FIXTURE_KEY, DEEPSEEK_BASE_URL: fixture.origin,
      DEEPSEEK_MODEL: "deepseek-v4-pro", CHILI_REMOTE_BIND_ADDRESS: remoteBindAddress, CHILI_REMOTE_PORT: String(remotePort),
      CHILI_REMOTE_ORIGIN: remoteOrigin, CHILI_REMOTE_TLS_CERT: certificate.certificate, CHILI_REMOTE_TLS_KEY: certificate.key,
      CHILI_REMOTE_WEB_ROOT: join(repositoryRoot, "apps/control-web/dist"),
    } };
  desktop = await electron.launch(launchOptions);
  desktop.process().stdout?.on("data", (chunk: Buffer) => { desktopStdout = (desktopStdout + chunk.toString("utf8")).slice(-2_000_000); });
  desktop.process().stderr?.on("data", (chunk: Buffer) => { desktopStderr = (desktopStderr + chunk.toString("utf8")).slice(-2_000_000); });
  desktopPage = await desktop.firstWindow();
  desktopPage.setDefaultTimeout(30_000);
  desktopPage.on("pageerror", (error) => errors.push(error.message));
  await desktop.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await waitUntil("real sidecar healthy", async () => /healthy/iu.test(await desktopPage!.locator('[title="Local runtime status"]').innerText()));
  process.stdout.write("[remote-e2e] Creating existing task through real desktop UI\n");
  await createDesktopTask(desktopPage, "Phone Alpha real runtime", "[slow] initial desktop task");
  await waitUntil("initial streamed model request", () => fixture.requests.some((request) => request.text === "[slow] initial desktop task"));
  await desktopPage.getByTestId("remote-open").click();
  assert.equal(await desktopPage.getByTestId("remote-status").count(), 0, "Remote must start disabled");
  await desktopPage.getByTestId("remote-enable").click();
  await desktopPage.getByTestId("remote-status").waitFor();
  evidence.remoteDefaultOff = true;
  browser = await firefox.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: false,
    firefoxUserPrefs: { "security.enterprise_roots.enabled": false }, viewport: { width: 390, height: 844 } });
  await browser.tracing.start({ screenshots: true, snapshots: true, sources: true });
  mobile = await browser.newPage();
  mobile.setDefaultTimeout(30_000);
  mobile.on("pageerror", (error) => browserErrors.push(error.message));
  assert.equal((await mobile.goto(remoteOrigin))?.status(), 200);
  assert.equal(await mobile.evaluate(() => window.isSecureContext), true);
  await pairThroughUi(desktopPage, mobile);
  evidence.pairingRequiresLocalConfirmation = true;
  await mobile.getByTestId("task-list").getByText("Phone Alpha real runtime", { exact: true }).click();
  await waitUntil("real remote snapshot text", async () => (await mobile!.getByTestId("transcript").innerText()).includes("[slow] initial desktop task"));
  evidence.listAndSnapshot = true;
  await assertNarrowLayout(mobile);
  await mobile.screenshot({ path: join(artifacts, "mobile-390.png"), fullPage: true });
  process.stdout.write("[remote-e2e] Queue, local concurrent operation, Steer and Stop\n");
  await mobile.getByTestId("message-input").fill("phone queued once");
  await mobile.getByTestId("queue-send").click();
  await waitUntil("desktop sees remotely queued prompt", async () => /1 queued/iu.test(await desktopPage!.locator(".composer").innerText()));
  assert.equal(fixture.requests.filter((request) => request.text === "phone queued once").length, 0, "Queue must not preempt running task");
  // A real local window and a real phone share the service's queue simultaneously.
  await desktopPage.getByRole("button", { name: "Close phone control", exact: true }).click();
  await desktopPage.getByLabel("Message composer", { exact: true }).fill("desktop queued concurrently");
  await desktopPage.getByRole("button", { name: "Queue message", exact: true }).click();
  await mobile.getByTestId("message-input").fill("phone steer replacement");
  await mobile.getByTestId("steer-send").click();
  await waitUntil("steer aborts the real provider request", () => fixture.requests.some((request) => request.text === "[slow] initial desktop task" && request.aborted));
  await waitUntil("steer and shared queues drain", () => ["phone steer replacement", "phone queued once", "desktop queued concurrently"]
    .every((text) => fixture.requests.filter((request) => request.text === text).length === 1));
  await waitUntil("phone displays queue response", async () => (await mobile!.getByTestId("transcript").innerText()).includes("Remote fixture response: desktop queued concurrently"));
  evidence.queueSteerAndConcurrentDesktop = true;
  await mobile.getByTestId("message-input").fill("[slow] phone stop target");
  await mobile.getByTestId("queue-send").click();
  await waitUntil("phone started a real runtime turn", () => fixture.requests.some((request) => request.text === "[slow] phone stop target"));
  const stopStarted = Date.now();
  await mobile.getByTestId("stop-task").click();
  await waitUntil("phone Stop aborts real runtime turn", () => fixture.requests.some((request) => request.text === "[slow] phone stop target" && request.aborted));
  evidence.stopElapsedMs = Date.now() - stopStarted;

  process.stdout.write("[remote-e2e] Disconnect/reconnect, refresh requires fresh pairing, device revocation\n");
  await mobile.getByTestId("disconnect").click();
  await mobile.getByTestId("reconnect").click();
  await waitUntil("mobile reconnects with existing in-memory replay state", async () => /已安全连接/u.test(await mobile!.getByTestId("connection-status").innerText()));
  await mobile.getByTestId("message-input").fill("after transport reconnect");
  await mobile.getByTestId("queue-send").click();
  await waitUntil("reconnected request reaches runtime once", () => fixture.requests.filter((request) => request.text === "after transport reconnect").length === 1);
  evidence.reconnect = true;
  await mobile.getByTestId("disconnect").click();
  await desktopPage.getByTestId("remote-open").click();
  evidence.wireLoss = await proveWireLoss(browser, desktopPage, remoteOrigin);
  await mobile.reload();
  await mobile.getByTestId("pairing-code").waitFor();
  assert.match(await mobile.locator("body").innerText(), /refresh|刷新|重新配对/iu);
  evidence.refreshRequiresPairing = true;
  await desktopPage.getByTestId("remote-revoke").first().click();
  await pairThroughUi(desktopPage, mobile);
  await mobile.getByTestId("task-list").getByText("Phone Alpha real runtime", { exact: true }).click();
  await desktopPage.getByTestId("remote-revoke").first().click();
  await waitUntil("revoked phone becomes unavailable", async () => !/已安全连接/u.test((await mobile!.getByTestId("connection-status").innerText()).trim()));
  await mobile.getByTestId("pairing-code").waitFor();
  evidence.revoke = true;
  await pairThroughUi(desktopPage, mobile);
  await desktopPage.getByTestId("remote-disable").click();
  await desktopPage.getByTestId("remote-enable").waitFor();
  await waitUntil("turning remote off disconnects a live phone", async () => !/已安全连接/u.test(await mobile!.getByTestId("connection-status").innerText()));
  await desktopPage.getByTestId("remote-enable").click();
  await desktopPage.getByTestId("remote-status").waitFor();
  await mobile.getByTestId("reconnect").click();
  await mobile.getByTestId("pairing-code").waitFor();
  assert.equal(await mobile.getByTestId("task-list").count(), 0, "Re-enabling remote must not revive old authorization");
  await desktopPage.getByTestId("remote-disable").click();
  evidence.disable = true;
  evidence.enableDoesNotReviveOldGrant = true;
  process.stdout.write("[remote-e2e] Desktop restart invalidates live phone authorization\n");
  await desktopPage.getByTestId("remote-enable").click();
  await pairThroughUi(desktopPage, mobile);
  await desktop.context().tracing.stop({ path: join(artifacts, "desktop-before-restart.trace.zip") });
  await desktop.close();
  desktop = undefined;
  await waitUntil("desktop close disconnects its authorized phone", async () => !/已安全连接/u.test(await mobile!.getByTestId("connection-status").innerText()));
  desktop = await electron.launch(launchOptions);
  desktop.process().stdout?.on("data", (chunk: Buffer) => { desktopStdout = (desktopStdout + chunk.toString("utf8")).slice(-2_000_000); });
  desktop.process().stderr?.on("data", (chunk: Buffer) => { desktopStderr = (desktopStderr + chunk.toString("utf8")).slice(-2_000_000); });
  desktopPage = await desktop.firstWindow();
  desktopPage.setDefaultTimeout(30_000);
  desktopPage.on("pageerror", (error) => errors.push(error.message));
  await desktop.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await waitUntil("restarted real sidecar healthy", async () => /healthy/iu.test(await desktopPage!.locator('[title="Local runtime status"]').innerText()));
  await desktopPage.getByTestId("remote-open").click();
  assert.equal(await desktopPage.getByTestId("remote-status").count(), 0, "Desktop restart must leave remote disabled");
  await desktopPage.getByTestId("remote-enable").click();
  await desktopPage.getByTestId("remote-status").waitFor();
  await mobile.getByTestId("reconnect").click();
  await mobile.getByTestId("pairing-code").waitFor();
  assert.equal(await mobile.getByTestId("task-list").count(), 0);
  evidence.desktopRestartRevokesOldGrant = true;
  process.stdout.write("[remote-e2e] Workspace change revokes phone before starting the next real sidecar\n");
  await pairThroughUi(desktopPage, mobile);
  const workspaceTwo = join(temporaryRoot, "workspace-two");
  await mkdir(workspaceTwo, { recursive: true });
  await runCommand("/usr/bin/git", ["init", "--quiet", workspaceTwo]);
  // Only native chooser input is automated. The visible workspace button still
  // invokes production IPC, DesktopControlService, shutdown, and new sidecar.
  await desktop.evaluate(({ dialog }, selectedWorkspace) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [selectedWorkspace] };
    };
  }, workspaceTwo);
  await desktopPage.getByRole("button", { name: "Close phone control", exact: true }).click();
  await desktopPage.locator(".workspace-card").click();
  await waitUntil("real workspace switch and new sidecar health", async () =>
    (await desktopPage!.locator(".workspace-copy strong").innerText()) === "workspace-two"
      && /healthy/iu.test(await desktopPage!.locator('[title="Local runtime status"]').innerText()));
  await desktopPage.getByTestId("remote-open").click();
  await desktopPage.getByTestId("remote-enable").waitFor();
  assert.equal(await desktopPage.getByTestId("remote-status").count(), 0);
  await waitUntil("workspace selection disconnects prior phone grant", async () => !/已安全连接/u.test(await mobile!.getByTestId("connection-status").innerText()));
  await desktopPage.getByTestId("remote-enable").click();
  await desktopPage.getByTestId("remote-status").waitFor();
  await mobile.getByTestId("reconnect").click();
  await mobile.getByTestId("pairing-code").waitFor();
  await pairThroughUi(desktopPage, mobile);
  await mobile.getByText("暂时没有可访问的任务", { exact: true }).waitFor();
  assert.equal(await mobile.getByText("Phone Alpha real runtime", { exact: true }).count(), 0);
  await desktopPage.getByTestId("remote-disable").click();
  evidence.workspaceChangeRevokesOldGrant = true;
  evidence.newWorkspaceListDoesNotLeakOldTasks = true;
  evidence.workspaceChooserAutomation = "only native dialog selection result; real visible workspace button, IPC, control service and sidecar switch";
  await desktopPage.getByTestId("remote-enable").waitFor();
  assert.equal(await desktopPage.getByTestId("remote-status").count(), 0);
  await desktopPage.screenshot({ path: join(artifacts, "desktop-after-revoke.png"), fullPage: true });
  await mobile.screenshot({ path: join(artifacts, "mobile-revoked.png"), fullPage: true });
  assert.deepEqual(errors, [], "Desktop renderer errors");
  assert.deepEqual(browserErrors, [], "Real browser errors");
  assert.deepEqual(fixture.failures, [], "Local model fixture failures");
  for (const text of ["phone queued once", "desktop queued concurrently", "queue once after lost ack", "queue once after lost result", "queue once after lost both"]) {
    assert.equal(fixture.requests.filter((request) => request.text === text).length, 1, `${text} must execute exactly once after all reconnects`);
  }
  const rows = JSON.parse(await runCommand("/usr/bin/sqlite3", ["-readonly", "-json", join(workspace, ".chili/chili.sqlite"),
    "select type,count(*) as count from events group by type"])) as Array<{ type: string; count: number }>;
  evidence.durableEventCounts = rows;
  evidence.modelRequests = fixture.requests;
  evidence.browserVersion = browser.browser()?.version();
  evidence.completed = true;
} catch (error) {
  failure = error;
  evidence.completed = false;
  evidence.failure = error instanceof Error ? error.stack : String(error);
  await Promise.allSettled([
    mobile?.screenshot({ path: join(artifacts, "failure-mobile.png"), fullPage: true }),
    desktopPage?.screenshot({ path: join(artifacts, "failure-desktop.png"), fullPage: true }),
    mobile?.content().then((html) => writeFile(join(artifacts, "failure-mobile.html"), html)),
    desktopPage?.content().then((html) => writeFile(join(artifacts, "failure-desktop.html"), html)),
  ]);
} finally {
  await writeFile(join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(join(artifacts, "desktop.stdout.txt"), desktopStdout);
  await writeFile(join(artifacts, "desktop.stderr.txt"), desktopStderr);
  if (browser) {
    await browser.tracing.stop({ path: join(artifacts, "mobile.trace.zip") }).catch(() => undefined);
    await browser.close();
  }
  if (desktop) {
    await desktop.context().tracing.stop({ path: join(artifacts, "desktop.trace.zip") }).catch(() => undefined);
    await desktop.close();
  }
  await fixture.stop();
  const publishedArtifacts = join(desktopRoot, "out", "remote-control-e2e", new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(publishedArtifacts, { recursive: true });
  await cp(artifacts, publishedArtifacts, { recursive: true });
  await cp(join(temporaryRoot, "https-trust-evidence.json"), join(publishedArtifacts, "https-trust-evidence.json"));
  process.stdout.write(`[remote-e2e] Evidence retained: ${publishedArtifacts}\n`);
}
if (failure) throw failure;
process.stdout.write("[remote-e2e] Real browser → trusted HTTPS → Electron HostBridge → shared service → real sidecar passed\n");

async function reservePort(bindAddress: string): Promise<number> {
  const probe = createPortProbe();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, bindAddress, resolve); });
  const value = probe.address();
  assert.ok(value && typeof value !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return value.port;
}

async function createDesktopTask(page: Page, title: string, text: string): Promise<void> {
  await page.getByRole("button", { name: /^New task\b/iu }).click();
  const dialog = page.getByRole("dialog", { name: "Create a new task", exact: true });
  await dialog.getByLabel("Task title", { exact: true }).fill(title);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(text);
  const model = dialog.getByLabel("Model", { exact: true });
  const options = await model.locator("option").evaluateAll((nodes) => nodes.map((node) => ({
    label: node.textContent ?? "", value: (node as HTMLOptionElement).value,
  })));
  const selected = options.find((option) => /^DeepSeek V4 Pro\b/iu.test(option.label));
  assert.ok(selected);
  await model.selectOption(selected.value);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
}

async function pairThroughUi(local: Page, phone: Page): Promise<void> {
  await local.getByTestId("remote-pairing-create").click();
  const code = local.getByTestId("remote-code");
  await code.waitFor();
  await phone.getByTestId("pairing-code").fill((await code.innerText()).trim());
  const deviceName = phone.getByTestId("device-label");
  if (await deviceName.count()) await deviceName.fill("Firefox real browser E2E");
  await phone.getByTestId("pair-submit").click();
  await local.getByTestId("remote-pending-confirm").first().waitFor();
  assert.equal(await phone.getByTestId("task-list").count(), 0, "Unconfirmed phone must not receive task list");
  await local.getByTestId("remote-pending-confirm").first().click();
  await phone.getByTestId("task-list").waitFor();
}

async function assertNarrowLayout(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    width: innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.equal(metrics.width, 390);
  assert.ok(metrics.documentWidth <= 390 && metrics.bodyWidth <= 390, `Horizontal overflow: ${JSON.stringify(metrics)}`);
  for (const testId of ["message-input", "queue-send", "steer-send", "stop-task"]) {
    const bounds = await page.getByTestId(testId).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, `${testId} exceeds 390px viewport`);
  }
}

interface BrowserFaultWindow extends Window {
  remoteFaultClient: import("../../../packages/remote-control/src/browser-client.js").BrowserControlClient;
  remoteFaultPending: Promise<{ ok: boolean; code?: string; result?: unknown }>;
}

async function proveWireLoss(context: BrowserContext, local: Page, origin: string): Promise<unknown[]> {
  const page = await context.newPage();
  let pairing: PairingGrant | undefined;
  let mode: "none" | "ack" | "result" | "both" = "none";
  let targetText = "";
  let targetId = "";
  let targetSnapshot = false;
  const dropped: { type: string; requestId: string }[] = [];
  const requests: RemoteControlRequestFrame[] = [];
  const results: unknown[] = [];
  // This observer decrypts real authenticated frames only to choose which real
  // response to discard. No plaintext or credential goes into artifacts.
  await page.route("**/api/pairing/poll", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { status: string; grant?: PairingGrant };
    if (body.status === "approved" && body.grant) pairing = body.grant;
    await route.fulfill({ response });
  });
  await page.route("**/api/control/send", async (route) => {
    assert.ok(pairing, "Pairing must finish before encrypted control");
    const body = route.request().postDataJSON() as { envelope: unknown };
    const frame = openRelayEnvelope<RemoteControlFrame>(pairing.channel, decodeWireEnvelope(body.envelope));
    if (frame.type === "request") {
      requests.push(frame);
      if (frame.operation === "session.send" && frame.payload.text === targetText) targetId = frame.requestId;
      if (targetSnapshot && frame.operation === "session.snapshot") targetId = frame.requestId;
    }
    await route.continue();
  });
  await page.route("**/api/control/poll", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { envelopes?: unknown[] };
    if (!pairing || !Array.isArray(body.envelopes) || mode === "none") {
      await route.fulfill({ response }); return;
    }
    const envelopes = body.envelopes.filter((wire) => {
      const frame = openRelayEnvelope<RemoteControlFrame>(pairing!.channel, decodeWireEnvelope(wire));
      const shouldDrop = frame.type !== "resync" && frame.type !== "request" && frame.requestId === targetId
        && (mode === "both" || frame.type === mode);
      if (shouldDrop && "requestId" in frame) dropped.push({ type: frame.type, requestId: frame.requestId });
      return !shouldDrop;
    });
    await route.fulfill({ response, json: { ...body, envelopes } });
  });
  try {
    await page.goto(origin);
    await local.getByTestId("remote-pairing-create").click();
    const code = (await local.getByTestId("remote-code").innerText()).trim();
    const paired = page.evaluate(async (pairingCode) => {
      const path = "/assets/e2e-browser-client.js";
      const { BrowserControlClient } = await import(path) as typeof import("../../../packages/remote-control/src/browser-client.js");
      (window as unknown as BrowserFaultWindow).remoteFaultClient = await BrowserControlClient.pair({ pairingCode, deviceLabel: "Wire loss browser E2E" });
    }, code);
    await local.getByTestId("remote-pending-confirm").first().click();
    await paired;
    const list = await page.evaluate(async () => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("sessions.list", { status: "active" })) as { sessions: { id: string; title: string }[] };
    const sessionId = list.sessions.find((session) => session.title === "Phone Alpha real runtime")?.id;
    assert.ok(sessionId);
    const snapshot = await page.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.snapshot", { sessionId: id }), sessionId);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 48 * 1024);
    for (const forbidden of ["cwd", "apiKey", "permissions", "configuration", "rawEvents", "sidecar"]) {
      assert.ok(!Object.keys(snapshot as Record<string, unknown>).includes(forbidden));
    }
    const slowReadStopText = "[slow] unresolved snapshot Stop";
    await page.evaluate(async ({ id, text }) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.send", { sessionId: id, text, mode: "queue" }), { id: sessionId, text: slowReadStopText });
    await waitUntil("runtime started for unresolved snapshot Stop", () => fixture.requests.some((request) => request.text === slowReadStopText));
    mode = "result";
    targetSnapshot = true;
    const snapshotDropStart = dropped.length;
    await page.evaluate((id) => {
      (window as unknown as BrowserFaultWindow).remoteFaultPending = (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.snapshot", { sessionId: id })
        .then((result) => ({ ok: true, result }), (error: unknown) => ({ ok: false, code: error instanceof Error && "code" in error ? String(error.code) : "unknown" }));
    }, sessionId);
    await waitUntil("snapshot result withheld after ACK", () => dropped.length > snapshotDropStart);
    targetSnapshot = false;
    const stopStarted = Date.now();
    await page.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.stop", { sessionId: id }), sessionId);
    await waitUntil("Stop aborts while snapshot result remains unresolved", () => fixture.requests.some((request) => request.text === slowReadStopText && request.aborted));
    const stopElapsed = Date.now() - stopStarted;
    assert.ok(stopElapsed < 5_000, `Stop blocked ${stopElapsed}ms behind an unresolved snapshot result`);
    mode = "none";
    await page.evaluate(async () => { (window as unknown as BrowserFaultWindow).remoteFaultClient.disconnect(); await (window as unknown as BrowserFaultWindow).remoteFaultClient.reconnect(); });
    await page.evaluate(async () => (window as unknown as BrowserFaultWindow).remoteFaultPending);
    results.push({ unresolvedSnapshotDidNotBlockStop: true, stopElapsedMs: stopElapsed });
    for (const loss of ["ack", "result", "both"] as const) {
      process.stdout.write(`[remote-e2e] Real encrypted wire loss: ${loss}\n`);
      const holder = `[slow] ${loss} queue holder`;
      await page.evaluate(async ({ id, text }) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.send", { sessionId: id, text, mode: "queue" }), { id: sessionId, text: holder });
      await waitUntil(`${loss} holder runs`, () => fixture.requests.some((request) => request.text === holder));
      targetText = `queue once after lost ${loss}`;
      targetId = "";
      mode = loss;
      const dropStart = dropped.length;
      await page.evaluate(({ id, text }) => {
        (window as unknown as BrowserFaultWindow).remoteFaultPending = (window as unknown as BrowserFaultWindow).remoteFaultClient
          .request("session.send", { sessionId: id, text, mode: "queue" })
          .then((result) => ({ ok: true, result }), (error: unknown) => ({ ok: false,
            code: error instanceof Error && "code" in error ? String(error.code) : "unknown" }));
      }, { id: sessionId, text: targetText });
      await waitUntil(`real ${loss} encrypted response discarded`, () => {
        const types = dropped.slice(dropStart).map((drop) => drop.type);
        return loss === "both" ? types.includes("ack") && types.includes("result") : types.includes(loss);
      });
      let outcome: { ok: boolean; code?: string };
      if (loss === "ack") {
        outcome = await page.evaluate(async () => (window as unknown as BrowserFaultWindow).remoteFaultPending);
        assert.equal(outcome.ok, true, "Authenticated result proves admission despite lost ACK");
      } else {
        mode = "none";
        await page.evaluate(async () => {
          (window as unknown as BrowserFaultWindow).remoteFaultClient.disconnect();
          await (window as unknown as BrowserFaultWindow).remoteFaultClient.reconnect();
        });
        outcome = await page.evaluate(async () => (window as unknown as BrowserFaultWindow).remoteFaultPending);
        assert.deepEqual(outcome, { ok: false, code: "outcome_unknown" }, "Missing terminal result must stay unknown after resync");
      }
      mode = "none";
      const sent = requests.filter((frame) => frame.requestId === targetId);
      assert.equal(sent.length, loss === "ack" ? 1 : 2);
      assert.equal(new Set(sent.map((frame) => frame.sequence)).size, 1, "Reconnect must retain the original sequence");
      assert.equal(new Set(sent.map((frame) => frame.requestId)).size, 1, "Reconnect must retain original request ID");
      const queued = await page.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.snapshot", { sessionId: id }), sessionId) as { session: { queuedCount: number } };
      assert.equal(queued.session.queuedCount, 1, "Lost response/reconnect must never append a second queued prompt");
      const release = `release ${loss} queue`;
      await page.evaluate(async ({ id, text }) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.send", { sessionId: id, text, mode: "steer" }), { id: sessionId, text: release });
      await waitUntil(`${loss} queue drains once through real runtime`, () => fixture.requests.some((request) => request.text === targetText));
      assert.equal(fixture.requests.filter((request) => request.text === targetText).length, 1);
      results.push({ discardedFrames: dropped.slice(dropStart).map((drop) => drop.type),
        sameRequestTransmissions: sent.length, queuedCountAfterResync: queued.session.queuedCount,
        runtimeExecutionCount: 1, outcome });
    }
  } finally {
    await page.evaluate(() => (window as Partial<BrowserFaultWindow>).remoteFaultClient?.dispose()).catch(() => undefined);
    await page.close();
    // Remove the fault page's authority locally without affecting the main UI device.
    const row = local.locator(".remote-panel-device").filter({ hasText: "Wire loss browser E2E" });
    if (await row.count()) await row.getByTestId("remote-revoke").click();
  }
  return results;
}
