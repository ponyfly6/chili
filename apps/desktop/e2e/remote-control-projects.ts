import { openPhoneSettings } from "./conversation-design.js";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ElectronApplication, Page, Route } from "playwright-core";
import type { ChiliDesktopApi, DesktopState } from "../src/shared/contracts.js";
import type { PairingGrant } from "../../../packages/remote-control/src/pairing-security.js";
import { runCommand, waitUntil, type ModelRequest } from "./remote-control-fixtures.js";

interface ProjectProbeWindow extends Window { chiliDesktop: ChiliDesktopApi }

interface ProjectScenarioOptions {
  application: ElectronApplication;
  desktop: Page;
  phone: Page;
  workspace: string;
  temporaryRoot: string;
  artifacts: string;
  requests: ModelRequest[];
  savedSetup: string;
  readSavedSetup(): Promise<string>;
  createTask(page: Page, title: string, text: string): Promise<void>;
  pair(local: Page, phone: Page, label?: string): Promise<void>;
}

/** UI-driven project selection and pairing; only the native folder picker is supplied by the test. */
export async function proveRemoteProjectIsolation(options: ProjectScenarioOptions): Promise<unknown> {
  const { application, desktop, phone, requests } = options;
  const titleA = "Phone project A background task";
  const titleB = "Phone project B independent task";
  const promptA = "[slow] project A survives phone scope changes";
  const promptB = "[slow] project B survives phone scope changes";
  const queuedB = "Only project B owns this phone queue";
  const projectBPath = join(options.temporaryRoot, "workspace-two");
  const grants: PairingGrant[] = [];
  const captureGrant = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    const body = await response.json() as { status: string; grant?: PairingGrant };
    if (body.status === "approved" && body.grant) grants.push(body.grant);
    await route.fulfill({ response });
  };
  await phone.route("**/api/pairing/poll", captureGrant);
  const stream = (text: string): ModelRequest => {
    const matches = requests.filter((request) => request.text === text);
    assert.equal(matches.length, 1, "Project switching must not start the same model turn twice");
    return matches[0]!;
  };
  const assertBothRunning = (): void => {
    assert.equal(stream(promptA).aborted, false, "Project A must remain running across project and phone authorization changes");
    assert.equal(stream(promptB).aborted, false, "Project B must remain running across project and phone authorization changes");
  };
  try {
    process.stdout.write("[remote-e2e] Two running projects keep independent phone authorization and queues\n");
    await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await options.createTask(desktop, titleA, promptA);
    await waitUntil("project A model stream starts", () => requests.some((request) => request.text === promptA));
    const ownerA = await taskOwner(desktop, titleA);
    await openPhoneSettings(desktop);
    await options.pair(desktop, phone, "Project A scope E2E");
    await phone.getByTestId("task-list").getByText(titleA, { exact: true }).click();
    await waitUntil("project A phone snapshot", async () => (await phone.getByTestId("transcript").innerText()).includes(promptA));
    const grantA = grants[0];
    assert.ok(grantA, "Observe the actual grant delivered after desktop confirmation");

    await mkdir(projectBPath, { recursive: true });
    await runCommand("/usr/bin/git", ["init", "--quiet", projectBPath]);
    await application.evaluate(({ dialog }, selectedWorkspace) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        return { canceled: false, filePaths: [selectedWorkspace] };
      };
    }, projectBPath);
    await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await desktop.getByRole("button", { name: "Add project", exact: true }).click();
    await waitForProject(desktop, basename(projectBPath));
    await assertPhoneLostScope(phone);
    assert.equal(stream(promptA).aborted, false, "Adding project B must not stop the already paired project A turn");
    await options.createTask(desktop, titleB, promptB);
    await waitUntil("project B model stream starts", () => requests.some((request) => request.text === promptB));
    const ownerB = await taskOwner(desktop, titleB);
    assert.notEqual(ownerA.projectId, ownerB.projectId);
    assertBothRunning();

    await openPhoneSettings(desktop);
    await enableAfterProjectSwitch(desktop, phone, options);
    const staleAOnB = await rejectStaleGrant(phone, grantA, [ownerA.sessionId, ownerB.sessionId], "A grant while B is active");
    assertBothRunning();
    assert.equal((await desktopState(desktop)).queuedBySession[ownerB.sessionId] ?? 0, 0);
    await options.pair(desktop, phone, "Project B scope E2E");
    const grantB = grants[1];
    assert.ok(grantB);
    assert.notEqual(grantA.hostId, grantB.hostId, "Enabling remote for another project starts a new host epoch");
    await assertPhoneTaskScope(phone, titleB, [titleA, "Phone Alpha real runtime"]);
    await phone.getByTestId("task-list").getByText(titleB, { exact: true }).click();
    await waitUntil("project B phone snapshot", async () => (await phone.getByTestId("transcript").innerText()).includes(promptB));
    assert.equal((await phone.getByTestId("transcript").innerText()).includes(promptA), false);
    await phone.getByTestId("message-input").fill(queuedB);
    await phone.getByTestId("queue-send").click();
    await waitUntil("only project B accepts its phone queue", async () => {
      const state = await desktopState(desktop);
      return state.projectId === ownerB.projectId && state.queuedBySession[ownerB.sessionId] === 1;
    });
    assert.equal(requests.filter((request) => request.text === queuedB).length, 0, "A Queue cannot preempt B's running turn");
    await phone.screenshot({ path: join(options.artifacts, "mobile-project-b-only.png"), fullPage: true });

    await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await desktop.getByRole("button", { name: `Open project ${basename(options.workspace)}`, exact: true }).click();
    await waitForProject(desktop, basename(options.workspace));
    await assertPhoneLostScope(phone);
    assertBothRunning();
    await openPhoneSettings(desktop);
    await enableAfterProjectSwitch(desktop, phone, options);
    const staleBOnA = await rejectStaleGrant(phone, grantB, [ownerA.sessionId, ownerB.sessionId], "B grant while A is active");
    const staleAOnA = await rejectStaleGrant(phone, grantA, [ownerA.sessionId, ownerB.sessionId], "original A grant after returning to A");
    assertBothRunning();
    assert.equal((await desktopState(desktop)).queuedBySession[ownerA.sessionId] ?? 0, 0);
    await options.pair(desktop, phone, "Project A fresh scope E2E");
    const newGrantA = grants[2];
    assert.ok(newGrantA);
    assert.notEqual(newGrantA.hostId, grantA.hostId, "Returning to A cannot revive its original host epoch");
    await assertPhoneTaskScope(phone, titleA, [titleB]);
    await phone.getByTestId("task-list").getByText(titleA, { exact: true }).click();
    await waitUntil("restored A phone snapshot", async () => (await phone.getByTestId("transcript").innerText()).includes(promptA));
    await phone.getByTestId("stop-task").click();
    await waitUntil("fresh A phone grant stops only A", () => stream(promptA).aborted);
    assert.equal(stream(promptB).aborted, false, "A's valid Stop must not interrupt the background B project");
    await phone.screenshot({ path: join(options.artifacts, "mobile-project-a-repaired.png"), fullPage: true });

    // Changing the phone's project revokes its scope and cancels that scope's
    // pending inputs, while B's already running turn remains independent.
    await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await desktop.getByRole("button", { name: `Open project ${basename(projectBPath)}`, exact: true }).click();
    await waitForProject(desktop, basename(projectBPath));
    assert.equal((await desktopState(desktop)).queuedBySession[ownerB.sessionId] ?? 0, 0);
    assert.equal(requests.filter((request) => request.text === queuedB).length, 0, "Revoked phone inputs must not run later in the background project");
    await desktop.getByRole("button", { name: "Stop current turn", exact: true }).click();
    await waitUntil("B's own stop affects only its running turn", () => stream(promptB).aborted);
    assert.equal(requests.filter((request) => request.text === queuedB).length, 0);
    await desktop.getByRole("button", { name: `Open project ${basename(options.workspace)}`, exact: true }).click();
    await waitForProject(desktop, basename(options.workspace));
    await openPhoneSettings(desktop);
    await desktop.getByTestId("remote-enable").waitFor();
    assert.equal(await options.readSavedSetup(), options.savedSetup, "Project selection preserves HTTPS settings bytes");
    assert.equal(requests.some((request) => request.text.startsWith("Rejected stale grant")), false);
    await desktop.screenshot({ path: join(options.artifacts, "desktop-projects-independent.png"), fullPage: true });
    return {
      projects: 2,
      pairingAndProjectSelectionThroughProductionUi: true,
      chooserAutomation: "only native folder-dialog result; real Add project and Open project buttons",
      addingAndReturningPreserveBothRunningTurns: true,
      selectedProjectOnlyInPhoneListAndSnapshot: true,
      newPairingRequiredForEachProjectSwitch: true,
      originalAuthorizationNotRevivedOnReturn: true,
      freshPhoneStopOnlyAffectsItsOwnProject: true,
      projectBPendingPhoneInputCancelledOnScopeRevocation: true,
      staleGrantRequests: [...staleAOnB, ...staleBOnA, ...staleAOnA],
      staleGrantInstrumentation: "fresh valid encrypted Queue/Steer/Stop frames sent by browser fetch using previously observed real grants; normal TLS verification",
      physicalDeviceTested: false,
    };
  } finally {
    await phone.unroute("**/api/pairing/poll", captureGrant);
  }
}

