#!/usr/bin/env node
import { openAdvancedTaskDialog, openDesktopSettings, assertConversationDesign } from "./conversation-design.js";
import type { ChiliDesktopApi } from "../src/shared/contracts.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { assertDesktopAppearance, assertDesktopAppearanceRestored } from "./appearance.js";
import { assertDelegatedConversation } from "./delegated-conversation.js";
import { assertResponsiveNavigation } from "./responsive-navigation.js";
import { assertTimelineFollowStream, TIMELINE_FOLLOW_PROMPT, TimelineFollowFixture } from "./timeline-follow-stream.js";
import { assertTimelineNavigation } from "./timeline-navigation.js";
import { assertDesktopResults, isExpectedResultPreviewDiagnostic } from "./results-preview.js";
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright-core";

const ACTION_TIMEOUT_MS = 30_000;
const APP_CLOSE_TIMEOUT_MS = 20_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const LOCAL_API_KEY = "chili-electron-e2e-local-fixture-key";
const CONVERSATION_TITLE = "Conversation recovery E2E";
const CONVERSATION_PROMPT = "desktop conversation fixture";
const REVIEW_TITLE = "Automatic review and input E2E";
const RENAMED_REVIEW_TITLE = "Renamed review E2E";
const SLOW_TITLE = "Steer and stop E2E";
const SLOW_STEER_PROMPT = "electron slow steer fixture";
const STEER_REPLACEMENT = "electron steer replacement";
const RECOVERY_PROMPT = "electron recovery follow-up";
const PROJECT_B_TITLE = "Independent project B task";
const PROJECT_B_PROMPT = "work in the second project independently";
const PROJECT_A_DRAFT = "unsent draft in project A";
const PROJECT_B_DRAFT = "unsent draft in project B";
const CLOSE_ABORT_CANARY = process.env.CHILI_E2E_CLOSE_ABORT_CANARY === "1";
const ENVIRONMENT_CANARY = process.env.CHILI_E2E_ENV_CANARY_ONLY === "1";
const STDERR_CANARY = process.env.CHILI_E2E_STDERR_CANARY_ONLY === "1";

assert.deepEqual(unexpectedElectronStderr(
  "Debugger ending on ws://127.0.0.1:54321/01234567-89ab-cdef-0123-456789abcdef\n"
  + "For help, see: https://nodejs.org/learn/getting-started/debugging\n",
), []);
assert.deepEqual(unexpectedElectronStderr("Desktop product failure\n"), ["Desktop product failure"]);
const slowRequest = {
  messages: [{ role: "user", content: SLOW_STEER_PROMPT }],
};
assert.equal(providerPromptText(slowRequest), SLOW_STEER_PROMPT);
assert.equal(providerPromptText({
  messages: [
    ...slowRequest.messages,
    { role: "assistant", content: `Fixture stream opened: ${SLOW_STEER_PROMPT}` },
    { role: "user", content: STEER_REPLACEMENT },
  ],
}), STEER_REPLACEMENT);
assert.equal(providerPromptText({
  messages: [
    ...slowRequest.messages,
    { role: "assistant", content: `Fixture stream opened: ${SLOW_STEER_PROMPT}` },
  ],
}), SLOW_STEER_PROMPT);
assert.throws(() => providerPromptText({
  messages: [{ role: "system", content: SLOW_STEER_PROMPT }],
}), /omitted a user message/u);
const slowResponsesRequest = {
  model: "deepseek-v4-pro",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: SLOW_STEER_PROMPT }] }],
};
assert.equal(providerPromptText(slowResponsesRequest), SLOW_STEER_PROMPT);
assert.equal(providerPromptText({
  input: [
    ...slowResponsesRequest.input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: SLOW_STEER_PROMPT }] },
    { role: "user", content: [{ type: "input_text", text: STEER_REPLACEMENT }] },
    { type: "function_call_output", call_id: "call_fixture", output: SLOW_STEER_PROMPT },
  ],
}), STEER_REPLACEMENT);
assert.equal(providerPromptText({
  input: [
    ...slowResponsesRequest.input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: STEER_REPLACEMENT }] },
  ],
}), SLOW_STEER_PROMPT);
assert.equal(providerPromptText({
  input: [{ role: "user", content: [
    { type: "input_text", text: "first block" },
    { type: "input_image", image_url: "data:image/png;base64,fixture" },
    { type: "input_text", text: "second block" },
  ] }],
}), "first block\nsecond block");
assert.throws(() => providerPromptText({
  input: [{ role: "system", content: [{ type: "input_text", text: SLOW_STEER_PROMPT }] }],
}), /omitted a user message/u);

if (process.env.CHILI_E2E_MATCHER_CANARY_ONLY === "1") {
  process.stdout.write("electron E2E provider matcher canary passed\n");
  process.exit(0);
}

if (ENVIRONMENT_CANARY) {
  assertDesktopLaunchEnvironmentIsolation();
  process.stdout.write("electron E2E launch environment canary passed\n");
  process.exit(0);
}

class BoundedLog {
  private value = "";
  private overflowed = false;

  constructor(private readonly maximum: number) {}

  append(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const remaining = Math.max(0, this.maximum - this.value.length);
    if (text.length > remaining) this.overflowed = true;
    if (remaining > 0) this.value = `${this.value}${text.slice(0, remaining)}`;
  }

  text(): string {
    return this.value;
  }

  isTruncated(): boolean {
    return this.overflowed;
  }
}

if (STDERR_CANARY) {
  assertStartupElectronStderrClassification();
  process.stdout.write("electron E2E startup stderr canary passed\n");
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("The real Electron desktop E2E currently requires macOS");
}

