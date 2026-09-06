import assert from "node:assert/strict";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { createServer as createPortProbe } from "node:net";
import { isAbsolute, join } from "node:path";
import { _electron as electron, firefox, type BrowserContext, type ElectronApplication, type Page } from "playwright-core";
import { FIXTURE_KEY, runCommand, startModelFixture, trustTestAuthorityInProfile, waitUntil } from "./remote-control-fixtures.js";
import { openRelayEnvelope, type PairingGrant } from "../../../packages/remote-control/src/pairing-security.js";
import { decodeWireEnvelope } from "../../../packages/remote-control/src/http-wire.js";
import type { RemoteControlFrame, RemoteControlRequestFrame } from "../../../packages/remote-control/src/protocol.js";
import type { ChiliRemoteDesktopApi, RemoteDesktopState } from "../src/shared/remote-control-contracts.js";

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
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    } };
  desktop = await electron.launch(launchOptions);
  assert.deepEqual(await desktop.evaluate(() => [
    "CHILI_REMOTE_BIND_ADDRESS", "CHILI_REMOTE_PORT", "CHILI_REMOTE_ORIGIN",
    "CHILI_REMOTE_TLS_CERT", "CHILI_REMOTE_TLS_KEY", "CHILI_REMOTE_WEB_ROOT",
  ].filter((name) => process.env[name] !== undefined)), [], "Native setup must run without HTTPS launch configuration");
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
  process.stdout.write("[remote-e2e] Saving private HTTPS through the native desktop setup and testing picker cancellation\n");
  const savedSetup = await configureThroughUi(desktop, desktopPage, userData);
  evidence.nativeSetupModal = await assertNativeSetupModal(desktop, desktopPage);
  evidence.nativeSetup = {
    launchHttpsEnvironmentFields: 0,
    realDesktopFormAndIpc: true,
    chooserAutomation: "only native certificate/private-key dialog selection results; production settings validation and persistence",
    certificatePickerCancellationLeavesSetupAbsent: true,
    keyPickerCancellationPreservesPreviousSetup: true,
    saveLeavesRemoteOff: true,
    settingsFileMode: "0600",
    persistedFields: ["version", "bindAddress", "port", "tlsCertPath", "tlsKeyPath"],
    authorizationAndEnabledStatePersisted: false,
    rendererContainsNoTlsPathsOrContents: true,
  };
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
  evidence.unknownOutcomeUi = await proveStickyUnknownOutcomeUi(browser, desktopPage, remoteOrigin);
  evidence.wireLoss = await proveWireLoss(browser, desktopPage, remoteOrigin, desktop);
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
  await desktopPage.getByTestId("remote-setup-replace-tls").waitFor();
  assert.equal(await desktopPage.getByTestId("remote-setup-address").inputValue(), remoteBindAddress);
  assert.equal(await desktopPage.getByTestId("remote-setup-port").inputValue(), String(remotePort));
  const restoredSetup = await readDesktopRemoteState(desktopPage);
  assert.equal(restoredSetup.setup?.source, "saved", "Restart must restore native setup without launch configuration");
  assert.equal(restoredSetup.enabled, false);
  assert.deepEqual(restoredSetup.devices, [], "Restart cannot restore paired device authority");
  assert.equal(restoredSetup.pairing, undefined, "Restart cannot restore a pairing code");
  assert.equal(await assertPersistedSetup(userData), savedSetup, "Pairing and restart must not write authority into setup");
  await assertNoTlsMaterialInRenderer(desktopPage, restoredSetup);
  evidence.desktopRestartPreservesNativeSetupWithoutAuthorization = true;
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
  assert.equal(await assertPersistedSetup(userData), savedSetup, "Workspace persistence must not replace phone setup");
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

interface DesktopSetupWindow extends Window { chiliRemote: ChiliRemoteDesktopApi }
interface NativeDialogProbe {
  original: Electron.Dialog["showOpenDialog"];
  titles: string[];
  unexpected: boolean;
}
interface NativeDialogGlobal { __chiliNativeTlsDialogProbe?: NativeDialogProbe }

async function readDesktopRemoteState(page: Page): Promise<RemoteDesktopState> {
  return page.evaluate(() => (window as unknown as DesktopSetupWindow).chiliRemote.invoke({ type: "status" }));
}

