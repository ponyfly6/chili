import { DesktopReadingSettings } from "./reading-settings.js";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ChiliEvent } from "@chili/protocol";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  nativeTheme,
} from "electron";
import { safeDesktopErrorMessage as safeLogMessage } from "../shared/safe-error.js";
import { getDesktopBuildInfo } from "../shared/build-info.js";
import { parseDesktopResponse } from "../shared/contracts.js";
import { BootstrapLifecycleGuard } from "./bootstrap-lifecycle.js";
import { DesktopAppearanceSettings } from "./appearance-settings.js";
import { DesktopControlService } from "./control-service.js";
import { DesktopProjectManager } from "./project-manager.js";
import { DesktopProjectSettings } from "./project-settings.js";
import { DesktopRemoteControlManager } from "./remote-control-manager.js";
import { DesktopRemoteSettings } from "./remote-control-settings.js";
import { DeferredElectronQuit } from "./deferred-electron-quit.js";
import { registerDesktopIpc, type DesktopIpcController } from "./ipc.js";
import { shouldUseMockKeychain } from "./keychain-policy.js";
import { DesktopNotificationGate } from "./notifications.js";
import { processGroupExists } from "./process-groups.js";
import {
  containsRendererCredentialMaterial,
  RENDERER_CREDENTIAL_PATTERN_SOURCE,
} from "./renderer-leak-audit.js";
import { SidecarManager } from "./sidecar-manager.js";
import { armShutdownDeadlines, retryShutdownContainment } from "./shutdown-containment.js";
import {
  configureSessionSecurity,
  createDesktopWindow,
  installRendererProtocol,
  loadDesktopWindow,
} from "./window.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const isolatedUserData = process.env.CHILI_DESKTOP_USER_DATA?.trim();
if (isolatedUserData && isAbsolute(isolatedUserData)) app.setPath("userData", isolatedUserData);
else if (getDesktopBuildInfo().channel === "preview") {
  // Preview must never hand a new launch to an older Chili instance's lock.
  app.setPath("userData", resolve(app.getPath("appData"), "Chili Preview"));
}
// Every local package is re-signed ad-hoc, so macOS sees each rebuild as a new
// Keychain ACL principal. The renderer stores no secrets in Chromium storage;
// stable signed release builds continue to use the system Keychain.
if (shouldUseMockKeychain({
  platform: process.platform,
  localAdHocBuild: __CHILI_DESKTOP_LOCAL_AD_HOC_BUILD__,
  smokeMode: process.env.CHILI_DESKTOP_SMOKE === "1",
})) app.commandLine.appendSwitch("use-mock-keychain");

let mainWindow: BrowserWindow | undefined;
let sidecar: SidecarManager | undefined;
let control: DesktopControlService | undefined;
let remoteControl: DesktopRemoteControlManager | undefined;
let desktopIpc: DesktopIpcController | undefined;
let projects: DesktopProjectManager | undefined;
const bootstrapLifecycle = new BootstrapLifecycleGuard();
const deferredElectronQuit = new DeferredElectronQuit(exitDesktopProcess);
let shutdownFinished = false;
let forcedExitStarted = false;
let exitCode = 0;