const configuredRepositoryRoot = process.env.CHILI_E2E_REPOSITORY_ROOT?.trim();
if (!configuredRepositoryRoot || !isAbsolute(configuredRepositoryRoot)) {
  throw new Error("CHILI_E2E_REPOSITORY_ROOT must be an absolute path supplied by the Bun launcher");
}
const repositoryRoot = resolve(configuredRepositoryRoot);
const configuredBunPath = process.env.CHILI_E2E_BUN_PATH?.trim();
if (!configuredBunPath || !isAbsolute(configuredBunPath)) {
  throw new Error("CHILI_E2E_BUN_PATH must be an absolute path supplied by the Bun launcher");
}
const bunPath = resolve(configuredBunPath);
await access(bunPath, fsConstants.X_OK);
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const temporaryRoot = await mkdtemp(join(tmpdir(), "chili-electron-e2e-"));
const workspace = join(temporaryRoot, "workspace");
const userData = join(temporaryRoot, "user-data");
const chiliHome = join(temporaryRoot, "chili-home");
const electronTemp = join(temporaryRoot, "tmp");
const artifacts = join(temporaryRoot, "artifacts");
const databasePath = join(workspace, ".chili", "chili.sqlite");
const provider = await startFixtureProvider();
let currentLaunch: DesktopLaunch | undefined;
let completed = false;
let failure: unknown;

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(chiliHome, { recursive: true }),
    mkdir(electronTemp, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
  ]);
  await writeFile(join(workspace, "README.md"), "# Chili Electron E2E workspace\n", "utf8");
  await runChecked(["/usr/bin/git", "init", "--quiet", workspace], repositoryRoot, 10_000);

  if (process.env.CHILI_DESKTOP_E2E_SKIP_BUILD !== "1") {
    logStep("building the real Electron application and compiled sidecar");
    await runChecked(["bun", "run", "desktop:build"], repositoryRoot, 300_000);
  }
  await resolveElectronExecutable();

  if (CLOSE_ABORT_CANARY) {
    logStep("close/abort canary: inject one recoverable close failure during an in-flight input");
    currentLaunch = await launchDesktop("close-abort-canary", "deepseek");
    await createSlowProviderTaskThroughUi(currentLaunch.page);
    await proveCloseAbortRetryInvariant(currentLaunch);
    currentLaunch = undefined;
  } else {
    logStep("launch 1/4: create a conversation through the New Task dialog");
    currentLaunch = await launchDesktop("conversation-create", "fake");
    await assertConversationDesign(currentLaunch.page, artifacts);
    await assertDesktopResults(currentLaunch.page, workspace, artifacts, currentLaunch.app);
    await createConversationThroughUi(currentLaunch.page);
    await assertConversationAndSettings(currentLaunch.page);
    await assertDesktopAppearance(currentLaunch.page, artifacts);
    await closeDesktop(currentLaunch);
    currentLaunch = undefined;

    logStep("launch 2/4: reload the conversation and exercise automatic review, input, rename, search, and archive");
    currentLaunch = await launchDesktop("conversation-recovery", "fake");
    await assertDesktopAppearanceRestored(currentLaunch.page);
    await waitForTaskTitle(currentLaunch.page, CONVERSATION_TITLE);
    await assertConversationAndSettings(currentLaunch.page);
    await createReviewTaskThroughUi(currentLaunch.page);
    await assertAutomaticReviewThroughUi(currentLaunch.page);
    await resolveUserInputThroughUi(currentLaunch.page);
    await renameSearchAndArchiveThroughUi(currentLaunch.page);
    await assertDelegatedConversation(currentLaunch.page, workspace, artifacts);
    await closeDesktop(currentLaunch);
    currentLaunch = undefined;

    logStep("launch 3/4: persist an in-flight streamed input for explicit recovery");
    currentLaunch = await launchDesktop("stream-controls", "deepseek");
    const interruptedInputId = await createSlowProviderTaskThroughUi(currentLaunch.page);
    await assertProgressDismissalDuringWork(currentLaunch.page);
    await assertMultipleProjects(currentLaunch);
    await closeDesktop(currentLaunch);
    currentLaunch = undefined;
    await waitForProviderAbort(SLOW_STEER_PROMPT, 1);

    logStep("launch 4/4: explicitly recover the input, then exercise steer/stop and native widths");
    currentLaunch = await launchDesktop("stream-recovery", "deepseek");
    await recoverSlowInputThroughUi(currentLaunch.page, interruptedInputId);
    await steerSlowTurnThroughUi(currentLaunch.page);
    await submitSlowInputThroughUi(currentLaunch.page);
    await stopSlowTurnThroughUi(currentLaunch.page);
    await resumeStoppedTaskThroughUi(currentLaunch.page);
    await stopSlowTurnThroughUi(currentLaunch.page);
    await sendRecoveryFollowUpThroughUi(currentLaunch.page);
    await assertProjectsRestored(currentLaunch.page);
    await assertNativeResponsiveWidths(currentLaunch);
    await assertTimelineFollowStream(currentLaunch.page, provider.timeline, artifacts);
    await assertTimelineNavigation(currentLaunch.page);
    await closeDesktop(currentLaunch);
    currentLaunch = undefined;

    assertProviderFixture(provider);
    await assertDurablePostconditions();
  }
  completed = true;
} catch (error) {
  failure = error;
  if (currentLaunch) await captureFailureArtifacts(currentLaunch, error).catch(() => undefined);
} finally {
  const cleanupErrors: unknown[] = [];
  if (currentLaunch) {
    await closeDesktop(currentLaunch).catch((error) => cleanupErrors.push(error));
    currentLaunch = undefined;
  }
  try {
    await provider.stop(true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (completed && cleanupErrors.length === 0) {
    try {
      const screenshots = (await readdir(artifacts)).filter((name) => name.endsWith(".png"));
      if (screenshots.length > 0) {
        const output = join(desktopRoot, "out/electron-e2e", new Date().toISOString().replaceAll(":", "-"));
        await mkdir(output, { recursive: true });
        for (const name of screenshots) await copyFile(join(artifacts, name), join(output, name));
        process.stdout.write(`Electron E2E screenshots: ${output}\n`);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (completed && cleanupErrors.length === 0) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
  }
  if (failure || cleanupErrors.length > 0) {
    process.stderr.write(`Electron E2E artifacts retained at ${artifacts}\n`);
    throw new AggregateError(
      [failure, ...cleanupErrors].filter((error) => error !== undefined),
      cleanupErrors.length > 0 ? "Electron E2E or its cleanup failed" : "Electron E2E failed",
    );
  }
}

process.stdout.write(
  "electron desktop E2E passed: conversation create/reload, input recovery, automatic review, input, steer, stop, "
  + "rename/search/archive, delegated conversations and settings, background projects and isolated drafts, "
  + "theme switching/system tracking/restart persistence, nine native widths from 390 to 1440, keyboard panel navigation, and live timeline following\n",
);

interface DesktopLaunch {
  name: string;
  app: ElectronApplication;
  page: Page;
  pid: number | undefined;
  closed: boolean;
  closePromise?: Promise<void>;
  traceActive: boolean;
  stdout: BoundedLog;
  stderr: BoundedLog;
  stderrAuditOffset: number;
  stderrSettled: Promise<Error | undefined>;
  rendererErrors: string[];
  mainErrors: string[];
  closeOverride?: () => Promise<void>;
}

interface DesktopFixtureEnvironment {
  rendererUrl: string;
  workspace: string;
  userData: string;
  home: string;
  tempDir: string;
  bunPath: string;
  model: "fake" | "deepseek";
  providerBaseUrl: string;
}

interface ProviderRequest {
  text: string;
  slow: boolean;
  aborted: boolean;
  finish?: () => void;
}

interface FixtureProvider {
  readonly url: URL;
  readonly requests: ProviderRequest[];
  readonly failures: string[];
  readonly timeline: TimelineFollowFixture;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

async function launchDesktop(
  name: string,
  model: "fake" | "deepseek",
): Promise<DesktopLaunch> {
  const env = desktopLaunchEnvironment({
    rendererUrl: new URL("renderer/index.html", provider.url).href,
    workspace,
    userData,
    home: chiliHome,
    tempDir: electronTemp,
    bunPath,
    model,
    providerBaseUrl: provider.url.href,
  });

  const app = await electron.launch({
    args: [desktopRoot],
    cwd: repositoryRoot,
    env,
    timeout: ACTION_TIMEOUT_MS,
    tracesDir: artifacts,
  });
  const electronProcess = app.process();
  const stdout = new BoundedLog(2 * 1024 * 1024);
  const stderr = new BoundedLog(2 * 1024 * 1024);
  const stderrSettled = readableSettlement(electronProcess.stderr);
  electronProcess.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  electronProcess.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  const rendererErrors: string[] = [];
  const mainErrors: string[] = [];
  app.on("console", (message) => {
    if (message.type() === "error") mainErrors.push(message.text());
  });
  const page = await app.firstWindow({ timeout: ACTION_TIMEOUT_MS });
  // Keep this isolated test window from receiving the developer's physical
  // keyboard input; Playwright still drives renderer focus and keyboard events.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setFocusable(false);
  });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !isExpectedResultPreviewDiagnostic(message.text(), message.location().url)) rendererErrors.push(message.text());
  });
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  const launch: DesktopLaunch = {
    name,
    app,
    page,
    pid: electronProcess.pid,
    closed: false,
    traceActive: true,
    stdout,
    stderr,
    stderrAuditOffset: 0,
    stderrSettled,
    rendererErrors,
    mainErrors,
  };
  try {
    await page.waitForLoadState("domcontentloaded");
    await waitForRuntime(page);
    launch.stderrAuditOffset = startupElectronStderrAuditOffset(
      launch.stderr.text(),
      launch.stderr.isTruncated(),
    );
    return launch;
  } catch (error) {
    await captureFailureArtifacts(launch, error).catch(() => undefined);
    await closeDesktop(launch).catch(() => undefined);
    throw error;
  }
}

function closeDesktop(launch: DesktopLaunch): Promise<void> {
  if (launch.closed) return Promise.resolve();
  if (launch.closePromise) return launch.closePromise;
  let attempt: Promise<void>;
  attempt = performDesktopClose(launch).then(
    () => {
      if (launch.closePromise === attempt) delete launch.closePromise;
    },
    (error: unknown) => {
      if (launch.closePromise === attempt) delete launch.closePromise;
      throw error;
    },
  );
  launch.closePromise = attempt;
  return attempt;
}