/** Replace only native chooser results; the form, IPC, manager, TLS reads and save are real. */
async function chooseTlsThroughUi(application: ElectronApplication, page: Page, button: string, selections: Array<string | null>): Promise<void> {
  await application.evaluate(({ dialog }, paths) => {
    const target = globalThis as NativeDialogGlobal;
    if (target.__chiliNativeTlsDialogProbe) throw new Error("A native TLS picker probe is already installed");
    const probe: NativeDialogProbe = { original: dialog.showOpenDialog, titles: [], unexpected: false };
    target.__chiliNativeTlsDialogProbe = probe;
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.OpenDialogOptions | undefined;
      const index = probe.titles.length;
      probe.titles.push(options?.title ?? "");
      if (index >= paths.length || options?.properties?.length !== 1 || options.properties[0] !== "openFile") {
        probe.unexpected = true;
        throw new Error("Unexpected native dialog during phone setup");
      }
      const path = paths[index];
      return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] };
    };
  }, selections);
  let probeResult: { titles: string[]; unexpected: boolean } | undefined;
  try {
    await page.getByTestId(button).click();
    await waitUntil("native TLS file selection completes", async () => application.evaluate((_electron, count) => {
      const probe = (globalThis as NativeDialogGlobal).__chiliNativeTlsDialogProbe;
      return Boolean(probe && (probe.unexpected || probe.titles.length >= count));
    }, selections.length));
    await waitUntil("native setup releases its main-process operation", async () => (await readDesktopRemoteState(page)).setup?.busy === false);
    await waitUntil("native setup operation settles in the real UI", async () => page.getByTestId("remote-setup-save").isEnabled());
  } finally {
    probeResult = await application.evaluate(({ dialog }) => {
      const target = globalThis as NativeDialogGlobal;
      const probe = target.__chiliNativeTlsDialogProbe;
      if (!probe) return undefined;
      dialog.showOpenDialog = probe.original;
      delete target.__chiliNativeTlsDialogProbe;
      return { titles: probe.titles, unexpected: probe.unexpected };
    });
  }
  assert.ok(probeResult);
  assert.equal(probeResult.unexpected, false, "Setup must invoke only its two native file pickers");
  assert.equal(probeResult.titles.length, selections.length);
  assert.match(probeResult.titles[0] ?? "", /certificate/iu);
  if (selections.length === 2) assert.match(probeResult.titles[1] ?? "", /private key/iu);
}

async function configureThroughUi(application: ElectronApplication, page: Page, profileDirectory: string): Promise<string> {
  await page.getByTestId("remote-setup-address").selectOption(remoteBindAddress);
  await page.getByTestId("remote-setup-port").fill(String(remotePort));
  const initial = await readDesktopRemoteState(page);
  assert.equal(initial.setup?.source, "none", "Setup must start without HTTPS environment configuration");
  assert.equal(initial.setup.hasTlsFiles, false);
  assert.equal(initial.enabled, false);
  assert.equal(await page.getByTestId("remote-enable").isDisabled(), true);

  await chooseTlsThroughUi(application, page, "remote-setup-save", [null]);
  const cancelled = await readDesktopRemoteState(page);
  assert.equal(cancelled.setup?.source, "none");
  assert.equal(cancelled.setup.hasTlsFiles, false);
  assert.equal(cancelled.setup.error, undefined, "Cancelling a native picker is not a configuration error");
  assert.equal(await page.getByTestId("remote-enable").isDisabled(), true);
  assert.equal(await page.getByTestId("remote-setup-clear").count(), 0);
  await assert.rejects(stat(join(profileDirectory, "remote-control-settings.json")), { code: "ENOENT" });

  await chooseTlsThroughUi(application, page, "remote-setup-save", [certificate.certificate, certificate.key]);
  await page.getByTestId("remote-setup-replace-tls").waitFor();
  await waitUntil("native setup makes Enable available", async () => page.getByTestId("remote-enable").isEnabled());
  const configured = await readDesktopRemoteState(page);
  assert.equal(configured.setup?.source, "saved");
  assert.equal(configured.setup.bindAddress, remoteBindAddress);
  assert.equal(configured.setup.port, remotePort);
  assert.equal(configured.enabled, false, "Saving native setup must not start HTTPS");
  assert.equal(await page.getByTestId("remote-status").count(), 0);
  await assertNoTlsMaterialInRenderer(page, configured);
  const saved = await assertPersistedSetup(profileDirectory);

  // Select a certificate but cancel the private key: neither files nor the new
  // draft port may partially replace the already working saved configuration.
  const cancelledPort = remotePort === 65_535 ? remotePort - 1 : remotePort + 1;
  await page.getByTestId("remote-setup-port").fill(String(cancelledPort));
  await chooseTlsThroughUi(application, page, "remote-setup-replace-tls", [certificate.certificate, null]);
  assert.equal(await assertPersistedSetup(profileDirectory), saved);
  const retained = await readDesktopRemoteState(page);
  assert.equal(retained.setup?.port, remotePort);
  assert.equal(retained.setup.error, undefined);
  assert.equal(retained.enabled, false);
  assert.equal(await page.getByTestId("remote-setup-port").inputValue(), String(cancelledPort), "Cancellation retains the unsaved form draft");
  await page.getByTestId("remote-setup-discard").click();
  await waitUntil("discarded setup edits restore Enable", async () => page.getByTestId("remote-enable").isEnabled());
  assert.equal(await page.getByTestId("remote-setup-port").inputValue(), String(remotePort));
  return saved;
}