async function desktopState(page: Page): Promise<DesktopState> {
  return page.evaluate(() => (window as unknown as ProjectProbeWindow).chiliDesktop.invoke({ type: "app.state" }));
}

async function taskOwner(page: Page, title: string): Promise<{ projectId: string; sessionId: string }> {
  const state = await desktopState(page);
  assert.ok(state.projectId);
  const sessions = await page.evaluate(() => (window as unknown as ProjectProbeWindow).chiliDesktop.invoke({ type: "sessions.list", status: "active" }));
  const session = sessions.find((entry) => entry.title === title);
  assert.ok(session);
  return { projectId: state.projectId, sessionId: String(session.id) };
}

async function waitForProject(page: Page, name: string): Promise<void> {
  await waitUntil(`${name} selected and healthy`, async () => (
    await page.getByRole("button", { name: `Open project ${name}`, exact: true }).getAttribute("aria-current") === "true"
    && (await desktopState(page)).sidecar.phase === "healthy"
  ));
}

async function assertPhoneLostScope(phone: Page): Promise<void> {
  await waitUntil("project selection disconnects the previous phone grant", async () =>
    !/已安全连接/u.test(await phone.getByTestId("connection-status").innerText()));
}

async function enableAfterProjectSwitch(local: Page, phone: Page, options: ProjectScenarioOptions): Promise<void> {
  await local.getByTestId("remote-enable").waitFor();
  assert.equal(await local.getByTestId("remote-status").count(), 0, "Selecting another project disables the previous phone endpoint");
  assert.equal(await options.readSavedSetup(), options.savedSetup);
  await local.getByTestId("remote-enable").click();
  await local.getByTestId("remote-status").waitFor();
  await phone.getByTestId("reconnect").click();
  await phone.getByTestId("pairing-code").waitFor();
  assert.equal(await phone.getByTestId("task-list").count(), 0, "Re-enabling remote cannot revive a previous grant or task list");
}