async function performDesktopClose(launch: DesktopLaunch): Promise<void> {
  const errors: unknown[] = [];
  if (launch.traceActive) {
    launch.traceActive = false;
    await launch.app.context().tracing.stop({
      path: join(artifacts, `${launch.name}.trace.zip`),
    }).catch((error) => errors.push(error));
  }
  const pid = launch.pid;
  let contained = false;
  try {
    await withTimeout(
      launch.closeOverride?.() ?? launch.app.close(),
      APP_CLOSE_TIMEOUT_MS,
      `closing Electron launch ${launch.name}`,
    );
    if (pid !== undefined) {
      await waitUntil(`Electron PID ${pid} to exit after app close`, () => !processExists(pid), 3_000);
    }
    contained = true;
  } catch (error) {
    errors.push(error);
    if (pid === undefined) {
      errors.push(new Error(`Electron launch ${launch.name} did not expose a process ID`));
    } else {
      try {
        await terminateExactProcess(pid);
        contained = !processExists(pid);
      } catch (terminationError) {
        errors.push(terminationError);
      }
    }
  }
  if (contained) {
    try {
      const streamError = await withTimeout(
        launch.stderrSettled,
        3_000,
        `waiting for Electron stderr to settle for ${launch.name}`,
      );
      if (streamError) errors.push(streamError);
    } catch (error) {
      errors.push(error);
    }
  }
  if (launch.rendererErrors.length > 0) {
    errors.push(new Error(`Renderer errors in ${launch.name}:\n${launch.rendererErrors.join("\n")}`));
  }
  if (launch.mainErrors.length > 0) {
    errors.push(new Error(`Electron main errors in ${launch.name}:\n${launch.mainErrors.join("\n")}`));
  }
  if (launch.stderr.isTruncated()) {
    errors.push(new Error(`Electron stderr capture was truncated in ${launch.name}`));
  } else {
    const stderr = unexpectedElectronStderr(launch.stderr.text().slice(launch.stderrAuditOffset));
    if (stderr.length > 0) {
      errors.push(new Error(`Electron stderr in ${launch.name}:\n${stderr.join("\n")}`));
    }
  }
  if (contained) launch.closed = true;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Failed to close Electron launch ${launch.name} cleanly`);
}

async function proveCloseAbortRetryInvariant(launch: DesktopLaunch): Promise<void> {
  const pid = launch.pid;
  assert.ok(pid, "Close/abort canary requires the real Electron process ID");
  const request = provider.requests.find((candidate) => candidate.text.includes(SLOW_STEER_PROMPT));
  assert.ok(request, "Close/abort canary requires an active slow provider request");
  assert.equal(request.slow, true);
  assert.equal(request.aborted, false);
  await expectVisible(launch.page.locator(".timeline")
    .getByText(`Fixture stream opened: ${SLOW_STEER_PROMPT}`, { exact: true }));
  await expectVisible(launch.page.locator(".conversation-activity")
    .getByRole("button", { name: "Stop current turn", exact: true }));
  let closeAttempts = 0;
  launch.closeOverride = async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("injected recoverable Electron close failure");
    await launch.app.close();
  };
  launch.pid = undefined;
  let evidence: {
    markedClosedBeforeSettlement: boolean;
    closeAttemptsAfterRetry: number;
    launchClosedAfterRetry: boolean;
    electronAliveAfterRetry: boolean;
    providerAbortedAfterRetry: boolean;
  } | undefined;
  let phaseError: unknown;
  try {
    const firstClose = closeDesktop(launch);
    const markedClosedBeforeSettlement = launch.closed;
    const firstCloseError = await firstClose.then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(firstCloseError instanceof AggregateError, "Injected first close failure must retain all diagnostics");
    assert.equal(firstCloseError.message, `Failed to close Electron launch ${launch.name} cleanly`);
    assert.deepEqual(firstCloseError.errors.map(safeError), [
      "Error: injected recoverable Electron close failure",
      `Error: Electron launch ${launch.name} did not expose a process ID`,
    ], "The injected failure must not swallow or acquire unrelated close diagnostics");
    await closeDesktop(launch);
    if (!processExists(pid)) {
      await waitUntil("exact close/abort canary provider request", () => request.aborted).catch(() => undefined);
    }
    evidence = {
      markedClosedBeforeSettlement,
      closeAttemptsAfterRetry: closeAttempts,
      launchClosedAfterRetry: launch.closed,
      electronAliveAfterRetry: processExists(pid),
      providerAbortedAfterRetry: request.aborted,
    };
    await writeFile(
      join(artifacts, "close-abort-canary.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    phaseError = error;
  }

  const cleanupErrors: unknown[] = [];
  delete launch.closeOverride;
  launch.pid = pid;
  if (processExists(pid)) {
    launch.closed = false;
    await closeDesktop(launch).catch((error) => cleanupErrors.push(error));
  }
  await waitUntil("exact close/abort canary provider request cleanup", () => request.aborted)
    .catch((error) => cleanupErrors.push(error));
  if (phaseError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [phaseError, ...cleanupErrors].filter((error) => error !== undefined),
      "Close/abort canary or its cleanup failed",
    );
  }

  assert.deepEqual(evidence, {
    markedClosedBeforeSettlement: false,
    closeAttemptsAfterRetry: 2,
    launchClosedAfterRetry: true,
    electronAliveAfterRetry: false,
    providerAbortedAfterRetry: true,
  }, "An in-flight input close failure must remain retryable until Electron, sidecar, and provider abort settle");
}

async function createConversationThroughUi(page: Page): Promise<void> {
  const dialog = await openNewTaskDialog(page);
  await dialog.getByLabel("Task title", { exact: true }).fill(CONVERSATION_TITLE);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(CONVERSATION_PROMPT);
  await assertTaskConfigurationControls(dialog);
  await chooseOptionIfAvailable(dialog.getByLabel("Reasoning", { exact: true }), /^medium$/iu);
  await chooseOptionIfAvailable(dialog.getByLabel("Service tier", { exact: true }), /^standard$/iu);
  await dialog.getByLabel("Permission profile", { exact: true }).selectOption("auto-review");
  await chooseOptionIfAvailable(dialog.getByLabel("Delegation", { exact: true }), /^proactive\b/iu);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForTaskTitle(page, CONVERSATION_TITLE);
}

async function closeSettings(page: Page): Promise<void> {
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
}

async function assertConversationAndSettings(page: Page): Promise<void> {
  await expectVisible(page.locator(".timeline").getByText(`Echo: ${CONVERSATION_PROMPT}`, { exact: true }));
  assert.equal(await page.locator(".timeline .message-user").count(), 1, "The configured prompt is submitted once");
  const settings = await openDesktopSettings(page);
  await settings.getByRole("button", { name: "权限与协作", exact: true }).click();
  const permissionMode = settings.getByLabel("Task permission profile", { exact: true });
  await expectVisible(permissionMode);
  assert.deepEqual((await permissionMode.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).sort(), ["auto-review", "full-access"]);
  await permissionMode.selectOption("auto-review");
  const reviewInstructions = settings.getByLabel("审查说明", { exact: true });
  await expectVisible(reviewInstructions);
  await expectVisible(settings.getByLabel("审查模型", { exact: true }));
  const defaultReviewInstructions = await reviewInstructions.inputValue();
  assert.ok(defaultReviewInstructions.trim().length > 0, "Automatic review starts with default instructions");
  const customReviewInstructions = "Allow project changes and reject unrelated destructive actions.";
  await reviewInstructions.fill(customReviewInstructions);
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  await openDesktopSettings(page);
  await settings.getByRole("button", { name: "权限与协作", exact: true }).click();
  assert.equal(await reviewInstructions.inputValue(), customReviewInstructions, "Custom review instructions survive a runtime settings roundtrip");
  await settings.getByRole("button", { name: "恢复默认说明", exact: true }).click();
  assert.equal(await reviewInstructions.inputValue(), defaultReviewInstructions);
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  await openDesktopSettings(page);
  await settings.getByRole("button", { name: "权限与协作", exact: true }).click();
  assert.equal(await reviewInstructions.inputValue(), defaultReviewInstructions, "Reset review instructions survive a runtime settings roundtrip");
  await page.screenshot({ path: join(artifacts, "review-settings.png") });
  await permissionMode.selectOption("full-access");
  assert.equal(await reviewInstructions.count(), 0, "Full access does not expose automatic review settings");
  await permissionMode.selectOption("auto-review");
  await expectVisible(settings.getByLabel("Task delegation", { exact: true }));
  await settings.getByRole("button", { name: "工具与技能", exact: true }).click();
  await expectVisible(settings.getByRole("heading", { name: "工具连接 · MCP", exact: true }));
  await closeSettings(page);
}

async function createReviewTaskThroughUi(page: Page): Promise<void> {
  const dialog = await openNewTaskDialog(page);
  await dialog.getByLabel("Task title", { exact: true }).fill(REVIEW_TITLE);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill("desktop review fixture");
  await assertTaskConfigurationControls(dialog);
  await chooseOptionIfAvailable(dialog.getByLabel("Reasoning", { exact: true }), /^low$/iu);
  await chooseOptionIfAvailable(dialog.getByLabel("Reasoning", { exact: true }), /^high\b/iu);
  await chooseOptionIfAvailable(dialog.getByLabel("Service tier", { exact: true }), /^standard$/iu);
  await chooseOptionIfAvailable(dialog.getByLabel("Permission profile", { exact: true }), /^full access\b/iu);
  await dialog.getByLabel("Permission profile", { exact: true }).selectOption("auto-review");
  await chooseOptionIfAvailable(dialog.getByLabel("Delegation", { exact: true }), /^off\b/iu);
  await chooseOptionIfAvailable(dialog.getByLabel("Delegation", { exact: true }), /^explicit\b/iu);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForTaskTitle(page, REVIEW_TITLE);
}

async function assertAutomaticReviewThroughUi(page: Page): Promise<void> {
  await expectVisible(page.getByText("I read the file and the tool loop works.", { exact: true }));
  assert.equal(await page.locator(".approval-card").count(), 0, "Automatic review must not request manual approval");
}

async function resolveUserInputThroughUi(page: Page): Promise<void> {
  const completedBefore = await page.getByText("I read the file and the tool loop works.", { exact: true }).count();
  const composer = activeComposer(page);
  await composer.fill("desktop input fixture");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const inputGroup = page.getByRole("group", {
    name: /Choose a response for the desktop input fixture\./iu,
  });
  const inputCard = page.locator(".input-card").filter({ has: inputGroup });
  await expectVisible(inputCard);
  const primaryChoice = inputCard.getByRole("button", { name: /^Continue\b/iu });
  const customAnswer = inputCard.getByLabel("Custom answer for Desktop QA", { exact: true });
  const switchTo = async (title: string) => {
    await page.locator(".project-active .session-row").filter({ has: page.getByText(title, { exact: true }) }).click();
    await waitForTaskTitle(page, title);
  };
  await primaryChoice.click();
  await switchTo(CONVERSATION_TITLE);
  await switchTo(REVIEW_TITLE);
  assert.equal(await primaryChoice.getAttribute("aria-pressed"), "true", "A question choice survives leaving and returning to its conversation");
  await customAnswer.fill("保留这个问题的补充说明");
  await switchTo(CONVERSATION_TITLE);
  await switchTo(REVIEW_TITLE);
  assert.equal(await customAnswer.inputValue(), "保留这个问题的补充说明", "Custom question answers survive conversation switches");
  assert.equal(await primaryChoice.getAttribute("aria-pressed"), "false", "A custom single-choice answer replaces the predefined choice");
  await primaryChoice.click();
  assert.equal(await customAnswer.inputValue(), "");
  await page.screenshot({ path: join(artifacts, "conversation-input-restored.png") });
  await inputCard.getByRole("button", { name: "Submit answer", exact: true }).click();
  await inputCard.waitFor({ state: "hidden" });
  await waitUntil("resolved user-input completion", async () => (
    await page.getByText("I read the file and the tool loop works.", { exact: true }).count()
  ) > completedBefore);
}

async function renameSearchAndArchiveThroughUi(page: Page): Promise<void> {
  const initialActions = page.getByRole("button", { name: `Task actions for ${REVIEW_TITLE}`, exact: true });
  await initialActions.click();
  const initialMenu = page.getByRole("menu", { name: `Task actions for ${REVIEW_TITLE}`, exact: true });
  await expectFocused(initialMenu.getByRole("menuitem", { name: "重命名", exact: true }));
  await page.keyboard.press("Escape");
  await expectFocused(initialActions);
  await initialActions.click();
  await initialMenu.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename task", exact: true });
  await expectVisible(renameDialog);
  const titleInput = renameDialog.getByLabel("New task title", { exact: true });
  await titleInput.fill(RENAMED_REVIEW_TITLE);
  await renameDialog.getByRole("button", { name: "Save name", exact: true }).click();
  await renameDialog.waitFor({ state: "hidden" });
  await waitForTaskTitle(page, RENAMED_REVIEW_TITLE);

  await page.getByRole("button", { name: "搜索会话", exact: true }).click();
  const search = page.getByLabel("Search tasks", { exact: true });
  await search.fill("renamed review");
  const renamedTaskRow = page.getByRole("button", { name: /^Renamed review E2E\b/iu });
  await expectVisible(renamedTaskRow);
  await page.getByRole("button", { name: `Task actions for ${RENAMED_REVIEW_TITLE}`, exact: true }).click();
  const renamedMenu = page.getByRole("menu", {
    name: `Task actions for ${RENAMED_REVIEW_TITLE}`,
    exact: true,
  });
  await renamedMenu.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archive task?", exact: true });
  await expectVisible(archiveDialog);
  await expectFocused(archiveDialog.getByRole("button", { name: "Cancel", exact: true }));
  await archiveDialog.getByRole("button", { name: "归档会话", exact: true }).click();
  await archiveDialog.waitFor({ state: "hidden" });
  const statusTabs = page.getByRole("tablist", { name: "Task status", exact: true });
  const archivedTab = statusTabs.getByRole("tab", { name: /^已归档/u });
  await waitUntil("Archived tasks tab selection after archive", async () => (
    await archivedTab.getAttribute("aria-selected") === "true"
  ));
  await expectVisible(renamedTaskRow);
  assert.equal(
    await page.getByRole("button", { name: `Task actions for ${RENAMED_REVIEW_TITLE}`, exact: true }).count(),
    0,
    "Archived tasks must not expose mutation actions",
  );
  await statusTabs.getByRole("tab", { name: /^会话/u }).click();
  await renamedTaskRow.waitFor({ state: "hidden" });
  await search.fill("");
}

async function createSlowProviderTaskThroughUi(page: Page): Promise<string> {
  const dialog = await openNewTaskDialog(page);
  await dialog.getByLabel("Task title", { exact: true }).fill(SLOW_TITLE);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(SLOW_STEER_PROMPT);
  await assertTaskConfigurationControls(dialog);
  await chooseOption(dialog.getByLabel("Model", { exact: true }), /^DeepSeek V4 Pro\b/iu);
  await chooseOption(dialog.getByLabel("Reasoning", { exact: true }), /^low$/iu);
  await chooseOption(dialog.getByLabel("Reasoning", { exact: true }), /^high\b/iu);
  await assertProviderDefaultServiceTier(dialog);
  await chooseOption(dialog.getByLabel("Permission profile", { exact: true }), /^full access\b/iu);
  await chooseOption(dialog.getByLabel("Delegation", { exact: true }), /^proactive\b/iu);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForTaskTitle(page, SLOW_TITLE);
  await waitForProviderRequest(SLOW_STEER_PROMPT, 1);
  return (await latestSlowInput()).input_id;
}

async function assertProgressDismissalDuringWork(page: Page): Promise<void> {
  const request = provider.requests.findLast((candidate) => candidate.text.includes(SLOW_STEER_PROMPT));
  assert.ok(request && !request.aborted, "The progress check starts with a real running provider request");
  const panel = page.getByRole("complementary", { name: "会话侧栏", exact: true });
  await page.getByRole("button", { name: "进展", exact: true }).click();
  await panel.waitFor();
  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await page.locator(".conversation-activity").getByRole("button", { name: "Stop current turn", exact: true }).waitFor();
  assert.equal(request.aborted, false, "Closing progress must not abort the active provider request");
}

async function recoverSlowInputThroughUi(page: Page, inputId: string): Promise<void> {
  await waitForTaskTitle(page, SLOW_TITLE);
  const settings = await openDesktopSettings(page);
  await settings.getByRole("button", { name: "权限与协作", exact: true }).click();
  assert.equal(await settings.getByLabel("Task permission profile", { exact: true }).inputValue(), "full-access", "Permission mode persists across restart");
  await settings.getByRole("button", { name: "模型与账号", exact: true }).click();
  assert.equal(await settings.getByLabel("Task service tier", { exact: true }).inputValue(), "");
  await closeSettings(page);
  const requestsBeforeResume = provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length;
  const input = await latestSlowInput();
  assert.equal(input.input_id, inputId);
  assert.equal(input.outcome, "interrupted");
  await sleep(750);
  assert.equal(
    provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length,
    requestsBeforeResume,
    "A durable input resumed without an explicit desktop action",
  );
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await waitForProviderRequest(SLOW_STEER_PROMPT, requestsBeforeResume + 1);
  const resumed = await latestSlowInput();
  assert.equal(resumed.input_id, inputId, "Restart recovery must retain the original input identity");
  assert.equal(resumed.resumed, 1);
}

async function submitSlowInputThroughUi(page: Page): Promise<void> {
  const requestsBefore = provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length;
  await activeComposer(page).fill(SLOW_STEER_PROMPT);
  await page.locator(".composer-buttons").getByRole("button", { name: "Send message", exact: true }).click();
  await waitForProviderRequest(SLOW_STEER_PROMPT, requestsBefore + 1);
}

async function steerSlowTurnThroughUi(page: Page): Promise<void> {
  const controls = page.locator(".composer-buttons");
  await expectVisible(page.locator(".conversation-activity").getByRole("button", { name: "Stop current turn", exact: true }));
  const slowRequestsBefore = provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length;
  const slowAbortsBefore = provider.requests.filter((request) => (
    request.text.includes(SLOW_STEER_PROMPT) && request.aborted
  )).length;
  const composer = activeComposer(page);
  await composer.fill(STEER_REPLACEMENT);
  await controls.getByRole("button", { name: "调整方向", exact: true }).click();
  await waitForProviderRequest(STEER_REPLACEMENT, 1);
  await expectVisible(page.locator(".timeline").getByText(`Fixture response: ${STEER_REPLACEMENT}`, { exact: true }));
  await waitForProviderAbort(SLOW_STEER_PROMPT, slowAbortsBefore + 1);
  await page.locator(".composer-buttons").getByRole("button", { name: "Send message", exact: true }).waitFor();
  assert.equal(
    provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length,
    slowRequestsBefore,
    "Steer must not automatically restart the superseded input",
  );
}

async function stopSlowTurnThroughUi(page: Page): Promise<void> {
  const slowAbortsBefore = provider.requests.filter((request) => (
    request.text.includes(SLOW_STEER_PROMPT) && request.aborted
  )).length;
  const stop = page.locator(".conversation-activity")
    .getByRole("button", { name: "Stop current turn", exact: true });
  await expectVisible(stop);
  await stop.click();
  await stop.waitFor({ state: "hidden" });
  await waitForProviderAbort(SLOW_STEER_PROMPT, slowAbortsBefore + 1);
  await expectVisible(page.locator(".conversation-activity")
    .getByRole("button", { name: "继续处理", exact: true }));
}

async function resumeStoppedTaskThroughUi(page: Page): Promise<void> {
  const inputBeforeResume = await latestSlowInput();
  const slowRequestsBefore = provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length;
  const resume = page.locator(".conversation-activity")
    .getByRole("button", { name: "继续处理", exact: true });
  await expectVisible(resume);
  await resume.click();
  await resume.waitFor({ state: "hidden" });
  await waitForProviderRequest(SLOW_STEER_PROMPT, slowRequestsBefore + 1);
  const resumed = await latestSlowInput();
  assert.equal(resumed.input_id, inputBeforeResume.input_id, "Resume must retain the stopped input identity");
  assert.equal(resumed.resumed, 1);
  await expectVisible(page.locator(".conversation-activity")
    .getByRole("button", { name: "Stop current turn", exact: true }));
}

async function sendRecoveryFollowUpThroughUi(page: Page): Promise<void> {
  const inputBeforeResume = await latestSlowInput();
  const slowRequestsBefore = provider.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT)).length;
  const composer = activeComposer(page);
  await expectVisible(composer);
  await composer.fill(RECOVERY_PROMPT);
  await page.locator(".composer-buttons").getByRole("button", { name: "Queue message", exact: true }).click();
  assert.equal(provider.requests.some((request) => request.text.includes(RECOVERY_PROMPT)), false,
    "Input submitted while paused must stay queued");
  await page.getByRole("list", { name: "待处理消息", exact: true }).getByText(RECOVERY_PROMPT, { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "conversation-paused-queue.png") });
  await page.getByRole("button", { name: "继续处理", exact: true }).click();
  await waitForProviderRequest(SLOW_STEER_PROMPT, slowRequestsBefore + 1);
  assert.equal((await latestSlowInput()).input_id, inputBeforeResume.input_id);
  assert.equal(provider.requests.some((request) => request.text.includes(RECOVERY_PROMPT)), false,
    "Resume must finish the interrupted input before processing queued work");
  const resumedRequest = provider.requests.findLast((request) => request.text.includes(SLOW_STEER_PROMPT));
  assert.ok(resumedRequest?.finish, "The resumed stream must be controllable by the local fixture");
  resumedRequest.finish();
  await waitForProviderRequest(RECOVERY_PROMPT, 1);
  await expectVisible(page.locator(".timeline").getByText(`Fixture response: ${RECOVERY_PROMPT}`, { exact: true }));
}

interface DurableSlowInput extends Record<string, unknown> {
  input_id: string;
  outcome: string | null;
  resumed: number;
}

async function latestSlowInput(): Promise<DurableSlowInput> {
  const inputs = await querySqliteRows<DurableSlowInput>(
    `select input_id, outcome, resumed from session_inputs
       join sessions on sessions.id = session_inputs.session_id
      where sessions.title = '${SLOW_TITLE}' and session_inputs.text = '${SLOW_STEER_PROMPT}'
      order by sequence desc limit 1`,
  );
  assert.equal(inputs.length, 1, "The slow prompt must have a durable input receipt");
  return inputs[0]!;
}

async function assertNativeResponsiveWidths(launch: DesktopLaunch): Promise<void> {
  for (const width of [1440, 1081, 1080, 820, 696, 695, 641, 640, 390]) {
    const expected = { width, height: 820 };
    const contentSize = await launch.app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Desktop E2E could not find its BrowserWindow");
      window.setContentSize(size.width, size.height, false);
      return window.getContentSize();
    }, expected);
    assert.deepEqual(contentSize, [expected.width, expected.height], `native content size at ${width}px`);
    await launch.page.waitForFunction(
      (expectedWidth) => window.innerWidth === expectedWidth,
      width,
      { timeout: ACTION_TIMEOUT_MS },
    );
    const metrics = await launch.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    assert.equal(metrics.innerWidth, width, `renderer width at ${width}px`);
    assert.ok(metrics.documentWidth <= width + 1, `document overflow at ${width}px: ${metrics.documentWidth}`);
    assert.ok(metrics.bodyWidth <= width + 1, `body overflow at ${width}px: ${metrics.bodyWidth}`);
    if ([640, 641, 695, 696, 1080, 1081].includes(width)) {
      await assertResponsiveNavigation(launch.page);
      await launch.page.waitForFunction(() => [".sidebar"].every((selector) => {
        const panel = document.querySelector(selector);
        return panel && getComputedStyle(panel).opacity === "0" && getComputedStyle(panel).visibility === "hidden";
      }));
      await launch.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await launch.page.screenshot({ path: join(artifacts, `responsive-navigation-${width}.png`) });
    }
    const appearance = await openDesktopSettings(launch.page);
    await assertWithinViewport(appearance, width, `settings dialog at ${width}px`);
    await assertWithinViewport(appearance.getByLabel("颜色主题", { exact: true }), width, `theme choice at ${width}px`);
    await launch.page.screenshot({ path: join(artifacts, `appearance-${width}.png`) });
    await appearance.getByRole("button", { name: "关闭设置", exact: true }).click();
    await assertWithinViewport(
      launch.page.locator(".titlebar-leading").getByRole("button", { name: /(?:Hide|Show) sidebar/iu }),
      width,
      `sidebar toggle at ${width}px`,
    );

    const hideSidebar = launch.page.locator(".titlebar-leading")
      .getByRole("button", { name: "Hide sidebar", exact: true });
    if (await isVisible(hideSidebar, 500)) {
      await expectVisible(launch.page.locator(".sidebar-actions").getByRole("button", { name: /^New task\b/iu }));
      await hideSidebar.click();
    }
    await assertWithinViewport(activeComposer(launch.page), width, `composer at ${width}px`);
    await assertWithinViewport(
      launch.page.locator(".timeline .message-user").filter({ hasText: RECOVERY_PROMPT }),
      width,
      `recovery message at ${width}px`,
    );
    const showSidebar = launch.page.locator(".titlebar-leading")
      .getByRole("button", { name: "Show sidebar", exact: true });
    await expectVisible(showSidebar);
    await showSidebar.click();
    await assertWithinViewport(
      launch.page.locator(".sidebar-actions").getByRole("button", { name: /^New task\b/iu }),
      width,
      `New task at ${width}px`,
    );
  }
}

async function assertMultipleProjects(launch: DesktopLaunch): Promise<void> {
  const page = launch.page;
  const slow = provider.requests.find((request) => request.text.includes(SLOW_STEER_PROMPT));
  assert.ok(slow && !slow.aborted, "Project A should still be streaming");
  await activeComposer(page).fill("Queued message for project A");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await waitUntil("project A queued message", async () => await page.evaluate(async () => {
    const state = await (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop.invoke({ type: "app.state" });
    return Object.values(state.queuedBySession).reduce((sum, count) => sum + count, 0) === 1;
  }));
  await activeComposer(page).fill(PROJECT_A_DRAFT);
  const otherWorkspace = join(temporaryRoot, "project-b");
  await mkdir(otherWorkspace, { recursive: true });
  await runChecked(["/usr/bin/git", "init", "--quiet", otherWorkspace], repositoryRoot, 10_000);
  // Exercise the Add project UI while replacing only the native OS picker.
  await launch.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, otherWorkspace);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await waitUntil("project B to become active", async () => (
    await page.getByRole("button", { name: "Open project project-b", exact: true }).getAttribute("aria-current") === "true"
  ));
  assert.equal(await page.evaluate(async () => {
    const state = await (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop.invoke({ type: "app.state" });
    return Object.values(state.queuedBySession).reduce((sum, count) => sum + count, 0);
  }), 0, "Project B must not display project A's queue");
  const dialog = await openNewTaskDialog(page);
  await dialog.getByLabel("Task title", { exact: true }).fill(PROJECT_B_TITLE);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(PROJECT_B_PROMPT);
  await chooseOption(dialog.getByLabel("Model", { exact: true }), /^DeepSeek V4 Pro\b/iu);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForTaskTitle(page, PROJECT_B_TITLE);
  await expectVisible(page.locator(".timeline").getByText(`Fixture response: ${PROJECT_B_PROMPT}`, { exact: true }));
  assert.equal(slow.aborted, false, "Switching projects must not stop project A's provider stream");
  assert.equal(await page.locator(".timeline").getByText(`Fixture stream opened: ${SLOW_STEER_PROMPT}`, { exact: true }).count(), 0);
  await activeComposer(page).fill(PROJECT_B_DRAFT);
  await page.getByRole("button", { name: "Open project workspace", exact: true }).click();
  await waitForTaskTitle(page, SLOW_TITLE);
  await waitUntil("project A draft restoration", async () => await activeComposer(page).inputValue() === PROJECT_A_DRAFT);
  assert.equal(await page.evaluate(async () => {
    const state = await (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop.invoke({ type: "app.state" });
    return Object.values(state.queuedBySession).reduce((sum, count) => sum + count, 0);
  }), 1, "Project A's queue must survive switching projects");
  await expectVisible(page.locator(".timeline").getByText(`Fixture stream opened: ${SLOW_STEER_PROMPT}`, { exact: true }));
  assert.equal(slow.aborted, false);
  assert.equal(await page.locator(".timeline").getByText(`Fixture response: ${PROJECT_B_PROMPT}`, { exact: true }).count(), 0);
  await page.getByRole("button", { name: `Open ${PROJECT_B_TITLE} in project-b`, exact: true }).click();
  await waitForTaskTitle(page, PROJECT_B_TITLE);
  await waitUntil("project B draft restoration", async () => await activeComposer(page).inputValue() === PROJECT_B_DRAFT);
  await page.screenshot({ path: join(artifacts, "multiple-projects.png") });
  const backgroundProject = page.locator(".project-group").filter({ has: page.getByRole("button", { name: "Open project workspace", exact: true }) });
  await backgroundProject.getByRole("button", { name: "收起 workspace 的会话", exact: true }).click();
  assert.equal(await backgroundProject.locator(".project-task-preview").count(), 0);
  await waitForTaskTitle(page, PROJECT_B_TITLE);
  assert.equal(await activeComposer(page).inputValue(), PROJECT_B_DRAFT, "Collapsing another directory preserves the active chat and draft");
  await backgroundProject.getByRole("button", { name: "展开 workspace 的会话", exact: true }).click();
  assert.equal(await backgroundProject.getByRole("button", { name: /^Open .+ in workspace$/ }).count(), 5);
  await backgroundProject.getByRole("button", { name: "展开更多会话", exact: true }).click();
  await waitForTaskTitle(page, SLOW_TITLE);
  assert.equal(await page.locator(".project-active .session-row").count(), 10, "Expanding a background directory loads more than its five cached previews");
  assert.equal(slow.aborted, false);
  await activeComposer(page).fill("");
}

async function assertProjectsRestored(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open project project-b", exact: true }).click();
  await waitForTaskTitle(page, PROJECT_B_TITLE);
  await expectVisible(page.locator(".timeline").getByText(`Fixture response: ${PROJECT_B_PROMPT}`, { exact: true }));
  await page.getByRole("button", { name: "Open project workspace", exact: true }).click();
  await waitForTaskTitle(page, SLOW_TITLE);
}

async function assertTaskConfigurationControls(dialog: Locator): Promise<void> {
  for (const name of [
    "Task title",
    "What should Chili accomplish?",
    "Model",
    "Reasoning",
    "Service tier",
    "Permission profile",
    "Delegation",
  ]) {
    await expectVisible(dialog.getByLabel(name, { exact: true }));
  }
  await expectVisible(dialog.getByText(
    "Saved as your default and applied to every task in this workspace.",
    { exact: true },
  ));
}

async function assertProviderDefaultServiceTier(dialog: Locator): Promise<void> {
  const serviceTier = dialog.getByLabel("Service tier", { exact: true });
  assert.equal(await serviceTier.isDisabled(), true, "DeepSeek service tier control must be disabled");
  assert.equal(await serviceTier.inputValue(), "", "DeepSeek must submit no explicit service tier");
  assert.equal(
    (await serviceTier.getByRole("option", { name: "Provider default", exact: true }).count()),
    1,
    "DeepSeek must expose one provider-default service tier option",
  );
  await expectVisible(dialog.getByText(
    "This provider does not expose a configurable service tier.",
    { exact: true },
  ));
}

async function openNewTaskDialog(page: Page): Promise<Locator> {
  const dialog = await openAdvancedTaskDialog(page);
  await expectVisible(dialog);
  await expectFocused(dialog.getByLabel("Task title", { exact: true }));
  return dialog;
}

async function waitForRuntime(page: Page): Promise<void> {
  const status = page.locator('[title="Local runtime status"]');
  await expectVisible(status);
  await waitUntil("healthy desktop sidecar", async () => /healthy/iu.test(await status.innerText()));
  await expectVisible(page.getByRole("button", { name: /^New task\b/iu }));
}

async function waitForTaskTitle(page: Page, title: string): Promise<void> {
  await expectVisible(page.getByRole("heading", { name: title, exact: true }));
  await expectVisible(page.getByText(title, { exact: true }).first());
}

function activeComposer(page: Page): Locator {
  return page.getByLabel("Message composer", { exact: true });
}

async function chooseOptionIfAvailable(select: Locator, pattern: RegExp): Promise<boolean> {
  const option = await matchingOption(select, pattern);
  if (!option) return false;
  await select.selectOption(option.value);
  return true;
}

async function chooseOption(select: Locator, pattern: RegExp): Promise<void> {
  const option = await matchingOption(select, pattern);
  assert.ok(option, `No enabled option matching ${String(pattern)} in ${await select.innerText()}`);
  await select.selectOption(option.value);
}

async function matchingOption(
  select: Locator,
  pattern: RegExp,
): Promise<{ value: string; text: string } | undefined> {
  const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => {
    const option = node as HTMLOptionElement;
    return { value: option.value, text: option.textContent?.trim() ?? "", disabled: option.disabled };
  }));
  return options.find((option) => !option.disabled && regexMatches(pattern, option.text));
}

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

async function expectVisible(locator: Locator, timeout = ACTION_TIMEOUT_MS): Promise<void> {
  await locator.waitFor({ state: "visible", timeout });
}

async function expectFocused(locator: Locator): Promise<void> {
  await waitUntil("focused control", () => locator.evaluate((element) => element === document.activeElement));
}

async function isVisible(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function assertWithinViewport(locator: Locator, width: number, label: string): Promise<void> {
  await expectVisible(locator);
  await waitUntil(`${label} layout to settle`, async () => {
    const bounds = await locator.boundingBox();
    return Boolean(bounds && bounds.x >= -0.5 && bounds.x + bounds.width <= width + 0.5);
  }, 3_000);
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `${label} had no layout box`);
  assert.ok(bounds.x >= -0.5, `${label} began outside the viewport: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.x + bounds.width <= width + 0.5, `${label} overflowed the viewport: ${JSON.stringify(bounds)}`);
}