const CONTAINMENT_DEADLINE_MS = 9_000;
const QUIT_WATCHDOG_MS = 12_000;
const SHUTDOWN_RETRY_DELAY_MS = 250;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  app.on("window-all-closed", () => {
    if (!bootstrapLifecycle.quitStarted) app.quit();
  });
  app.on("activate", () => focusMainWindow());
  app.on("before-quit", (event) => {
    if (!deferredElectronQuit.defer(event)) return;
    beginShutdown();
  });
  process.once("SIGINT", () => requestQuit(130));
  process.once("SIGTERM", () => requestQuit(143));
  void bootstrap().catch((error) => {
    if (!bootstrapLifecycle.canContinue()) return;
    console.error("Chili desktop failed to start", safeLogMessage(error));
    requestQuit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (!bootstrapLifecycle.canContinue()) return;
  smokeStage("app-ready");
  configureSessionSecurity();
  await installRendererProtocol();
  if (!bootstrapLifecycle.canContinue()) return;

  const appearanceSettings = new DesktopAppearanceSettings(resolve(app.getPath("userData"), "appearance-settings.json"));
  nativeTheme.themeSource = await appearanceSettings.initialize();
  const readingSettings = new DesktopReadingSettings(resolve(app.getPath("userData"), "reading-settings.json"));
  await readingSettings.initialize();
  if (!bootstrapLifecycle.canContinue()) return;

  // The empty runtime lets connection setup remain available before a project is opened.
  const createdSidecar = new SidecarManager({ repositoryRoot, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  sidecar = createdSidecar;
  control = new DesktopControlService({
    sidecar: createdSidecar,
    selectWorkspace,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError: (error) => console.error("Desktop control error", safeLogMessage(error)),
  });
  const remoteSettings = new DesktopRemoteSettings({
    settingsPath: resolve(app.getPath("userData"), "remote-control-settings.json"),
    environment: process.env,
    defaultWebRoot: app.isPackaged
      ? resolve(process.resourcesPath, "control-web")
      : resolve(repositoryRoot, "apps/control-web/dist"),
    chooseTlsFiles,
  });
  await remoteSettings.initialize();
  if (!bootstrapLifecycle.canContinue()) return;
  remoteControl = new DesktopRemoteControlManager({
    controlService: () => control!,
    settings: remoteSettings,
  });

  projects = new DesktopProjectManager({
    settings: new DesktopProjectSettings(resolve(app.getPath("userData"), "desktop-state.json")),
    chooseDirectory: selectWorkspace,
    beforeActivate: () => remoteControl?.disable() ?? Promise.resolve(),
    activated: (runtime) => {
      sidecar = runtime.sidecar as SidecarManager;
      control = runtime.control as DesktopControlService;
      remoteControl?.observeSidecar(sidecar.state(), sidecar.currentGeneration());
    },
    publish: (event) => desktopIpc?.publish(event),
    resync: () => desktopIpc?.requestResync("source_cursor"),
    createRuntime: (project) => {
      const gate = new DesktopNotificationGate();
      let projectControl: DesktopControlService;
      const manager = new SidecarManager({
        repositoryRoot, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
        onState: (state, generation) => {
          gate.observeSidecarState(state.sidecar.phase, generation);
          projectControl.observeState(state, generation);
          if (projects?.activeProjectId() === project.id) remoteControl?.observeSidecar(state, generation);
          projects?.observeState(project.id);
        },
        onEvent: (event, generation) => {
          projectControl.observeEvent(event, generation);
          projects?.observeEvent(project.id, event);
          maybeNotify(event, generation, gate, project.id);
        },
        onResync: () => {
          if (projects?.activeProjectId() === project.id) desktopIpc?.requestResync("source_cursor");
        },
        onLog: (stream, text) => (stream === "stderr" ? console.error : console.log)(`[sidecar:${stream}] ${text}`),
      });
      projectControl = new DesktopControlService({
        sidecar: manager,
        selectWorkspace: async () => undefined,
        persistWorkspace: async () => undefined,
        emitQueue: (sessionId, count) => projects?.observeQueue(project.id, sessionId, count),
        onError: (error) => console.error("Desktop control error", safeLogMessage(error)),
      });
      return { sidecar: manager, control: projectControl };
    },
  });
  await projects.initialize();
  if (!bootstrapLifecycle.canContinue()) return;
  const createdWindow = createDesktopWindow();
  if (!bootstrapLifecycle.canContinue()) {
    createdWindow.destroy();
    return;
  }
  mainWindow = createdWindow;
  const desktopProjects = projects;
  const desktopRemote = remoteControl;
  desktopIpc = registerDesktopIpc(mainWindow, {
    async invoke(request) {
      if (request.type === "reading.get") return parseDesktopResponse(request, await readingSettings.get());
      if (request.type === "reading.set") return parseDesktopResponse(request, await readingSettings.set({ expandWork: request.expandWork, autoOpenResults: request.autoOpenResults }));
      if (request.type === "appearance.get") return parseDesktopResponse(request, { theme: await appearanceSettings.getTheme() });
      if (request.type === "appearance.set") {
        const theme = await appearanceSettings.setTheme(request.theme);
        nativeTheme.themeSource = theme;
        return parseDesktopResponse(request, { theme });
      }
      return desktopProjects.invoke(request);
    },
  }, {
    invoke: (request) => {
      if (desktopProjects.isSelecting() && request.type !== "status" && request.type !== "disable") {
        return Promise.reject(new Error("Project selection is in progress"));
      }
      return desktopRemote.invoke(request);
    },
  });
  createdWindow.once("closed", () => {
    desktopIpc?.dispose();
    desktopIpc = undefined;
    mainWindow = undefined;
  });
  await loadDesktopWindow(mainWindow);
  if (!bootstrapLifecycle.canContinue()) return;
  smokeStage("window-loaded");

  const initialWorkspace = process.env.CHILI_DESKTOP_WORKSPACE?.trim();
  const savedProjectId = desktopProjects.activeProjectId();
  if (initialWorkspace || savedProjectId) {
    try {
      if (!bootstrapLifecycle.canContinue()) return;
      smokeStage("sidecar-starting");
      if (initialWorkspace) await desktopProjects.add(initialWorkspace);
      else if (savedProjectId) await desktopProjects.activate(savedProjectId);
      if (!bootstrapLifecycle.canContinue()) return;
      smokeStage("sidecar-healthy");
    } catch (error) {
      if (!bootstrapLifecycle.canContinue()) return;
      console.error("Failed to start project runtime", safeLogMessage(error));
    }
  }

  if (process.env.CHILI_DESKTOP_SMOKE === "1" && process.env.CHILI_DESKTOP_PARENT_LOSS_FIXTURE_PATH) {
    // The outer smoke owns this fixture's SIGKILL. Do not race it with the
    // normal renderer smoke scenario's app.quit() and graceful sidecar stop.
    smokeStage("parent-loss-ready");
    return;
  }

  if (process.env.CHILI_DESKTOP_SMOKE === "1") {
    try {
      if (!bootstrapLifecycle.canContinue()) return;
      smokeStage("scenario-starting");
      await runSmokeScenario();
      if (!bootstrapLifecycle.canContinue()) return;
      // Exercise the same native app.quit() path as Command-Q. The contained
      // shutdown completion below must remain safe when before-quit has
      // already cancelled an in-flight Electron quit attempt.
      app.quit();
    } catch (error) {
      if (!bootstrapLifecycle.canContinue()) return;
      console.error("CHILI_DESKTOP_SMOKE_FAILURE", safeLogMessage(error));
      requestQuit(1);
    }
  }
}

/** The renderer requests a selection, never supplies a filesystem path. */
async function chooseTlsFiles(): Promise<{ certificatePath: string; privateKeyPath: string } | undefined> {
  async function choose(title: string): Promise<string | undefined> {
    if (!mainWindow || mainWindow.isDestroyed() || !bootstrapLifecycle.canContinue()) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title,
      properties: ["openFile"],
      filters: [{ name: "TLS PEM files", extensions: ["pem", "crt", "cer", "key"] }, { name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }
  const certificatePath = await choose("Choose the HTTPS certificate for your phone connection");
  if (!certificatePath) return undefined;
  const privateKeyPath = await choose("Choose the matching private key — it stays on this computer");
  return privateKeyPath ? { certificatePath, privateKeyPath } : undefined;
}

async function selectWorkspace(): Promise<string | undefined> {
  const defaultPath = sidecar?.currentWorkspace();
  const options: Electron.OpenDialogOptions = {
    title: "Choose a Chili workspace",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function maybeNotify(event: ChiliEvent, generation: number, gate: DesktopNotificationGate, projectId: string): void {
  const window = mainWindow;
  if (!window || (window.isFocused() && projects?.activeProjectId() === projectId) || !Notification.isSupported()) return;
  const content = gate.notificationForEvent(event, generation);
  if (!content) return;
  const notification = new Notification({ ...content, silent: false });
  notification.on("click", () => {
    focusMainWindow();
    void projects?.activate(projectId).catch(() => undefined);
  });
  notification.show();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestQuit(code: number): void {
  exitCode = Math.max(exitCode, code);
  if (!app.isReady()) {
    bootstrapLifecycle.beginShutdown();
    app.exit(exitCode);
    return;
  }
  beginShutdown();
}

function beginShutdown(): void {
  if (!bootstrapLifecycle.beginShutdown()) return;
  const controlService = control;
  // Resolve late renderer invokes with a typed shutdown sentinel before
  // aborting the control plane. Throwing or removing the handler makes
  // Electron log the expected close race as a main-process error.
  desktopIpc?.beginShutdown();
  const remoteShutdown = remoteControl?.disable() ?? Promise.resolve();
  controlService?.beginShutdown();
  projects?.beginShutdown();
  smokeStage("shutdown-started");
  const manager = sidecar;
  let stopAttempts = 0;
  let lastStopError: unknown;
  const forceShutdown = (error: unknown, attempts: number): void => {
    if (shutdownFinished || forcedExitStarted) return;
    console.error(
      `Failed to contain Chili desktop processes before the ${QUIT_WATCHDOG_MS}ms quit watchdog after ${attempts} attempt(s)`,
      safeLogMessage(error),
    );
    smokeStage("sidecar-stop-failed");
    smokeStage("shutdown-timeout");
    finishShutdown(true);
  };
  const deadlines = armShutdownDeadlines({
    containmentDeadlineMs: CONTAINMENT_DEADLINE_MS,
    quitWatchdogMs: QUIT_WATCHDOG_MS,
    onContainmentDeadline: () => {
      if (shutdownFinished || forcedExitStarted) return;
      console.error(
        `Chili desktop process containment exceeded ${CONTAINMENT_DEADLINE_MS}ms after ${stopAttempts} attempt(s); `
        + `final containment continues until the ${QUIT_WATCHDOG_MS}ms quit watchdog`,
        safeLogMessage(
          lastStopError ?? new Error("The active sidecar containment attempt is still pending"),
        ),
      );
    },
    onQuitWatchdog: () => {
      forceShutdown(
        lastStopError ?? new Error("The active desktop process containment attempt did not settle before the watchdog"),
        stopAttempts,
      );
    },
  });
  void retryShutdownContainment({
    deadlineMs: QUIT_WATCHDOG_MS,
    retryDelayMs: SHUTDOWN_RETRY_DELAY_MS,
    stop: async () => {
      stopAttempts += 1;
      try {
        await Promise.all([
          remoteShutdown,
          projects?.stop() ?? manager?.stop() ?? Promise.resolve(),
          controlService?.containMainProcesses() ?? Promise.resolve(),
        ]);
      } catch (error) {
        lastStopError = error;
        throw error;
      }
    },
  }).then((result) => {
    if (result.status === "contained") {
      deadlines.cancel();
      if (forcedExitStarted) return;
      smokeStage("sidecar-stopped");
      finishShutdown(false);
      return;
    }
    lastStopError = result.error;
  }, (error: unknown) => {
    lastStopError = error;
    console.error("Chili desktop process containment retry loop failed", safeLogMessage(error));
  });
}

function finishShutdown(force: boolean): void {
  if (force) {
    if (forcedExitStarted) return;
    forcedExitStarted = true;
    try {
      projects?.forceContainGitProcessGroups();
      control?.forceContainGitProcessGroups();
    } catch (error) {
      console.error("Failed to synchronously signal every Chili Git process group", safeLogMessage(error));
    }
    smokeStage("forced-process-exit");
    exitDesktopProcess(exitCode);
    return;
  }
  if (shutdownFinished) return;
  shutdownFinished = true;
  desktopIpc?.dispose();
  desktopIpc = undefined;
  process.exitCode = exitCode;
  smokeStage("shutdown-complete");
  // Electron's public exit APIs are not reliable completion primitives after
  // a native quit was cancelled in before-quit: Electron can keep a windowless
  // main process alive indefinitely. All owned resources are contained at this
  // point, so the low-level process exit is the bounded completion.
  deferredElectronQuit.complete(exitCode);
}

function exitDesktopProcess(code: number): never {
  const reallyExit = (process as NodeJS.Process & { reallyExit?: (exitCode?: number) => never }).reallyExit;
  if (reallyExit) return reallyExit.call(process, code);
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL returned without terminating the desktop process");
}

async function runSmokeScenario(): Promise<void> {
  if (!mainWindow || !sidecar || !control) throw new Error("Desktop smoke started before the app was initialized");
  const controlService = control;
  if (sidecar.state().sidecar.phase !== "healthy") throw new Error("Packaged sidecar did not pass its health gate");
  const sidecarPid = sidecar.currentSidecarPidForSmoke();
  if (!sidecarPid) throw new Error("Packaged sidecar did not report a PID");
  const executable = resolve(process.resourcesPath, "chili-sidecar");
  if (app.isPackaged) {
    const executableStat = await stat(executable);
    if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) throw new Error("Packaged sidecar is not executable");
  }

  const rendererNeedlesValue: unknown = JSON.parse(process.env.CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES ?? "null");
  if (!Array.isArray(rendererNeedlesValue) || rendererNeedlesValue.length === 0 || rendererNeedlesValue.length > 64
    || rendererNeedlesValue.some((value) => typeof value !== "string" || value.length === 0 || value.length > 8_000)
    || new Set(rendererNeedlesValue).size !== rendererNeedlesValue.length) {
    throw new Error("Desktop smoke renderer canary fixture was invalid");
  }
  const rendererNeedlesSource = JSON.stringify(JSON.stringify(rendererNeedlesValue));

  const result: unknown = await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.chiliDesktop;
    const leakNeedles = JSON.parse(${rendererNeedlesSource});
    const encoder = new TextEncoder();
    const maximumValueBytes = 12_000_000;
    const maximumTotalBytes = 64_000_000;
    let checkedValues = 0;
    let checkedBytes = 0;
    let envelopeCount = 0;
    let credentialChecks = 0;
    const credentialPattern = new RegExp(${JSON.stringify(RENDERER_CREDENTIAL_PATTERN_SOURCE)}, "iu");
    const serializeBounded = (label, value) => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("Renderer leak audit could not serialize " + label);
      const bytes = encoder.encode(serialized).byteLength;
      if (bytes > maximumValueBytes || checkedBytes + bytes > maximumTotalBytes) {
        throw new Error("Renderer leak audit exceeded its byte budget at " + label);
      }
      checkedValues += 1;
      checkedBytes += bytes;
      return serialized;
    };
    const matchingNeedleCount = (serialized) => leakNeedles.reduce(
      (count, needle) => count + (serialized.includes(needle) ? 1 : 0),
      0,
    );
    const inspectLiveValue = (label, value) => {
      const serialized = serializeBounded(label, value);
      credentialChecks += 1;
      if (matchingNeedleCount(serialized) !== 0) {
        throw new Error("Sensitive canary reached the renderer through " + label);
      }
      if (credentialPattern.test(serialized)) {
        throw new Error("A sidecar credential or endpoint reached the renderer through " + label);
      }
    };
    const fixtureSerialized = JSON.stringify({ values: leakNeedles });
    const fixtureNeedlesDetected = matchingNeedleCount(fixtureSerialized);
    if (fixtureNeedlesDetected !== leakNeedles.length) {
      throw new Error("Renderer leak audit did not detect every injected fixture needle");
    }
    const credentialFixtureVerified = credentialPattern.test(
      JSON.stringify({ endpoint: "http://127.0.0.1:1", authorization: "Bearer smoke-fixture" }),
    );
    if (!credentialFixtureVerified) throw new Error("Renderer credential leak audit fixture was not detected");

    const state = await api.invoke({ type: "app.state" });
    inspectLiveValue("app.state", state);
    const before = await api.invoke({ type: "sessions.list" });
    inspectLiveValue("sessions.list", before);
    const created = await api.invoke({ type: "sessions.create" });
    inspectLiveValue("sessions.create", created);
    const seen = [];
    let assistantSeen = false;
    let idleSeen = false;
    let unsubscribe;
    const complete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for streamed assistant events")), 30000);
      unsubscribe = api.subscribe((frame) => {
        try {
          inspectLiveValue("event envelope", frame);
          envelopeCount += 1;
          const envelope = frame.event;
          if (envelope.type !== "runtime.event" || envelope.event.sessionId !== created.sessionId) return;
          seen.push(envelope.event.type);
          if (envelope.event.type === "message.created" && envelope.event.payload.role === "assistant") assistantSeen = true;
          if (envelope.event.type === "session.status_changed" && envelope.event.payload.status === "idle") idleSeen = true;
          if (!assistantSeen || !idleSeen) return;
          clearTimeout(timeout);
          resolve(undefined);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    const sent = await api.invoke({ type: "session.send", sessionId: created.sessionId, text: "desktop smoke echo", mode: "queue" });
    inspectLiveValue("session.send", sent);
    try {
      await complete;
    } finally {
      unsubscribe();
    }
    const snapshot = await api.invoke({ type: "session.snapshot", sessionId: created.sessionId });
    inspectLiveValue("session.snapshot", snapshot);
    return {
      sessionId: created.sessionId,
      bridgeKeys: Object.keys(api).sort(),
      sessionCountBefore: before.length,
      seen,
      assistantSeen,
      idleSeen,
      snapshotEventCount: snapshot.events.length,
      leakAudit: {
        passed: true,
        fixtureVerified: true,
        fixtureNeedleCount: leakNeedles.length,
        fixtureNeedlesDetected,
        checkedValues,
        checkedBytes,
        envelopeCount,
        credentialFixtureVerified,
        credentialChecks,
      },
    };
  })()`, true);
  const serialized = JSON.stringify(result);
  if (containsRendererCredentialMaterial(serialized)) {
    throw new Error("A sidecar credential or endpoint crossed into the renderer");
  }
  const record = result as Record<string, unknown>;
  if (record.assistantSeen !== true || record.idleSeen !== true || !Array.isArray(record.bridgeKeys)
    || record.bridgeKeys.join(",") !== "invoke,subscribe") {
    throw new Error("Renderer smoke did not observe the expected capability bridge and event stream");
  }
  const blockedGitPid = process.env.CHILI_DESKTOP_SMOKE_BLOCKED_GIT === "1"
    ? await startBlockedGitSmokeFixture(controlService, record.sessionId)
    : undefined;
  process.stdout.write(`CHILI_DESKTOP_SMOKE_RESULT ${JSON.stringify({
    packaged: app.isPackaged,
    sidecarPid,
    sidecarExecutable: app.isPackaged,
    renderer: result,
    ...(blockedGitPid ? { blockedGitPid } : {}),
  })}\n`);
}

async function startBlockedGitSmokeFixture(
  controlService: DesktopControlService,
  sessionIdValue: unknown,
): Promise<number> {
  if (typeof sessionIdValue !== "string" || sessionIdValue.length === 0 || sessionIdValue.length > 256) {
    throw new Error("Desktop blocked-Git smoke fixture did not receive a valid session ID");
  }
  let operationSettled = false;
  const operation = controlService.invoke({
    type: "diff.get",
    scope: "workspace",
    sessionId: sessionIdValue,
  });
  void operation.then(
    () => {
      operationSettled = true;
    },
    () => {
      operationSettled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const processGroupIds = controlService.activeGitProcessGroupIdsForSmoke();
    if (processGroupIds.length > 1) {
      throw new Error(`Desktop blocked-Git smoke registered ${processGroupIds.length} process groups; expected one`);
    }
    const leaderPid = processGroupIds[0];
    if (leaderPid && processGroupExists(leaderPid)) {
      process.stdout.write(`CHILI_DESKTOP_SMOKE_BLOCKED_GIT_PID ${leaderPid}\n`);
      // Keep the smoke-only fixture alive long enough for the independent
      // package runner to observe the real PID/PGID via ps. Recheck after the
      // dwell so a command that merely started and exited cannot pass.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      if (
        controlService.activeGitProcessGroupIdsForSmoke().includes(leaderPid)
        && processGroupExists(leaderPid)
      ) return leaderPid;
      throw new Error("Desktop blocked-Git smoke process group did not remain blocked for observation");
    }
    if (operationSettled) throw new Error("Desktop blocked-Git smoke diff settled before its process group was observed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Desktop blocked-Git smoke did not register a live process group within 5000ms");
}

function smokeStage(stage: string): void {
  if (process.env.CHILI_DESKTOP_SMOKE === "1") process.stdout.write(`CHILI_DESKTOP_SMOKE_STAGE ${stage}\n`);
}