async function assertPhoneTaskScope(phone: Page, included: string, excluded: string[]): Promise<void> {
  const list = phone.getByTestId("task-list");
  await list.getByText(included, { exact: true }).waitFor();
  for (const title of excluded) assert.equal(await list.getByText(title, { exact: true }).count(), 0, "Other projects must not enter the phone task list");
}

async function rejectStaleGrant(phone: Page, grant: PairingGrant, sessionIds: string[], stage: string): Promise<unknown[]> {
  const results = await phone.evaluate(async ({ pairing, targets, label }) => {
    const modulePath = "/assets/e2e-browser-client.js";
    const { browserRandomIdentifier, encodeWireEnvelope, parseRemoteControlFrame, requiredCapabilityForOperation, sealBrowserRelayEnvelope } =
      await import(modulePath) as typeof import("../../../packages/remote-control/src/browser.js");
    const results: Array<{ stage: string; target: number; operation: string; status: number; code: string | undefined }> = [];
    for (const [target, sessionId] of targets.entries()) {
      for (const operation of ["queue", "steer", "stop"] as const) {
        const method = operation === "stop" ? "session.stop" : "session.send";
        const frame = parseRemoteControlFrame({ version: 1, type: "request", hostId: pairing.hostId,
          sessionId: browserRandomIdentifier("session"), deviceId: pairing.deviceId, credential: pairing.credential,
          sequence: 1, requestId: browserRandomIdentifier("request"), operation: method,
          capability: requiredCapabilityForOperation(method),
          payload: operation === "stop" ? { sessionId } : { sessionId, text: `Rejected stale grant ${label} ${target} ${operation}`, mode: operation },
        });
        const envelope = encodeWireEnvelope(await sealBrowserRelayEnvelope(pairing.channel, "device_to_host", frame));
        const response = await fetch("/api/control/send", { method: "POST", headers: {
          "Content-Type": "application/json", Authorization: `Bearer ${pairing.credential}`,
        }, body: JSON.stringify({ deviceId: pairing.deviceId, routeId: pairing.channel.routeId, envelope }) });
        const body = await response.json() as { error?: { code?: string } };
        results.push({ stage: label, target, operation, status: response.status, code: body.error?.code });
      }
    }
    return results;
  }, { pairing: grant, targets: sessionIds, label: stage });
  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.status, 401, `${stage}: stale ${result.operation} must fail authentication before admission`);
    assert.equal(result.code, "authentication_failed");
  }
  return results;
}