async function waitForProviderRequest(text: string, expectedCount: number): Promise<void> {
  await waitUntil(`provider request ${JSON.stringify(text)}`, () => {
    assert.deepEqual(provider.failures, [], `Local provider failures:\n${provider.failures.join("\n")}`);
    return provider.requests.filter((request) => request.text.includes(text)).length >= expectedCount;
  }, PROVIDER_TIMEOUT_MS);
}

async function waitForProviderAbort(text: string, expectedCount: number): Promise<void> {
  await waitUntil(`provider abort ${JSON.stringify(text)}`, () => (
    provider.requests.filter((request) => request.text.includes(text) && request.aborted).length >= expectedCount
  ), PROVIDER_TIMEOUT_MS);
}

function assertProviderFixture(fixture: FixtureProvider): void {
  assert.deepEqual(fixture.failures, [], `Local provider failures:\n${fixture.failures.join("\n")}`);
  assert.ok(fixture.requests.filter((request) => request.text.includes(SLOW_STEER_PROMPT) && request.aborted).length >= 3);
  assert.ok(fixture.requests.some((request) => request.text.includes(STEER_REPLACEMENT) && !request.slow));
  assert.ok(fixture.requests.some((request) => request.text.includes(RECOVERY_PROMPT) && !request.slow));
}