async function assertNativeSetupModal(application: ElectronApplication, page: Page): Promise<unknown[]> {
  const originalSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Desktop window is unavailable");
    return window.getContentSize();
  });
  const results: unknown[] = [];
  const dialog = page.getByRole("dialog", { name: "Phone control", exact: true });
  const close = page.getByRole("button", { name: "Close phone control", exact: true });
  const focusableSelector = "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex='0']";
  try {
    for (const width of [1440, 820, 390]) {
      const actualSize = await application.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Desktop window is unavailable");
        window.setContentSize(size.width, size.height, false);
        return window.getContentSize();
      }, { width, height: 820 });
      assert.deepEqual(actualSize, [width, 820]);
      await page.waitForFunction((expected) => innerWidth === expected && innerHeight === 820, width);
      const metrics = await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const scroller = element.querySelector<HTMLElement>(".remote-panel-scroll");
        if (!scroller) throw new Error("Phone dialog scroll container is unavailable");
        return {
          width: innerWidth, height: innerHeight,
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
          backgroundInert: document.querySelector<HTMLElement>(".app-shell")?.inert,
        };
      });
      assert.ok(metrics.documentWidth <= width + 1 && metrics.bodyWidth <= width + 1, `Desktop horizontal overflow: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.left >= 0 && metrics.right <= width + 1 && metrics.top >= 0 && metrics.bottom <= 821, `Phone dialog exceeds its native window: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `Phone dialog horizontal overflow: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.backgroundInert, true);
      await page.screenshot({ path: join(artifacts, `desktop-phone-setup-${width}.png`) });

      await close.focus();
      const focusableCount = await dialog.evaluate((element, selector) => Array.from(element.querySelectorAll<HTMLElement>(selector)).filter((node) => node.getClientRects().length > 0).length, focusableSelector);
      assert.ok(focusableCount > 2);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await dialog.evaluate((element, selector) => {
        const controls = Array.from(element.querySelectorAll<HTMLElement>(selector)).filter((node) => node.getClientRects().length > 0);
        return document.activeElement === controls.at(-1);
      }, focusableSelector), true, "Shift+Tab wraps from the first control to the last");
      await page.keyboard.press("Tab");
      assert.equal(await close.evaluate((element) => element === document.activeElement), true, "Tab wraps back to the first control");
      for (let index = 0; index < focusableCount + 1; index += 1) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, "Tab focus stays inside Phone control");
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.getByTestId("remote-open").evaluate((element) => element === document.activeElement), true, "Escape returns keyboard focus to the Phone trigger");
      assert.equal(await page.locator(".app-shell").evaluate((element) => (element as HTMLElement).inert), false);
      await page.getByTestId("remote-open").click();
      await dialog.waitFor();
      assert.equal(await close.evaluate((element) => element === document.activeElement), true, "Opening Phone control focuses its close button");
      results.push({ ...metrics, keyboardTrap: true, escapeCloses: true, triggerFocusRestored: true, screenshot: `desktop-phone-setup-${width}.png` });
    }
  } finally {
    await application.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Desktop window is unavailable");
      window.setContentSize(size[0]!, size[1]!, false);
    }, originalSize);
    await page.waitForFunction((size) => innerWidth === size[0] && innerHeight === size[1], originalSize);
  }
  await waitUntil("Phone setup remains ready after native-window checks", async () => page.getByTestId("remote-enable").isEnabled());
  return results;
}

async function assertPersistedSetup(profileDirectory: string): Promise<string> {
  const path = join(profileDirectory, "remote-control-settings.json");
  const text = await readFile(path, "utf8");
  const saved = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved).sort(), ["version", "bindAddress", "port", "tlsCertPath", "tlsKeyPath"].sort(), "Only native connection settings may persist");
  assert.equal(saved.version, 1);
  assert.equal(saved.bindAddress, remoteBindAddress);
  assert.equal(saved.port, remotePort);
  assert.equal(saved.tlsCertPath === certificate.certificate, true, "Only the native certificate selection may persist");
  assert.equal(saved.tlsKeyPath === certificate.key, true, "Only the native private key selection may persist");
  assert.equal(text.includes("-----BEGIN"), false, "PEM contents must not enter setup persistence");
  assert.equal((await stat(path)).mode & 0o777, 0o600, "Saved setup must be private to its owner");
  return text;
}

async function assertNoTlsMaterialInRenderer(page: Page, state: RemoteDesktopState): Promise<void> {
  const exposed = `${JSON.stringify(state)}\n${await page.content()}`;
  for (const value of [certificate.certificate, certificate.key, "tlsCertPath", "tlsKeyPath", "-----BEGIN PRIVATE KEY-----", "-----BEGIN CERTIFICATE-----"]) {
    assert.equal(exposed.includes(value), false, "TLS paths and contents must remain outside renderer state and markup");
  }
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

async function pairThroughUi(local: Page, phone: Page, label = "Firefox real browser E2E"): Promise<void> {
  await local.getByTestId("remote-pairing-create").click();
  const code = local.getByTestId("remote-code");
  await code.waitFor();
  await phone.getByTestId("pairing-code").fill((await code.innerText()).trim());
  const deviceName = phone.getByTestId("device-label");
  if (await deviceName.count()) await deviceName.fill(label);
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
  remoteOrderingFirst: Promise<{ ok: boolean; code?: string; result?: unknown }>;
  remoteOrderingSecond: Promise<{ ok: boolean; code?: string; result?: unknown }>;
}

interface DesktopOrderingWindow extends Window {
  chiliDesktop: import("../src/shared/contracts.js").ChiliDesktopApi;
  remoteOrderingLocalStop: Promise<{ ok: boolean; code?: string; result?: unknown }>;
}

interface MainMembershipProbe {
  originalFetch: typeof globalThis.fetch;
  armed: boolean;
  inFlightReads: number;
  completedReads: number;
  held: boolean;
  release?: () => void;
  operations: string[];
}

type ProbedMainGlobal = typeof globalThis & { __chiliMembershipProbe?: MainMembershipProbe };

/**
 * Exercise the shipped React App, not a protocol-only client fixture. Only real
 * encrypted terminal responses are discarded, after normal HTTPS validation.
 */
async function proveStickyUnknownOutcomeUi(context: BrowserContext, local: Page, origin: string): Promise<unknown> {
  process.stdout.write("[remote-e2e] Production phone UI preserves unknown outcomes through reconnect and successful operations\n");
  const page = await context.newPage();
  const label = "Unknown outcome UI E2E";
  const title = "Phone Alpha real runtime";
  const lostSend = "page Queue result lost; inspect before retry";
  const successfulSend = "page success must not clear prior unknown";
  const concurrentSend = "[slow] page concurrent Queue and Stop results lost";
  const revokedSend = "page Queue result lost before desktop revokes device";
  const droppedSendTexts = new Set([lostSend, concurrentSend, revokedSend]);
  let pairing: PairingGrant | undefined;
  let dropStopResults = false;
  let completedSnapshotReads = 0;
  const targetIds = new Set<string>();
  const observedRequests = new Map<string, { operation: string; text?: string; sequence: number; transmissions: number }>();
  const droppedResults: Array<{ operation: string; requestId: string }> = [];
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/pairing/poll", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { status: string; grant?: PairingGrant };
    if (body.status === "approved" && body.grant) pairing = body.grant;
    await route.fulfill({ response });
  });
  await page.route("**/api/control/send", async (route) => {
    assert.ok(pairing, "UI pairing must finish before encrypted control requests");
    const body = route.request().postDataJSON() as { envelope: unknown };
    const frame = openRelayEnvelope<RemoteControlFrame>(pairing.channel, decodeWireEnvelope(body.envelope));
    if (frame.type === "request") {
      const previous = observedRequests.get(frame.requestId);
      observedRequests.set(frame.requestId, {
        operation: frame.operation,
        sequence: frame.sequence,
        ...(frame.operation === "session.send" ? { text: frame.payload.text } : {}),
        transmissions: (previous?.transmissions ?? 0) + 1,
      });
      if ((frame.operation === "session.send" && droppedSendTexts.has(frame.payload.text))
        || (frame.operation === "session.stop" && dropStopResults)) targetIds.add(frame.requestId);
    }
    await route.continue();
  });
  await page.route("**/api/control/poll", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { envelopes?: unknown[] };
    if (!pairing || !Array.isArray(body.envelopes)) { await route.fulfill({ response }); return; }
    const envelopes = body.envelopes.filter((wire) => {
      const frame = openRelayEnvelope<RemoteControlFrame>(pairing!.channel, decodeWireEnvelope(wire));
      if (frame.type !== "result") return true;
      const request = observedRequests.get(frame.requestId);
      if (targetIds.has(frame.requestId)) {
        droppedResults.push({ operation: request?.operation ?? "unknown", requestId: frame.requestId });
        return false;
      }
      if (request?.operation === "session.snapshot") completedSnapshotReads += 1;
      return true;
    });
    await route.fulfill({ response, json: { ...body, envelopes } });
  });
  const unknown = page.getByTestId("outcome-unknown");
  const unknownItems = unknown.locator('[data-testid^="unknown-outcome-"]');
  const confirmations = unknown.getByRole("button", { name: /已核对，清除此提醒/u });
  const assertOneWarning = async (message: string): Promise<void> => {
    await unknown.waitFor({ state: "visible" });
    assert.equal(await unknownItems.count(), 1, message);
    const content = await unknown.innerText();
    assert.match(content, /结果未知/u, message);
    assert.ok(content.includes("Queue") && content.includes(title) && content.includes(lostSend), message);
  };
  try {
    await page.goto(origin);
    await pairThroughUi(local, page, label);
    await page.getByTestId("task-list").getByText(title, { exact: true }).click();
    await page.getByTestId("message-input").fill(lostSend);
    await page.getByTestId("queue-send").click();
    await waitUntil("production UI send reached real runtime exactly once", () => fixture.requests.filter((request) => request.text === lostSend).length === 1);
    await waitUntil("real production UI send result discarded", () => droppedResults.length === 1);
    // Use the production timeout. No test-only client or shortened timer stands
    // in for App.tsx's catch/state/notification behavior.
    await assertOneWarning("The timed-out Queue must create a persistent, identified warning");
    assert.equal(await page.getByTestId("message-input").inputValue(), "", "An unknown command must not leave a draft ready for accidental resend");
    await page.getByTestId("reconnect").click();
    await waitUntil("production UI reconnect succeeds", async () => /已安全连接/u.test(await page.getByTestId("connection-status").innerText()));
    await page.getByTestId("notice").getByText(/连接已恢复/u).waitFor();
    await assertOneWarning("Successful reconnect must not replace an unknown-command warning");
    const readsBeforeRefresh = completedSnapshotReads;
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await waitUntil("explicit refresh reads the real task again", () => completedSnapshotReads > readsBeforeRefresh);
    await waitUntil("recovered snapshot displays executed but unacknowledged text", async () => (await page.getByTestId("transcript").innerText()).includes(lostSend));
    await assertOneWarning("A successful snapshot cannot infer an unknown command's terminal result");
    await page.getByTestId("message-input").fill(successfulSend);
    await page.getByTestId("queue-send").click();
    await waitUntil("another production UI command succeeds", () => fixture.requests.filter((request) => request.text === successfulSend).length === 1);
    await page.getByTestId("notice").getByText(/Queue.*接受|Queue.*入队/u).waitFor();
    await assertOneWarning("A different successful Queue must not clear the prior unknown outcome");
    await page.getByTestId("stop-task").click();
    await page.getByTestId("notice").getByText(/Stop.*已/u).waitFor();
    await assertOneWarning("A successful Stop notification must not clear the prior unknown outcome");
    await page.screenshot({ path: join(artifacts, "mobile-unknown-after-success.png"), fullPage: true });
    await confirmations.click();
    await unknown.waitFor({ state: "detached" });

    process.stdout.write("[remote-e2e] Production UI retains concurrent Queue/Stop unknown outcomes independently\n");
    dropStopResults = true;
    await page.getByTestId("message-input").fill(concurrentSend);
    await page.getByTestId("queue-send").click();
    await waitUntil("concurrent lost-result Queue starts real runtime", () => fixture.requests.some((request) => request.text === concurrentSend));
    await page.getByTestId("stop-task").click();
    await waitUntil("concurrent lost-result Stop aborts real runtime", () => fixture.requests.some((request) => request.text === concurrentSend && request.aborted));
    await waitUntil("both concurrent terminal results discarded", () => droppedResults.length === 3);
    await waitUntil("production UI records both unknown commands", async () => await unknownItems.count() === 2);
    assert.match(await unknown.innerText(), /Queue/u);
    assert.match(await unknown.innerText(), /Stop/u);
    await page.getByTestId("reconnect").click();
    await waitUntil("concurrent-unknown UI reconnect succeeds", async () => /已安全连接/u.test(await page.getByTestId("connection-status").innerText()));
    await page.getByTestId("notice").getByText(/连接已恢复/u).waitFor();
    assert.equal(await unknownItems.count(), 2, "Resync must preserve both unresolved UI command records");
    await page.screenshot({ path: join(artifacts, "mobile-unknown-concurrent.png"), fullPage: true });
    await confirmations.first().click();
    await waitUntil("one explicit confirmation clears only its own warning", async () => await unknownItems.count() === 1);
    await confirmations.click();
    await unknown.waitFor({ state: "detached" });
    assert.equal(fixture.requests.filter((request) => request.text === lostSend).length, 1);
    assert.equal(fixture.requests.filter((request) => request.text === concurrentSend).length, 1);
    process.stdout.write("[remote-e2e] Production UI retains admitted command uncertainty after desktop revocation\n");
    const revocationStarted = Date.now();
    await page.getByTestId("message-input").fill(revokedSend);
    await page.getByTestId("queue-send").click();
    await waitUntil("revoke-target send reaches real runtime and loses only its result", () =>
      fixture.requests.filter((request) => request.text === revokedSend).length === 1 && droppedResults.length === 4);
    // A later admitted real App read proves the browser consumed this send's
    // encrypted ACK, rather than merely proving that the server generated it.
    await waitUntil("a later real request proves the lost-result send ACK was consumed", () => {
      const lost = [...observedRequests.values()].find((request) => request.text === revokedSend);
      return lost !== undefined && [...observedRequests.values()].some((request) => request.sequence > lost.sequence);
    }, 10_000);
    const millisecondsBeforeRevocation = Date.now() - revocationStarted;
    assert.ok(millisecondsBeforeRevocation < 12_000, "Revoke must occur before the production 15s result timeout");
    await local.locator(".remote-panel-device").filter({ hasText: label }).getByTestId("remote-revoke").click();
    await page.getByTestId("pairing-code").waitFor();
    await unknown.waitFor();
    assert.equal(await unknownItems.count(), 1, "Revocation must preserve the admitted command's unknown result");
    const revokedWarning = await unknown.innerText();
    assert.ok(revokedWarning.includes(revokedSend) && revokedWarning.includes(title) && revokedWarning.includes("Queue"));
    await page.screenshot({ path: join(artifacts, "mobile-unknown-after-revoke.png"), fullPage: true });
    await confirmations.click();
    await unknown.waitFor({ state: "detached" });
    return {
      productionReactPage: true,
      realTerminalResultsDiscarded: droppedResults.map((entry) => entry.operation),
      warningSurvivesSuccessfulReconnect: true,
      warningSurvivesSnapshotRead: true,
      warningSurvivesSuccessfulQueueAndStop: true,
      concurrentUnknownRecordsPreserved: 2,
      eachConfirmationClearsOnlyItsOwnRecord: true,
      admittedOutcomeSurvivesRevocationBeforeTimeout: true,
      millisecondsBeforeRevocation,
      executedSendCounts: { lostSend: 1, concurrentSend: 1, revokedSend: 1 },
    };
  } catch (error) {
    await Promise.allSettled([
      page.screenshot({ path: join(artifacts, "mobile-unknown-failure.png"), fullPage: true }),
      page.content().then((html) => writeFile(join(artifacts, "mobile-unknown-failure.html"), html)),
    ]);
    throw error;
  } finally {
    await page.close();
    const row = local.locator(".remote-panel-device").filter({ hasText: label });
    if (await row.count()) await row.getByTestId("remote-revoke").click();
  }
}

async function proveWireLoss(context: BrowserContext, local: Page, origin: string, application: ElectronApplication): Promise<unknown[]> {
  const page = await context.newPage();
  let pairing: PairingGrant | undefined;
  let mode: "none" | "ack" | "result" | "both" = "none";
  let targetText = "";
  let targetId = "";
  let targetSnapshot = false;
  const dropped: { type: string; requestId: string }[] = [];
  const requests: RemoteControlRequestFrame[] = [];
  const acknowledged = new Set<string>();
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
    if (!pairing || !Array.isArray(body.envelopes)) {
      await route.fulfill({ response }); return;
    }
    const envelopes = body.envelopes.filter((wire) => {
      const frame = openRelayEnvelope<RemoteControlFrame>(pairing!.channel, decodeWireEnvelope(wire));
      if (frame.type === "ack") acknowledged.add(frame.requestId);
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
    results.push(...await proveMutationMembershipOrdering(application, local, page, sessionId, requests, acknowledged));
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

async function proveMutationMembershipOrdering(
  application: ElectronApplication,
  local: Page,
  phone: Page,
  sessionId: string,
  requests: readonly RemoteControlRequestFrame[],
  acknowledged: ReadonlySet<string>,
): Promise<unknown[]> {
  process.stdout.write("[remote-e2e] Real runtime membership response delay preserves remote and local mutation ordering\n");
  const debuggerSession = await application.context().newCDPSession(local);
  let rendererPaused = false;
  const results: unknown[] = [];
  await debuggerSession.send("Debugger.enable");
  const pauseRenderer = async (): Promise<void> => {
    if (rendererPaused) return;
    const paused = new Promise<void>((resolve) => debuggerSession.once("Debugger.paused", () => resolve()));
    await debuggerSession.send("Debugger.pause");
    await paused;
    rendererPaused = true;
  };
  const resumeRenderer = async (): Promise<void> => {
    if (!rendererPaused) return;
    await debuggerSession.send("Debugger.resume");
    rendererPaused = false;
  };
  const probe = async () => application.evaluate(() => {
    const state = (globalThis as ProbedMainGlobal).__chiliMembershipProbe;
    if (!state) throw new Error("Missing runtime response-delay probe");
    return { held: state.held, inFlightReads: state.inFlightReads, completedReads: state.completedReads, operations: [...state.operations] };
  });
  const arm = async (): Promise<void> => {
    await pauseRenderer();
    await waitUntil("desktop background membership reads settle before injection", async () => (await probe()).inFlightReads === 0);
    await application.evaluate(() => {
      const state = (globalThis as ProbedMainGlobal).__chiliMembershipProbe!;
      state.completedReads = 0;
      state.operations = [];
      state.held = false;
      state.armed = true;
    });
  };
  const release = async (): Promise<void> => application.evaluate(() => {
    (globalThis as ProbedMainGlobal).__chiliMembershipProbe?.release?.();
  });
  const start = async (which: "first" | "second", operation: "session.send" | "session.stop", text = ""): Promise<void> => {
    await phone.evaluate(({ which, operation, id, text }) => {
      const target = window as unknown as BrowserFaultWindow;
      const result = (operation === "session.send"
        ? target.remoteFaultClient.request("session.send", { sessionId: id, text, mode: "queue" })
        : target.remoteFaultClient.request("session.stop", { sessionId: id }))
        .then((result) => ({ ok: true, result }), (error: unknown) => ({ ok: false,
          code: error instanceof Error && "code" in error ? String(error.code) : "unknown" }));
      if (which === "first") target.remoteOrderingFirst = result;
      else target.remoteOrderingSecond = result;
    }, { which, operation, id: sessionId, text });
  };
  await application.evaluate((_electron, id) => {
    const target = globalThis as ProbedMainGlobal;
    if (target.__chiliMembershipProbe) throw new Error("Runtime response-delay probe already installed");
    const state: MainMembershipProbe = { originalFetch: globalThis.fetch, armed: false, inFlightReads: 0,
      completedReads: 0, held: false, operations: [] };
    target.__chiliMembershipProbe = state;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      const membershipRead = loopback && method === "GET" && url.pathname === "/sessions";
      const operation = loopback && method === "POST" && url.pathname.startsWith(`/sessions/${encodeURIComponent(id)}/`)
        ? url.pathname.slice(url.pathname.lastIndexOf("/") + 1) : undefined;
      if (operation === "prompt_async" || operation === "interrupt") state.operations.push(operation);
      const shouldDelay = membershipRead && state.armed;
      if (shouldDelay) state.armed = false;
      if (membershipRead) state.inFlightReads += 1;
      try {
        // The real authenticated HTTP request completes. Never inspect or
        // change its headers, body, status, Response or credentials.
        const response = await state.originalFetch(input, init);
        if (membershipRead) state.completedReads += 1;
        if (shouldDelay) {
          state.held = true;
          await new Promise<void>((resolve) => { state.release = resolve; });
        }
        return response;
      } finally { if (membershipRead) state.inFlightReads -= 1; }
    }) as typeof fetch;
  }, sessionId);
  try {
    for (const direction of ["send_then_stop", "stop_then_send"] as const) {
      await arm();
      const text = `[slow] membership ordering ${direction}`;
      const startIndex = requests.length;
      await start("first", direction === "send_then_stop" ? "session.send" : "session.stop", text);
      await waitUntil("first real membership Response is held", async () => (await probe()).held);
      await start("second", direction === "send_then_stop" ? "session.stop" : "session.send", text);
      await waitUntil("second mutation receives real encrypted admission ACK", () => {
        const second = requests.slice(startIndex).filter((frame) => frame.operation === "session.send" || frame.operation === "session.stop")[1];
        return second !== undefined && acknowledged.has(second.requestId);
      });
      // Parallel membership implementations finish read two here; a correct
      // serial implementation may defer it. Either way the first stays held
      // long enough to expose the former actor-enrollment race.
      const deadline = Date.now() + 400;
      while (Date.now() < deadline && (await probe()).completedReads < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const beforeRelease = await probe();
      await release();
      const receipts = await phone.evaluate(async () => {
        const target = window as unknown as BrowserFaultWindow;
        return Promise.all([target.remoteOrderingFirst, target.remoteOrderingSecond]);
      });
      assert.ok(receipts.every((result) => result.ok), `${direction} receipts: ${JSON.stringify(receipts)}`);
      const expected = direction === "send_then_stop" ? ["prompt_async", "interrupt"] : ["interrupt", "prompt_async"];
      assert.deepEqual((await probe()).operations, expected, "Membership latency must not reorder actual runtime HTTP mutations");
      if (direction === "stop_then_send") {
        await waitUntil("new Send after old Stop remains running", () => fixture.requests.some((request) => request.text === text));
        assert.equal(fixture.requests.find((request) => request.text === text)?.aborted, false, "Delayed old Stop killed a newer Send");
      }
      const snapshot = await phone.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.snapshot", { sessionId: id }), sessionId);
      assert.ok(snapshot && typeof snapshot === "object");
      assert.deepEqual((await probe()).operations, expected, "No delayed first submit may appear after Stop completed");
      results.push({ membershipOrdering: direction, instrumentation: "Electron renderer paused; first real authenticated GET /sessions Response delivered late, unchanged",
        secondReadCompletedWhileFirstHeld: beforeRelease.completedReads >= 2, runtimeRequestOrder: expected });
      await phone.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.stop", { sessionId: id }), sessionId);
    }

    const crossSurfaceSend = "[slow] remote Send before local IPC Stop";
    await arm();
    await start("first", "session.send", crossSurfaceSend);
    await waitUntil("remote Send membership Response held before local Stop", async () => (await probe()).held);
    await resumeRenderer();
    // The idle UI intentionally has no Stop button. Invoke its real preload API
    // instead: this still crosses trusted Electron IPC into the same service.
    // Do not seed a busy holder here: Stop-current-turn intentionally drains
    // already accepted queued messages, which is a separate existing behavior.
    await local.evaluate((id) => {
      const target = window as unknown as DesktopOrderingWindow;
      target.remoteOrderingLocalStop = target.chiliDesktop.invoke({ type: "session.stop", sessionId: id })
        .then((result) => ({ ok: true, result }), (error: unknown) => ({ ok: false,
          code: error instanceof Error ? error.message : "unknown" }));
    }, sessionId);
    await pauseRenderer();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await release();
    const receipt = await phone.evaluate(async () => (window as unknown as BrowserFaultWindow).remoteOrderingFirst);
    assert.equal(receipt.ok, true);
    await resumeRenderer();
    const localReceipt = await local.evaluate(async () => (window as unknown as DesktopOrderingWindow).remoteOrderingLocalStop);
    assert.equal(localReceipt.ok, true);
    await phone.evaluate(async (id) => (window as unknown as BrowserFaultWindow).remoteFaultClient.request("session.snapshot", { sessionId: id }), sessionId);
    assert.deepEqual((await probe()).operations, ["prompt_async", "interrupt"], "A delayed remote first submit must not start after the later local IPC Stop");
    results.push({ membershipOrdering: "remote_send_then_local_stop", instrumentation: "one unchanged real runtime membership Response delayed; real desktop preload invoke/IPC, not an idle UI button",
      runtimeRequestOrder: ["prompt_async", "interrupt"] });
  } finally {
    await application.evaluate(() => {
      const target = globalThis as ProbedMainGlobal;
      const state = target.__chiliMembershipProbe;
      if (state) { state.release?.(); globalThis.fetch = state.originalFetch; delete target.__chiliMembershipProbe; }
    });
    await resumeRenderer();
    await debuggerSession.send("Debugger.disable");
    await debuggerSession.detach();
  }
  return results;
}