async function startFixtureProvider(): Promise<FixtureProvider> {
  const requests: ProviderRequest[] = [];
  const failures: string[] = [];
  let responseId = 0;
  const timeline = new TimelineFollowFixture();
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response, requests, () => {
      responseId += 1;
      return responseId;
    }, timeline).catch((error) => {
      const message = safeError(error);
      failures.push(message);
      if (!response.headersSent) {
        writeJson(response, 500, { error: { message } });
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const reject = (error: Error): void => rejectListen(error);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local fixture provider did not bind a TCP port");
  }
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    requests,
    failures,
    timeline,
    stop: async (closeActiveConnections = false) => {
      if (closeActiveConnections) server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProviderRequest[],
  nextResponseId: () => number,
  timeline: TimelineFollowFixture,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET") {
    await writeRendererAsset(response, url);
    return;
  }
  if (request.method !== "POST" || !url.pathname.endsWith("/responses")) {
    throw new Error(`Unexpected fixture request: ${request.method ?? "UNKNOWN"} ${url.pathname}`);
  }
  if (request.headers.authorization !== `Bearer ${LOCAL_API_KEY}`) {
    throw new Error("Local provider received the wrong authorization header");
  }
  const body = JSON.parse(await readRequestBody(request)) as unknown;
  assert.ok(isRecord(body) && body.stream === true && Array.isArray(body.input), "Responses fixture requires streamed input");
  assert.equal(body.model, "deepseek-v4-pro");
  const text = providerPromptText(body);
  const slow = text.includes(SLOW_STEER_PROMPT);
  const observed: ProviderRequest = { text, slow, aborted: false };
  requests.push(observed);
  const responseId = nextResponseId();
  if (text.includes(TIMELINE_FOLLOW_PROMPT)) {
    timeline.open(request, response, observed, responseId);
    return;
  }
  if (slow) {
    writeSlowProviderResponse(request, response, observed, responseId);
    return;
  }
  const content = `Fixture response: ${text}`;
  openFixtureResponse(response, responseId);
  response.write(sseData({
    type: "response.output_text.delta", item_id: `msg_chili_e2e_${responseId}`,
    output_index: 0, content_index: 0, delta: content,
  }));
  finishFixtureResponse(response, responseId, content);
}

async function writeRendererAsset(response: ServerResponse, url: URL): Promise<void> {
  const prefix = "/renderer/";
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const asset = url.pathname.slice(prefix.length) || "index.html";
  if (asset !== "index.html" && !/^assets\/[A-Za-z\d._-]+$/u.test(asset)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const bytes = await readFile(join(desktopRoot, "out", "renderer", asset)).catch(() => undefined);
  if (!bytes) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const contentType = asset.endsWith(".html")
    ? "text/html; charset=utf-8"
    : asset.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8";
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(bytes);
}

function writeSlowProviderResponse(
  request: IncomingMessage,
  response: ServerResponse,
  observed: ProviderRequest,
  id: number,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const markAborted = (): void => {
    if (settled) return;
    settled = true;
    observed.aborted = true;
    if (timer) clearTimeout(timer);
    if (!response.writableEnded) response.end();
  };
  request.once("aborted", markAborted);
  response.once("close", () => {
    if (!settled) markAborted();
  });
  const content = `Fixture stream opened: ${observed.text}`;
  openFixtureResponse(response, id);
  response.write(sseData({
    type: "response.output_text.delta", item_id: `msg_chili_e2e_${id}`,
    output_index: 0, content_index: 0, delta: content,
  }));
  observed.finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    finishFixtureResponse(response, id, content);
  };
  timer = setTimeout(observed.finish, 120_000);
}

function openFixtureResponse(response: ServerResponse, id: number): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(sseData({
    type: "response.created",
    response: { id: `chili_e2e_${id}`, model: "deepseek-v4-pro", status: "in_progress", output: [] },
  }));
  response.write(sseData({
    type: "response.output_item.added", output_index: 0,
    item: { id: `msg_chili_e2e_${id}`, type: "message", role: "assistant", status: "in_progress", content: [] },
  }));
}

function finishFixtureResponse(response: ServerResponse, id: number, text: string): void {
  const item = {
    id: `msg_chili_e2e_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  response.write(sseData({
    type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text,
  }));
  response.write(sseData({ type: "response.output_item.done", output_index: 0, item }));
  response.write(sseData({
    type: "response.completed",
    response: {
      id: `chili_e2e_${id}`, model: "deepseek-v4-pro", status: "completed", output: [item],
      usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
    },
  }));
  response.end();
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > 2_000_000) throw new Error("Local provider request exceeded 2 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function providerPromptText(value: unknown): string {
  if (!isRecord(value)) throw new Error("Provider body omitted input");
  const messages = Array.isArray(value.input) ? value.input : value.messages;
  if (!Array.isArray(messages)) throw new Error("Provider body omitted input");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = messageText(message);
    if (text.trim()) return text;
  }
  throw new Error("Provider body omitted a user message");
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((part) => (
    isRecord(part) && (part.type === "input_text" || part.type === "text") && typeof part.text === "string" ? [part.text] : []
  )).join("\n");
}

async function assertDurablePostconditions(): Promise<void> {
  await access(databasePath);
  const sessions = await querySqliteRows<{ title: string | null; status: string }>(
    "select title, status from sessions order by created_at asc",
  );
  assert.ok(sessions.some((session) => session.title === CONVERSATION_TITLE && session.status === "active"));
  assert.ok(sessions.some((session) => session.title === RENAMED_REVIEW_TITLE && session.status === "archived"));
  assert.ok(sessions.some((session) => session.title === SLOW_TITLE && session.status === "active"));

  const inputs = await querySqliteRows<{ title: string; text: string; outcome: string; resumed: number }>(
    `select sessions.title, session_inputs.text, session_inputs.outcome, session_inputs.resumed
       from session_inputs join sessions on sessions.id = session_inputs.session_id`,
  );
  const initial = inputs.filter((input) => input.title === CONVERSATION_TITLE);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.text, CONVERSATION_PROMPT);
  assert.equal(initial[0]?.outcome, "completed");
  const slow = inputs.filter((input) => input.title === SLOW_TITLE && input.text === SLOW_STEER_PROMPT);
  assert.equal(slow.length, 2, "Restarts and Resume must reuse input receipts, not submit duplicate prompts");
  assert.ok(slow.every((input) => input.resumed === 1));
  assert.ok(slow.some((input) => input.outcome === "completed"));
  assert.ok(inputs.some((input) => input.title === SLOW_TITLE
    && input.text === RECOVERY_PROMPT && input.outcome === "completed"));

  const eventRows = await querySqliteRows<{ type: string; count: number }>(
    "select type, count(*) as count from events group by type",
  );
  const eventCounts = new Map(eventRows.map((row) => [row.type, row.count]));
  for (const [type, minimum] of [
    ["user_input.resolved", 1],
    ["session.renamed", 1],
    ["session.archived", 1],
    ["session.model_changed", 1],
    ["session.reasoning_changed", 1],
    ["session.delegation_changed", 1],
  ] as const) {
    const count = eventCounts.get(type) ?? 0;
    assert.ok(count >= minimum, `${type} durable event count was ${count}`);
  }
  assert.equal(
    eventCounts.get("session.service_tier_changed") ?? 0,
    0,
    "Provider-default deterministic models must not persist a synthetic service tier",
  );
  assert.equal(eventCounts.get("approval.requested") ?? 0, 0, "Automatic review must never create manual approval requests");
  assert.equal(eventCounts.get("approval.resolved") ?? 0, 0, "Automatic review must never persist manual approval decisions");
  const reviewedCalls = await querySqliteRows<{ count: number }>(
    `select count(*) as count from events
       where type = 'tool.call_updated' and json_extract(payload_json, '$.metadata.review.decision') = 'allow'`,
  );
  assert.ok((reviewedCalls[0]?.count ?? 0) >= 1, "Automatic review decisions must be recorded with tool execution");
  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(LOCAL_API_KEY, "utf8")), false, "Local fixture key leaked into SQLite");
}

async function querySqliteRows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  const output = await runCaptured(
    ["/usr/bin/sqlite3", "-readonly", "-json", databasePath, sql],
    repositoryRoot,
    10_000,
  );
  const parsed = JSON.parse(output || "[]") as unknown;
  if (!Array.isArray(parsed) || parsed.some((row) => !isRecord(row))) {
    throw new Error("sqlite3 returned a non-row JSON result");
  }
  return parsed as T[];
}

async function captureFailureArtifacts(launch: DesktopLaunch, error: unknown): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const prefix = join(artifacts, launch.name);
  await Promise.allSettled([
    launch.page.screenshot({ path: `${prefix}.png`, fullPage: true }),
    launch.page.content().then((content) => writeFile(`${prefix}.html`, content, "utf8")),
    writeFile(`${prefix}.error.txt`, `${safeError(error)}\n`, "utf8"),
    writeFile(`${prefix}.stdout.txt`, launch.stdout.text(), "utf8"),
    writeFile(`${prefix}.stderr.txt`, launch.stderr.text(), "utf8"),
  ]);
  if (launch.traceActive) {
    launch.traceActive = false;
    await launch.app.context().tracing.stop({ path: `${prefix}.trace.zip` }).catch(() => undefined);
  }
}

async function resolveElectronExecutable(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("electron/package.json");
  const packageRoot = dirname(packageJsonPath);
  const pathFile = join(packageRoot, "path.txt");
  let relativeExecutable = await readFile(pathFile, "utf8").catch(() => "");
  let executable = relativeExecutable ? join(packageRoot, "dist", relativeExecutable.trim()) : "";
  if (!executable || !await exists(executable)) {
    logStep("installing the declared Electron development binary (cached after first run)");
    await runChecked([process.execPath, join(packageRoot, "install.js")], desktopRoot, 600_000);
    relativeExecutable = (await readFile(pathFile, "utf8")).trim();
    executable = join(packageRoot, "dist", relativeExecutable);
  }
  await access(executable);
  return executable;
}

async function runChecked(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await runCommand(command, cwd, timeoutMs);
}

async function runCaptured(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return (await runCommand(command, cwd, timeoutMs)).stdout;
}

async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const executable = command[0];
  if (!executable) throw new Error("Cannot spawn an empty command");
  const child = spawn(executable, command.slice(1), {
    cwd,
    env: stringEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stdoutPromise = collectStream(child.stdout);
  const stderrPromise = collectStream(child.stderr);
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code !== null) resolveExit(code);
      else rejectExit(new Error(`Command exited from signal ${signal ?? "unknown"}: ${command.join(" ")}`));
    });
  });
  let exitCode: number;
  try {
    exitCode = await withTimeout(exited, timeoutMs, command.join(" "));
  } catch (error) {
    signalSpawnedProcess(child, "SIGTERM");
    try {
      await withTimeout(exited, 2_000, `terminating ${executable}`);
    } catch {
      signalSpawnedProcess(child, "SIGKILL");
      await withTimeout(exited, 2_000, `reaping ${executable} after SIGKILL`).catch(() => undefined);
    }
    throw error;
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(
      `Command exited ${exitCode}: ${command.join(" ")}\nstdout:\n${bounded(stdout)}\nstderr:\n${bounded(stderr)}`,
    );
  }
  return { stdout, stderr };
}

function signalSpawnedProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal invalid command PID ${pid}`);
  }
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

async function collectStream(stream: Readable | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function terminateExactProcess(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Refusing to terminate invalid Electron PID ${pid}`);
  if (!processExists(pid)) return;
  process.kill(pid, "SIGTERM");
  try {
    await waitUntil(`Electron PID ${pid} to exit`, () => !processExists(pid), 3_000);
  } catch {
    if (processExists(pid)) process.kill(pid, "SIGKILL");
    await waitUntil(`Electron PID ${pid} to exit after SIGKILL`, () => !processExists(pid), 3_000);
  }
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = ACTION_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`, lastError === undefined ? undefined : { cause: lastError });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code !== "ESRCH";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function desktopLaunchEnvironment(
  fixture: DesktopFixtureEnvironment,
): Record<string, string> {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/zsh",
    TMPDIR: fixture.tempDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LC_CTYPE: "C.UTF-8",
    TERM: "dumb",
    HOME: fixture.home,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    CHILI_BUN_PATH: fixture.bunPath,
    ELECTRON_RENDERER_URL: fixture.rendererUrl,
    CHILI_DESKTOP_WORKSPACE: fixture.workspace,
    CHILI_DESKTOP_USER_DATA: fixture.userData,
    CHILI_DESKTOP_DISABLE_DEVTOOLS: "1",
    CHILI_DESKTOP_MODEL: fixture.model,
    CHILI_HOME: fixture.home,
    DEEPSEEK_API_KEY: LOCAL_API_KEY,
    DEEPSEEK_BASE_URL: fixture.providerBaseUrl,
    DEEPSEEK_MODEL: "deepseek-v4-pro",
  };
}

function assertDesktopLaunchEnvironmentIsolation(): void {
  const environment = desktopLaunchEnvironment({
    rendererUrl: "http://127.0.0.1:43123/renderer/index.html",
    workspace: "/fixture/workspace",
    userData: "/fixture/user-data",
    home: "/fixture/isolated-home",
    tempDir: "/fixture/isolated-tmp",
    bunPath: "/fixture/bin/bun",
    model: "deepseek",
    providerBaseUrl: "http://127.0.0.1:43123/",
  });
  assert.deepEqual(environment, {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/zsh",
    TMPDIR: "/fixture/isolated-tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LC_CTYPE: "C.UTF-8",
    TERM: "dumb",
    HOME: "/fixture/isolated-home",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    CHILI_BUN_PATH: "/fixture/bin/bun",
    ELECTRON_RENDERER_URL: "http://127.0.0.1:43123/renderer/index.html",
    CHILI_DESKTOP_WORKSPACE: "/fixture/workspace",
    CHILI_DESKTOP_USER_DATA: "/fixture/user-data",
    CHILI_DESKTOP_DISABLE_DEVTOOLS: "1",
    CHILI_DESKTOP_MODEL: "deepseek",
    CHILI_HOME: "/fixture/isolated-home",
    DEEPSEEK_API_KEY: LOCAL_API_KEY,
    DEEPSEEK_BASE_URL: "http://127.0.0.1:43123/",
    DEEPSEEK_MODEL: "deepseek-v4-pro",
  });
  const sentinel = process.env.CHILI_E2E_ENV_SENTINEL;
  assert.ok(sentinel, "Launch environment canary requires an externally injected sentinel");
  assert.equal(Object.values(environment).includes(sentinel), false, "External sentinel value reached electron.launch");
  for (const name of [
    "OPENAI_API_KEY",
    "MINIMAX_API_KEY",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "UNKNOWN_E2E_SECRET",
  ]) {
    assert.ok(process.env[name], `Launch environment canary requires external ${name}`);
    assert.equal(Object.hasOwn(environment, name), false, `${name} reached electron.launch`);
  }
}

function bounded(value: string, maximum = 64_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[truncated]`;
}

function unexpectedElectronStderr(value: string): string[] {
  const inspectorLines = [
    /^Debugger ending on ws:\/\/127\.0\.0\.1:\d+\/[\da-f-]+$/u,
    /^For help, see: https:\/\/nodejs\.org\/learn\/getting-started\/debugging$/u,
  ];
  return value.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !inspectorLines.some((pattern) => pattern.test(line)));
}

function startupElectronStderrAuditOffset(value: string, truncated = false): number {
  if (truncated) throw new Error("Electron startup stderr exceeded its bounded capture");
  if (value.length === 0) return 0;
  const widgetHostStartupPair = /^\[(\d+):\d{4}\/\d{6}\.\d{6}:ERROR:mojo\/public\/cpp\/bindings\/lib\/interface_endpoint_client\.cc:748\] Message 6 rejected by interface blink\.mojom\.WidgetHost\r?\n\[\1:\d{4}\/\d{6}\.\d{6}:ERROR:mojo\/public\/cpp\/bindings\/lib\/interface_endpoint_client\.cc:748\] Message 7 rejected by interface blink\.mojom\.WidgetHost(?:\r?\n)?$/u;
  if (widgetHostStartupPair.test(value)) return value.length;
  throw new Error(`Unexpected Electron startup stderr:\n${bounded(value)}`);
}

function assertStartupElectronStderrClassification(): void {
  const source = "mojo/public/cpp/bindings/lib/interface_endpoint_client.cc:748";
  const first = `[41042:0830/020754.868480:ERROR:${source}] Message 6 rejected by interface blink.mojom.WidgetHost`;
  const second = `[41042:0830/020754.868498:ERROR:${source}] Message 7 rejected by interface blink.mojom.WidgetHost`;
  const pair = `${first}\n${second}\n`;
  assert.equal(startupElectronStderrAuditOffset(""), 0);
  assert.equal(startupElectronStderrAuditOffset(pair), pair.length);
  assert.deepEqual(unexpectedElectronStderr(pair), [first, second], "WidgetHost must remain fatal outside startup");
  for (const invalid of [
    `${first}\n`,
    `${second}\n${first}\n`,
    `${first}\n[41043:0830/020754.868498:ERROR:${source}] Message 7 rejected by interface blink.mojom.WidgetHost\n`,
    `${first.replace("Message 6", "Message 8")}\n${second}\n`,
    `${first}\n${second.replace("blink.mojom.WidgetHost", "blink.mojom.FrameHost")}\n`,
    `${first.replace("interface_endpoint_client.cc:748", "interface_endpoint_client.cc:749")}\n${second}\n`,
    `${first.replace(":ERROR:", ":WARNING:")}\n${second}\n`,
    `${first}\nDesktop product failure\n${second}\n`,
  ]) {
    assert.throws(() => startupElectronStderrAuditOffset(invalid), /Unexpected Electron startup stderr/u);
  }
  assert.throws(
    () => startupElectronStderrAuditOffset(pair, true),
    /exceeded its bounded capture/u,
  );
  const overflow = new BoundedLog(4);
  overflow.append("12345");
  assert.equal(overflow.text(), "1234");
  assert.equal(overflow.isTruncated(), true);
  assert.throws(
    () => startupElectronStderrAuditOffset(overflow.text(), overflow.isTruncated()),
    /exceeded its bounded capture/u,
  );
}

function readableSettlement(stream: Readable | null | undefined): Promise<Error | undefined> {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve(undefined);
  return new Promise<Error | undefined>((resolvePromise) => {
    let settled = false;
    const cleanup = (): void => {
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(error);
    };
    const onEnd = (): void => settle();
    const onClose = (): void => settle();
    const onError = (error: Error): void => settle(error);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logStep(message: string): void {
  process.stdout.write(`[electron-e2e] ${message}\n`);
}
