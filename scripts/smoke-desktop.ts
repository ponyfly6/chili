import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "utf8");
const FUSE_DISABLED = "0".charCodeAt(0);
const FUSE_ENABLED = "1".charCodeAt(0);
const SIDECAR_CONTAINMENT_GRACE_MS = 6_000;
const SIDECAR_CREDENTIAL_FRAME_PREFIX = "chili.sidecar.credential.v1:";
const ELECTRON_HARDENED_RUNTIME_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;
const KNOWN_FUSES = [
  ["RunAsNode", false],
  ["EnableCookieEncryption", false],
  ["EnableNodeOptionsEnvironmentVariable", false],
  ["EnableNodeCliInspectArguments", false],
  ["EnableEmbeddedAsarIntegrityValidation", true],
  ["OnlyLoadAppFromAsar", true],
  ["LoadBrowserProcessSpecificV8Snapshot", false],
  ["GrantFileProtocolExtraPrivileges", false],
  ["WasmTrapHandlers", true],
] as const;

interface DesktopSmokeResult {
  packaged?: boolean;
  sidecarPid?: number;
  sidecarExecutable?: boolean;
  blockedGitPid?: number;
  renderer?: {
    assistantSeen?: boolean;
    idleSeen?: boolean;
    bridgeKeys?: string[];
    snapshotEventCount?: number;
    leakAudit?: {
      passed?: boolean;
      fixtureVerified?: boolean;
      fixtureNeedleCount?: number;
      fixtureNeedlesDetected?: number;
      checkedValues?: number;
      checkedBytes?: number;
      envelopeCount?: number;
      credentialFixtureVerified?: boolean;
      credentialChecks?: number;
    };
  };
}

interface PackagedLaunchResult {
  sidecarPid: number;
  shutdownExitMs: number;
  blockedGitPid?: number;
}

interface ParentLossFixture {
  sidecarPid: number;
  toolProcessGroupPid: number;
  inheritedPid: number;
}

interface SensitiveNeedle {
  label: string;
  value: string;
}

interface PackagedProcess {
  pid: number;
  processGroupPid: number;
  processGroupIsSafe: boolean;
  isSidecar: boolean;
  command: string;
  line: string;
}

if (process.platform !== "darwin") throw new Error("Desktop package smoke currently requires macOS");
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`Unsupported desktop smoke architecture: ${process.arch}`);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedReleaseDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
const expectedMachOSlice = process.arch === "arm64" ? "arm64" : "x86_64";
const temporaryRoot = await mkdtemp(join(tmpdir(), "chili-desktop-smoke-"));
const releaseRoot = resolve(repositoryRoot, "apps/desktop/release");
const workspace = join(temporaryRoot, "workspace");
const userData = join(temporaryRoot, "user-data");
const hardCrashUserData = join(temporaryRoot, "hard-crash-user-data");
const isolatedChiliHome = join(temporaryRoot, "chili-home");
const parentLossFixturePath = join(temporaryRoot, "parent-loss-fixture.json");
const blockedGitIncludePath = join(temporaryRoot, "blocked-git-config.fifo");
const canaryId = randomBytes(16).toString("hex");
const secretCanary = `chili-desktop-secret-canary-${canaryId}`;
const inheritedTokenCanary = `chili-desktop-inherited-token-canary-${canaryId}`;
const pathCanary = join(temporaryRoot, `path-canary-${canaryId}`);
const artifactSensitiveNeedles = uniqueNeedles([
  { label: "secret canary", value: secretCanary },
  { label: "inherited desktop token canary", value: inheritedTokenCanary },
  ...pathNeedles("path canary", pathCanary),
  ...pathNeedles("isolated Chili home", isolatedChiliHome),
  ...pathNeedles("source worktree", repositoryRoot),
  ...pathNeedles("builder home", homedir()),
  ...pathNeedles("builder temporary directory", tmpdir()),
]);
// Build tools legitimately print their input/output paths, including the source
// checkout, builder home, and temporary directory. Keep those stronger path
// needles for the packaged artifact and renderer audits, while command output
// is checked for only values injected as confidential smoke canaries.
const commandOutputSensitiveNeedles = uniqueNeedles([
  { label: "secret canary", value: secretCanary },
  { label: "inherited desktop token canary", value: inheritedTokenCanary },
  ...pathNeedles("path canary", pathCanary),
  ...pathNeedles("isolated Chili home", isolatedChiliHome),
]);
const rendererSensitiveNeedles = uniqueNeedles([
  { label: "secret canary", value: secretCanary },
  ...pathNeedles("path canary", pathCanary),
  ...pathNeedles("isolated Chili home", isolatedChiliHome),
  ...pathNeedles("source worktree", repositoryRoot),
]);
const hostVisibleCredentialNeedles = uniqueNeedles([
  { label: "desktop token environment variable", value: "CHILI_DESKTOP_TOKEN=" },
  { label: "sidecar credential frame", value: SIDECAR_CREDENTIAL_FRAME_PREFIX },
  { label: "inherited desktop token canary", value: inheritedTokenCanary },
]);
let packagedSidecar: string | undefined;
let successMessage: string | undefined;
let smokeFailure: unknown;
const activeDetachedGroups = new Map<number, SpawnedProcess>();
const detachedGroupCleanup = new Map<number, Promise<void>>();
const activeDirectProcesses = new Map<number, SpawnedProcess>();
const directProcessCleanup = new Map<number, Promise<void>>();
const containmentPreparation = new Map<number, () => void>();
const containmentCleanup = new Map<number, Promise<void>>();
const observedBlockedGitProcessGroups = new Set<number>();
let smokeGitConfigBeforeBlock: string | undefined;
let resourceCleanup: Promise<unknown[]> | undefined;
let failedReleaseCleanup: Promise<unknown[]> | undefined;
let terminationSignal: "SIGINT" | "SIGTERM" | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (terminationSignal) return;
    terminationSignal = signal;
    void cleanupSmokeResources().then(async (cleanup) => {
      const release = await cleanupFailedRelease();
      if (cleanup.length + release.length > 0) process.stderr.write("Desktop smoke interruption cleanup failed\n");
      process.exit(signal === "SIGINT" ? 130 : 143);
    }).catch(() => {
      process.stderr.write("Desktop smoke interruption cleanup failed\n");
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(hardCrashUserData, { recursive: true });
  await mkdir(isolatedChiliHome, { recursive: true });
  await mkdir(pathCanary, { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Chili desktop smoke workspace\n", "utf8");
  await initializeSmokeGitWorkspace();
  await assertOutputOverflowCleanupFixture();
  await assertProcessGroupCleanupFixture();
  await assertSidecarContainmentGraceFixture();

  // A clean output directory makes it impossible to accidentally accept a
  // stale mac-* package from another architecture or an earlier source tree.
  await rm(releaseRoot, { recursive: true, force: true });
  const buildStartedAt = Date.now();
  await runChecked(
    ["bun", "run", "desktop:package:dir"],
    repositoryRoot,
    300_000,
    smokeCanaryEnvironment(),
  );

  const application = await findSinglePackagedApplication(releaseRoot);
  const applicationName = basename(application, ".app");
  const executable = join(application, "Contents", "MacOS", applicationName);
  const resources = join(application, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  packagedSidecar = join(resources, "chili-sidecar");
  const electronFramework = join(
    application,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );

  await assertFresh("application bundle", application, buildStartedAt);
  await assertFresh("ASAR archive", asar, buildStartedAt);
  await assertFresh("sidecar executable", packagedSidecar, buildStartedAt);
  await assertExecutable(executable);
  await assertExecutable(packagedSidecar);
  await assertMachOSlices(executable, packagedSidecar);
  await assertCodesigned(application, packagedSidecar);
  await assertAsarContents(asar);
  await assertAsarIntegrity(application, asar);
  await assertFuseWire(electronFramework);
  await assertNoEmbeddedText(application, artifactSensitiveNeedles);

  const sidecarPids: number[] = [];
  const shutdownExitTimes: number[] = [];
  let blockedGitPid: number | undefined;
  for (let launch = 1; launch <= 2; launch += 1) {
    if (launch === 2) await enableBlockedGitFixture();
    const result = await runPackagedLaunch(executable, launch);
    const { sidecarPid, shutdownExitMs } = result;
    sidecarPids.push(sidecarPid);
    shutdownExitTimes.push(shutdownExitMs);
    if (result.blockedGitPid !== undefined) blockedGitPid = result.blockedGitPid;
    if (await processStillExists(sidecarPid, 5_000)) {
      throw new Error(`Launch ${launch} sidecar process ${sidecarPid} survived Electron app exit`);
    }
    const survivors = await waitForNoPackagedProcesses(userData, packagedSidecar, 5_000);
    if (survivors.length > 0) {
      throw new Error(`Launch ${launch} left packaged processes alive:\n${survivors.join("\n")}`);
    }
  }
  await disableBlockedGitFixture();

  const hardCrashFixture = await runParentHardCrashLaunch(executable);

  successMessage = `desktop smoke passed: fresh ${expectedMachOSlice} ad-hoc package, strict fuses, `
      + `minimal integrity-verified ASAR, renderer leak audit, `
      + `hardened signatures with an entitlement-free sidecar, host credential audit, `
      + `two clean launches (sidecars ${sidecarPids.join(", ")}; `
      + `shutdown exits ${shutdownExitTimes.join("ms, ")}ms; blocked Git group ${blockedGitPid}), `
      + `and parent hard-crash containment `
      + `(sidecar ${hardCrashFixture.sidecarPid}, tool group ${hardCrashFixture.toolProcessGroupPid}, `
      + `inherited ${hardCrashFixture.inheritedPid})\n`;
} catch (error) {
  smokeFailure = error;
}

const cleanupFailures = await cleanupSmokeResources();
if (terminationSignal) {
  // The signal handler owns the final exit after the shared cleanup promise;
  // do not race it with a top-level AggregateError.
  await new Promise<never>(() => undefined);
}
if (smokeFailure || cleanupFailures.length > 0) {
  cleanupFailures.push(...await cleanupFailedRelease());
}
if (smokeFailure || cleanupFailures.length > 0) {
  throw new AggregateError(
    [smokeFailure, ...cleanupFailures].filter((error) => error !== undefined),
    cleanupFailures.length > 0 ? "Desktop smoke or its cleanup failed" : "Desktop smoke failed",
  );
}
process.stdout.write(successMessage ?? "desktop smoke passed\n");

async function runPackagedLaunch(executable: string, launch: number): Promise<PackagedLaunchResult> {
  const sidecar = packagedSidecar;
  if (!sidecar) throw new Error("Packaged launch started before the sidecar path was resolved");
  let shutdownStartedAt: number | undefined;
  let announcedBlockedGitPid: number | undefined;
  let completed = false;
  const outputAbort = new AbortController();
  assertNotTerminating();
  const child = Bun.spawn({
    cmd: [executable],
    cwd: workspace,
    env: {
      ...smokeCanaryEnvironment(),
      CHILI_DESKTOP_SMOKE: "1",
      CHILI_DESKTOP_MODEL: "fake",
      CHILI_DESKTOP_WORKSPACE: workspace,
      CHILI_DESKTOP_USER_DATA: userData,
      CHILI_DESKTOP_DISABLE_DEVTOOLS: "1",
      ...(launch === 2 ? { CHILI_DESKTOP_SMOKE_BLOCKED_GIT: "1" } : {}),
      // A packaged app must ignore the dev-server escape hatch even when its
      // launch environment is hostile or inherited from a developer shell.
      ELECTRON_RENDERER_URL: "https://renderer-injection.invalid",
    },
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  trackDetachedProcess(child);
  let childExited = false;
  void child.exited.then(() => {
    childExited = true;
  });
  const blockedGitObservation = launch === 2
    ? waitForBlockedGitProcess(() => announcedBlockedGitPid, () => childExited)
    : Promise.resolve(undefined);
  const stdoutPromise = handleOutput(collectOutput(
    child.stdout,
    "stdout",
    4 * 1024 * 1024,
    outputAbort.signal,
    (output) => {
      if (shutdownStartedAt === undefined && output.includes("CHILI_DESKTOP_SMOKE_STAGE shutdown-started")) {
        shutdownStartedAt = performance.now();
      }
      const announced = output.match(/^CHILI_DESKTOP_SMOKE_BLOCKED_GIT_PID (\d+)$/mu)?.[1];
      if (announced) {
        const pid = Number.parseInt(announced, 10);
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error("Packaged desktop announced an invalid blocked Git PID");
        }
        if (announcedBlockedGitPid !== undefined && announcedBlockedGitPid !== pid) {
          throw new Error("Packaged desktop announced multiple blocked Git PIDs");
        }
        announcedBlockedGitPid = pid;
      }
    },
  ));
  const stderrPromise = handleOutput(collectOutput(child.stderr, "stderr", 1024 * 1024, outputAbort.signal));
  const hostCredentialAuditPromise = handleCheck(assertNoHostVisibleSidecarCredential(
    userData,
    sidecar,
    launch,
    () => childExited,
  ));
  try {
    const [exitCode, hostCredentialAudit, observedBlockedGitPid] = await Promise.all([
      waitForExit(child, 60_000, child.pid),
      hostCredentialAuditPromise,
      blockedGitObservation,
    ]);
    if (!hostCredentialAudit.ok) throw hostCredentialAudit.error;
    const [stdout, stderr] = await drainOutput(
      [stdoutPromise, stderrPromise],
      outputAbort,
      2_000,
    );
    const combinedOutput = `${stdout}\n${stderr}`;
    assertTextOmitsSensitiveNeedles(
      `Packaged desktop launch ${launch} output`,
      combinedOutput,
      rendererSensitiveNeedles,
    );
    assertTextOmitsSensitiveNeedles(
      `Packaged desktop launch ${launch} output`,
      combinedOutput,
      hostVisibleCredentialNeedles,
    );
    if (exitCode !== 0) {
      throw new Error(
        `Packaged desktop launch ${launch} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    if (/CHILI_DESKTOP_SMOKE_STAGE (?:shutdown-timeout|forced-process-exit)/u.test(combinedOutput)) {
      throw new Error(`Packaged desktop launch ${launch} used its forced shutdown path`);
    }
    if (combinedOutput.includes("CHILI_DESKTOP_SMOKE_FAILURE")) {
      throw new Error(`Packaged desktop launch ${launch} reported a smoke failure`);
    }
    if (stderr.length > 0) {
      throw new Error(`Packaged desktop launch ${launch} emitted stderr during a normal exit:\n${stderr}`);
    }
    assertOrderedUniqueShutdownStages(stdout, launch);

    const resultLines = stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("CHILI_DESKTOP_SMOKE_RESULT "));
    if (resultLines.length !== 1) {
      throw new Error(
        `Packaged desktop launch ${launch} emitted ${resultLines.length} smoke results\n`
          + `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const result = JSON.parse(
      resultLines[0]!.slice("CHILI_DESKTOP_SMOKE_RESULT ".length),
    ) as DesktopSmokeResult;
    assertTextOmitsSensitiveNeedles(
      `Packaged desktop launch ${launch} renderer result`,
      JSON.stringify(result),
      rendererSensitiveNeedles,
    );
    assertTextOmitsSensitiveNeedles(
      `Packaged desktop launch ${launch} renderer result`,
      JSON.stringify(result),
      hostVisibleCredentialNeedles,
    );
    if (
      result.packaged !== true
      || result.sidecarExecutable !== true
      || result.renderer?.assistantSeen !== true
      || result.renderer.idleSeen !== true
      || result.renderer.bridgeKeys?.join(",") !== "invoke,subscribe"
      || !result.renderer.snapshotEventCount
      || result.renderer.leakAudit?.passed !== true
      || result.renderer.leakAudit.fixtureVerified !== true
      || result.renderer.leakAudit.fixtureNeedleCount !== rendererSensitiveNeedles.length
      || result.renderer.leakAudit.fixtureNeedlesDetected !== rendererSensitiveNeedles.length
      || !result.renderer.leakAudit.checkedValues
      || !result.renderer.leakAudit.checkedBytes
      || !result.renderer.leakAudit.envelopeCount
      || result.renderer.leakAudit.credentialFixtureVerified !== true
      || result.renderer.leakAudit.credentialChecks !== result.renderer.leakAudit.checkedValues
    ) {
      throw new Error(`Packaged desktop launch ${launch} result was incomplete: ${JSON.stringify(result)}`);
    }
    if (!result.sidecarPid || !Number.isSafeInteger(result.sidecarPid)) {
      throw new Error(`Packaged desktop launch ${launch} omitted its sidecar PID`);
    }
    if (launch === 1 && (result.blockedGitPid !== undefined || announcedBlockedGitPid !== undefined)) {
      throw new Error("Packaged desktop launch 1 unexpectedly announced or reported a blocked Git PID");
    }
    if (launch === 2) {
      if (!result.blockedGitPid || !Number.isSafeInteger(result.blockedGitPid)) {
        throw new Error("Packaged desktop launch 2 omitted its blocked Git PID");
      }
      if (result.blockedGitPid !== observedBlockedGitPid) {
        throw new Error(
          `Packaged desktop launch 2 reported blocked Git PID ${result.blockedGitPid}; `
            + `the live process fixture observed ${observedBlockedGitPid ?? "none"}`,
        );
      }
      if (await processStillExists(result.blockedGitPid, 5_000)) {
        throw new Error(`Packaged desktop launch 2 left blocked Git PID ${result.blockedGitPid} alive`);
      }
      if (!await waitForProcessGroupExit(result.blockedGitPid, 5_000)) {
        throw new Error(`Packaged desktop launch 2 left blocked Git group ${result.blockedGitPid} alive`);
      }
      observedBlockedGitProcessGroups.delete(result.blockedGitPid);
    }
    if (shutdownStartedAt === undefined) {
      throw new Error(`Packaged desktop launch ${launch} omitted its shutdown start timestamp`);
    }
    if (!await waitForProcessGroupExit(child.pid, 2_000)) {
      throw new Error(`Packaged desktop launch ${launch} left process group ${child.pid} alive`);
    }
    completed = true;
    process.stdout.write(stdout);
    return {
      sidecarPid: result.sidecarPid,
      shutdownExitMs: Math.round(performance.now() - shutdownStartedAt),
      ...(result.blockedGitPid !== undefined ? { blockedGitPid: result.blockedGitPid } : {}),
    };
  } catch (error) {
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await drainOutput(
        [stdoutPromise, stderrPromise],
        outputAbort,
        2_000,
      );
    } catch (outputError) {
      throw new AggregateError(
        [error, outputError],
        `Packaged desktop launch ${launch} failed and its output could not be drained`,
      );
    }
    assertTextOmitsSensitiveNeedles(
      `Failed packaged desktop launch ${launch} output`,
      `${stdout}\n${stderr}`,
      [...rendererSensitiveNeedles, ...hostVisibleCredentialNeedles],
    );
    throw new Error(
      `Packaged desktop launch ${launch} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  } finally {
    outputAbort.abort();
    if (completed) activeDetachedGroups.delete(child.pid);
    else await terminateTrackedProcessGroup(child.pid, child);
  }
}

async function initializeSmokeGitWorkspace(): Promise<void> {
  await runCapture(
    ["/usr/bin/git", "init", "--quiet", workspace],
    repositoryRoot,
    5_000,
  );
}

async function enableBlockedGitFixture(): Promise<void> {
  await runCapture(
    ["/usr/bin/mkfifo", blockedGitIncludePath],
    repositoryRoot,
    5_000,
  );
  const fifo = await lstat(blockedGitIncludePath);
  if (!fifo.isFIFO()) throw new Error("Blocked Git fixture path is not a FIFO");

  const configPath = join(workspace, ".git", "config");
  const config = await readFile(configPath, "utf8");
  if (/^\s*\[include\]\s*$/mu.test(config)) {
    throw new Error("Fresh smoke Git workspace unexpectedly already had an include section");
  }
  smokeGitConfigBeforeBlock = config;
  await writeFile(
    configPath,
    `${config.trimEnd()}\n[include]\n\tpath = ${JSON.stringify(blockedGitIncludePath)}\n`,
    "utf8",
  );
}

async function disableBlockedGitFixture(): Promise<void> {
  if (smokeGitConfigBeforeBlock === undefined) {
    throw new Error("Blocked Git fixture was not enabled before cleanup");
  }
  await writeFile(join(workspace, ".git", "config"), smokeGitConfigBeforeBlock, "utf8");
  smokeGitConfigBeforeBlock = undefined;
  await rm(blockedGitIncludePath, { force: true });
}

async function waitForBlockedGitProcess(
  announcedPid: () => number | undefined,
  parentExited: () => boolean,
): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const expectedPid = announcedPid();
    if (expectedPid === undefined) {
      if (parentExited()) {
        throw new Error("Packaged desktop launch 2 exited before announcing a blocked Git process");
      }
      await Bun.sleep(25);
      continue;
    }
    const { stdout } = await runCapture(
      ["/bin/ps", "-axo", "pid=,pgid=,comm="],
      repositoryRoot,
      5_000,
    );
    const candidates = stdout.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      if (!match) return [];
      const pid = Number.parseInt(match[1]!, 10);
      const processGroupPid = Number.parseInt(match[2]!, 10);
      const executable = match[3]!;
      return pid === expectedPid ? [{ pid, processGroupPid, executable }] : [];
    });
    if (candidates.length > 1) throw new Error(`Blocked Git PID ${expectedPid} appeared multiple times in ps`);
    const candidate = candidates[0];
    if (candidate) {
      if (
        !Number.isSafeInteger(candidate.pid)
        || candidate.pid <= 1
        || candidate.processGroupPid !== candidate.pid
        || basename(candidate.executable) !== "git"
        || !isAlive(candidate.pid)
        || !isProcessGroupAlive(candidate.processGroupPid)
      ) {
        throw new Error(
          `Blocked Git fixture observed invalid PID/PGID/executable metadata: `
            + `${candidate.pid}/${candidate.processGroupPid}/${candidate.executable}`,
        );
      }
      observedBlockedGitProcessGroups.add(candidate.processGroupPid);
      return candidate.pid;
    }
    if (parentExited()) {
      throw new Error(`Packaged desktop launch 2 exited before announced Git PID ${expectedPid} was observed alive`);
    }
    await Bun.sleep(25);
  }
  throw new Error("Packaged desktop launch 2 did not start a blocked Git process within 30000ms");
}

function assertOrderedUniqueShutdownStages(stdout: string, launch: number): void {
  const lines = stdout.split(/\r?\n/u);
  const expected = ["shutdown-started", "sidecar-stopped", "shutdown-complete"] as const;
  const positions = expected.map((stage) => {
    const marker = `CHILI_DESKTOP_SMOKE_STAGE ${stage}`;
    const matches = lines
      .map((line, index) => line === marker ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length !== 1) {
      throw new Error(
        `Packaged desktop launch ${launch} emitted ${matches.length} exact ${stage} stages; expected one`,
      );
    }
    return matches[0]!;
  });
  if (!(positions[0]! < positions[1]! && positions[1]! < positions[2]!)) {
    throw new Error(
      `Packaged desktop launch ${launch} emitted shutdown stages out of order: ${positions.join(", ")}`,
    );
  }
}

async function runParentHardCrashLaunch(executable: string): Promise<ParentLossFixture> {
  const sidecar = packagedSidecar;
  if (!sidecar) throw new Error("Parent hard-crash launch started before the packaged sidecar was resolved");
  await rm(parentLossFixturePath, { force: true });
  assertNotTerminating();
  const child = Bun.spawn({
    cmd: [executable],
    cwd: workspace,
    env: {
      ...smokeCanaryEnvironment(),
      CHILI_DESKTOP_SMOKE: "1",
      CHILI_DESKTOP_MODEL: "fake",
      CHILI_DESKTOP_WORKSPACE: workspace,
      CHILI_DESKTOP_USER_DATA: hardCrashUserData,
      CHILI_DESKTOP_DISABLE_DEVTOOLS: "1",
      CHILI_DESKTOP_PARENT_LOSS_FIXTURE_PATH: parentLossFixturePath,
      ELECTRON_RENDERER_URL: "https://renderer-injection.invalid",
    },
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  trackDetachedProcess(child);
  let fixture: ParentLossFixture | undefined;
  let verifiedFixture: ParentLossFixture | undefined;
  let failure: unknown;
  try {
    fixture = await waitForParentLossFixture(parentLossFixturePath, 30_000);
    assertParentLossFixtureAlive(fixture);
    process.kill(child.pid, "SIGKILL");
    const parentExitCode = await waitForExit(child, 5_000, child.pid);
    if (parentExitCode === 124) throw new Error("Electron parent survived SIGKILL");
    await waitForParentLossCleanup(fixture, 10_000);
    const survivors = await waitForNoPackagedProcesses(hardCrashUserData, sidecar, 5_000);
    if (survivors.length > 0) {
      throw new Error(`Parent hard-crash launch left packaged processes alive:\n${survivors.join("\n")}`);
    }
    if (!await waitForProcessGroupExit(child.pid, 5_000)) {
      throw new Error(`Parent hard-crash launch left Electron process group ${child.pid} alive`);
    }
    verifiedFixture = fixture;
  } catch (error) {
    failure = error;
  }
  const cleanup = await Promise.allSettled([
    terminateTrackedProcessGroup(child.pid, child),
    ...(fixture ? [terminateParentLossFixture(fixture)] : []),
  ]);
  const cleanupFailures = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures].filter((error) => error !== undefined),
      "Parent hard-crash launch or its cleanup failed",
    );
  }
  return verifiedFixture!;
}

async function waitForParentLossFixture(path: string, timeoutMs: number): Promise<ParentLossFixture> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return parseParentLossFixture(value);
    } catch (error) {
      if (!isNotFound(error)) throw new Error(`Invalid parent-loss fixture: ${safeErrorMessage(error)}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`Packaged parent-loss fixture was not written within ${timeoutMs}ms`);
}

function parseParentLossFixture(value: unknown): ParentLossFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Parent-loss fixture must be an object");
  }
  const record = value as Record<string, unknown>;
  const fixture: ParentLossFixture = {
    sidecarPid: positiveFixturePid(record.sidecarPid, "sidecarPid"),
    toolProcessGroupPid: positiveFixturePid(record.toolProcessGroupPid, "toolProcessGroupPid"),
    inheritedPid: positiveFixturePid(record.inheritedPid, "inheritedPid"),
  };
  if (new Set(Object.values(fixture)).size !== 3) {
    throw new TypeError("Parent-loss fixture PIDs must be distinct");
  }
  return fixture;
}

function positiveFixturePid(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Parent-loss fixture ${name} must be a positive safe integer`);
  }
  return value as number;
}

function assertParentLossFixtureAlive(fixture: ParentLossFixture): void {
  const missing: string[] = [];
  if (!isProcessGroupAlive(fixture.sidecarPid)) missing.push(`sidecar group ${fixture.sidecarPid}`);
  if (!isProcessGroupAlive(fixture.toolProcessGroupPid)) missing.push(`tool group ${fixture.toolProcessGroupPid}`);
  if (!isAlive(fixture.inheritedPid)) missing.push(`inherited process ${fixture.inheritedPid}`);
  if (missing.length > 0) throw new Error(`Parent-loss fixture was not alive before parent SIGKILL: ${missing.join(", ")}`);
}

async function waitForParentLossCleanup(fixture: ParentLossFixture, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let survivors = parentLossSurvivors(fixture);
  while (survivors.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    survivors = parentLossSurvivors(fixture);
  }
  if (survivors.length > 0) {
    throw new Error(`Parent hard-crash containment left processes alive: ${survivors.join(", ")}`);
  }
}

function parentLossSurvivors(fixture: ParentLossFixture): string[] {
  const survivors: string[] = [];
  if (isProcessGroupAlive(fixture.sidecarPid)) survivors.push(`sidecar group ${fixture.sidecarPid}`);
  if (isProcessGroupAlive(fixture.toolProcessGroupPid)) survivors.push(`tool group ${fixture.toolProcessGroupPid}`);
  if (isAlive(fixture.inheritedPid)) survivors.push(`inherited process ${fixture.inheritedPid}`);
  return survivors;
}

async function terminateParentLossFixture(fixture: ParentLossFixture): Promise<void> {
  const cleanup = await Promise.allSettled([
    terminateProcessGroup(fixture.toolProcessGroupPid),
    terminateProcessGroup(fixture.sidecarPid),
    terminatePid(fixture.inheritedPid),
  ]);
  const failures = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failures.length > 0) throw new AggregateError(failures, "Parent-loss fixture cleanup failed");
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw error;
  }
}

async function findSinglePackagedApplication(root: string): Promise<string> {
  const candidates: string[] = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(root, directory.name);
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        candidates.push(join(directoryPath, entry.name));
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected one fresh packaged .app below ${root}, found ${candidates.length}`);
  }
  const application = candidates[0]!;
  if (basename(dirname(application)) !== expectedReleaseDirectory) {
    throw new Error(
      `Packaged app used ${basename(dirname(application))}; expected host directory ${expectedReleaseDirectory}`,
    );
  }
  return application;
}

async function assertFresh(label: string, path: string, buildStartedAt: number): Promise<void> {
  const metadata = await stat(path);
  if (metadata.mtimeMs < buildStartedAt) {
    throw new Error(`${label} predates this smoke build: ${path}`);
  }
}

async function assertExecutable(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Packaged executable is not a file: ${path}`);
  await access(path, constants.X_OK);
}

async function assertMachOSlices(application: string, sidecar: string): Promise<void> {
  const [applicationResult, sidecarResult] = await Promise.all([
    runCapture(["/usr/bin/lipo", "-archs", application], repositoryRoot, 10_000),
    runCapture(["/usr/bin/lipo", "-archs", sidecar], repositoryRoot, 10_000),
  ]);
  const applicationSlices = normalizeSlices(applicationResult.stdout);
  const sidecarSlices = normalizeSlices(sidecarResult.stdout);
  if (applicationSlices !== expectedMachOSlice || sidecarSlices !== expectedMachOSlice) {
    throw new Error(
      `Packaged Mach-O slices did not match ${expectedMachOSlice}: `
        + `app=${applicationSlices}, sidecar=${sidecarSlices}`,
    );
  }
}

function normalizeSlices(value: string): string {
  return value.trim().split(/\s+/u).filter(Boolean).sort().join(" ");
}

async function assertCodesigned(application: string, sidecar: string): Promise<void> {
  await runCapture(
    ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", application],
    repositoryRoot,
    30_000,
  );
  const applicationName = basename(application, ".app");
  const electronBundles = [
    { label: "main application", path: application },
    { label: "main helper", path: join(application, "Contents", "Frameworks", `${applicationName} Helper.app`) },
    {
      label: "GPU helper",
      path: join(application, "Contents", "Frameworks", `${applicationName} Helper (GPU).app`),
    },
    {
      label: "plugin helper",
      path: join(application, "Contents", "Frameworks", `${applicationName} Helper (Plugin).app`),
    },
    {
      label: "renderer helper",
      path: join(application, "Contents", "Frameworks", `${applicationName} Helper (Renderer).app`),
    },
  ] as const;
  for (const entry of electronBundles) {
    await assertHardenedAdHocSignature(
      entry.path,
      entry.label,
      ELECTRON_HARDENED_RUNTIME_ENTITLEMENTS,
    );
  }
  await runCapture(
    ["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", sidecar],
    repositoryRoot,
    30_000,
  );
  await assertHardenedAdHocSignature(sidecar, "Bun sidecar", []);
}

async function assertHardenedAdHocSignature(
  target: string,
  label: string,
  expectedEntitlements: readonly string[],
): Promise<void> {
  const signature = await runCapture(
    ["/usr/bin/codesign", "-dvv", target],
    repositoryRoot,
    30_000,
  );
  const details = `${signature.stdout}\n${signature.stderr}`;
  if (!/^Signature=adhoc$/mu.test(details) || /^Authority=/mu.test(details)) {
    throw new Error(`Packaged ${label} must have an ad-hoc signature with no signing authority`);
  }
  if (!/^CodeDirectory\b.*\bflags=[^\r\n]*\bruntime\b/mu.test(details)) {
    throw new Error(`Packaged ${label} must retain the hardened-runtime signature flag`);
  }

  const entitlementResult = await runCapture(
    ["/usr/bin/codesign", "-d", "--entitlements", "-", "--xml", target],
    repositoryRoot,
    30_000,
  );
  const entitlementDetails = `${entitlementResult.stdout}\n${entitlementResult.stderr}`;
  const keys = [...entitlementDetails.matchAll(/<key>([^<]+)<\/key>/gu)]
    .map((match) => match[1]!);
  const booleanEntries = [...entitlementDetails.matchAll(
    /<key>([^<]+)<\/key>\s*<(true|false)\/>/gu,
  )];
  if (keys.length !== booleanEntries.length || new Set(keys).size !== keys.length) {
    throw new Error(`Packaged ${label} entitlements were duplicate or not boolean`);
  }
  const falseEntitlements = booleanEntries
    .filter((match) => match[2] !== "true")
    .map((match) => match[1]!);
  if (falseEntitlements.length > 0) {
    throw new Error(`Packaged ${label} had disabled entitlement keys: ${falseEntitlements.join(", ")}`);
  }
  const actual = [...keys].sort();
  const expected = [...expectedEntitlements].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Packaged ${label} entitlements were [${actual.join(", ")}]; expected [${expected.join(", ")}]`,
    );
  }
}

async function assertAsarContents(asar: string): Promise<void> {
  const asarCli = resolve(repositoryRoot, "apps/desktop/node_modules/.bin/asar");
  await assertExecutable(asarCli);
  await assertPathAbsent(`${asar}.unpacked`, "Packaged Resources/app.asar.unpacked tree");
  const { stdout } = await runCapture([asarCli, "list", "--is-pack", asar], repositoryRoot, 30_000);
  const listing = stdout
    .split(/\r?\n/u)
    .filter(Boolean);
  const entries = listing.map((line) => {
    const match = line.match(/^(pack {3}|unpack ): \/(.+)$/u);
    if (!match) throw new Error(`ASAR pack listing had an unexpected line format: ${line.slice(0, 200)}`);
    if (match[1] === "unpack ") {
      throw new Error(`ASAR contains an unpacked entry: ${match[2]}`);
    }
    return match[2]!.replace(/\/+$/gu, "");
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error("ASAR contains duplicate entries");
  }
  const requiredFiles = [
    "package.json",
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
  ] as const;
  for (const required of requiredFiles) {
    if (!entries.includes(required)) throw new Error(`ASAR omitted required entry: ${required}`);
  }
  const forbidden = entries.filter((entry) => (
    /(^|\/)(?:node_modules|src|source|test|tests|debug)(?:[-_.\/]|$)/u.test(entry)
    || /(^|\/)@chili(?:\/|$)/u.test(entry)
    || /(^|\/)\.env(?:\.|$)/u.test(entry)
    || /\.test\.[^/]+$/u.test(entry)
    || /\.(?:map|tsbuildinfo)$/u.test(entry)
  ));
  if (forbidden.length > 0) {
    throw new Error(`ASAR contains forbidden build/source entries:\n${forbidden.slice(0, 40).join("\n")}`);
  }
  const allowedDirectories = new Set([
    "out",
    "out/main",
    "out/preload",
    "out/renderer",
    "out/renderer/assets",
  ]);
  const requiredFileSet = new Set<string>(requiredFiles);
  const rendererAsset = /^out\/renderer\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]{8,}\.(?:css|js)$/u;
  const unexpected = entries.filter((entry) => (
    !allowedDirectories.has(entry)
    && !requiredFileSet.has(entry)
    && !rendererAsset.test(entry)
  ));
  if (unexpected.length > 0) {
    throw new Error(`ASAR contains entries outside the strict allowlist:\n${unexpected.slice(0, 40).join("\n")}`);
  }
  for (const extension of ["js", "css"] as const) {
    if (!entries.some((entry) => rendererAsset.test(entry) && entry.endsWith(`.${extension}`))) {
      throw new Error(`ASAR omitted its hashed renderer ${extension} asset`);
    }
  }
  const { header } = await readAsarHeader(asar);
  assertNoUnpackedHeaderNodes(header, "ASAR header");
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(`${label} must be absent: ${path}`);
}

function assertNoUnpackedHeaderNodes(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUnpackedHeaderNodes(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "unpacked")) {
    throw new Error(`${path} contains a forbidden unpacked flag`);
  }
  for (const [key, entry] of Object.entries(record)) {
    assertNoUnpackedHeaderNodes(entry, `${path}.${key}`);
  }
}

async function assertAsarIntegrity(application: string, asar: string): Promise<void> {
  const infoPlist = join(application, "Contents", "Info.plist");
  const { stdout } = await runCapture(
    ["/usr/bin/plutil", "-convert", "json", "-o", "-", infoPlist],
    repositoryRoot,
    10_000,
  );
  let plistValue: unknown;
  try {
    plistValue = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Packaged Info.plist did not convert to JSON: ${safeErrorMessage(error)}`);
  }
  const plist = requireRecord(plistValue, "Packaged Info.plist");
  const integrity = requireRecord(plist.ElectronAsarIntegrity, "ElectronAsarIntegrity");
  const integrityPaths = Object.keys(integrity);
  if (integrityPaths.length !== 1 || integrityPaths[0] !== "Resources/app.asar") {
    throw new Error(
      `ElectronAsarIntegrity must contain only Resources/app.asar; found ${integrityPaths.join(", ") || "none"}`,
    );
  }
  const entry = requireRecord(integrity["Resources/app.asar"], "ElectronAsarIntegrity Resources/app.asar");
  const entryKeys = Object.keys(entry).sort();
  if (entryKeys.join(",") !== "algorithm,hash") {
    throw new Error(`ElectronAsarIntegrity entry has unexpected fields: ${entryKeys.join(", ") || "none"}`);
  }
  if (entry.algorithm !== "SHA256") {
    throw new Error(`ElectronAsarIntegrity algorithm must be SHA256; found ${String(entry.algorithm)}`);
  }
  if (typeof entry.hash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.hash)) {
    throw new Error("ElectronAsarIntegrity hash must be 64 lowercase hexadecimal characters");
  }

  const actualHash = await computeAsarHeaderHash(asar);
  if (actualHash !== entry.hash) {
    throw new Error(`ElectronAsarIntegrity hash mismatch: plist=${entry.hash}, ASAR header=${actualHash}`);
  }
}

async function computeAsarHeaderHash(asar: string): Promise<string> {
  // Electron 42 and the locked electron-builder 26.15.2 integrity implementation
  // hash the UTF-8 JSON bytes inside the ASAR header pickle, not the complete
  // archive. A whole-file digest is therefore diagnostic only and must never be
  // compared with ElectronAsarIntegrity.
  const { jsonBytes } = await readAsarHeader(asar);
  return createHash("sha256").update(jsonBytes).digest("hex");
}

async function readAsarHeader(asar: string): Promise<{ header: Record<string, unknown>; jsonBytes: Buffer }> {
  const file = await open(asar, "r");
  try {
    const sizePickle = Buffer.alloc(8);
    await readExactly(file, sizePickle, 0);
    if (sizePickle.readUInt32LE(0) !== 4) {
      throw new Error("ASAR size pickle has an invalid payload length");
    }
    const headerPickleSize = sizePickle.readUInt32LE(4);
    const maximumHeaderBytes = 64 * 1024 * 1024;
    if (headerPickleSize < 8 || headerPickleSize > maximumHeaderBytes || headerPickleSize % 4 !== 0) {
      throw new Error(`ASAR header pickle has an invalid size: ${headerPickleSize}`);
    }
    const metadata = await file.stat();
    if (8 + headerPickleSize > metadata.size) {
      throw new Error("ASAR header pickle extends beyond the archive");
    }

    const headerPickle = Buffer.alloc(headerPickleSize);
    await readExactly(file, headerPickle, 8);
    if (headerPickle.readUInt32LE(0) !== headerPickleSize - 4) {
      throw new Error("ASAR header pickle payload length does not match its framed size");
    }
    const headerJsonLength = headerPickle.readUInt32LE(4);
    const paddedJsonLength = Math.ceil(headerJsonLength / 4) * 4;
    if (headerPickleSize !== 8 + paddedJsonLength) {
      throw new Error("ASAR header JSON length does not match its pickle framing");
    }
    const headerJsonBytes = headerPickle.subarray(8, 8 + headerJsonLength);
    const padding = headerPickle.subarray(8 + headerJsonLength);
    if (padding.some((byte) => byte !== 0)) {
      throw new Error("ASAR header pickle contains non-zero padding");
    }
    const headerJson = headerJsonBytes.toString("utf8");
    if (!Buffer.from(headerJson, "utf8").equals(headerJsonBytes)) {
      throw new Error("ASAR header JSON is not valid UTF-8");
    }
    let header: Record<string, unknown>;
    try {
      header = requireRecord(JSON.parse(headerJson) as unknown, "ASAR header JSON");
    } catch (error) {
      throw new Error(`ASAR header is not valid JSON: ${safeErrorMessage(error)}`);
    }
    return { header, jsonBytes: Buffer.from(headerJsonBytes) };
  } finally {
    await file.close();
  }
}

async function readExactly(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Unexpected end of ASAR while reading its header");
    offset += bytesRead;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function assertFuseWire(framework: string): Promise<void> {
  const binary = await readFile(framework);
  const firstSentinel = binary.indexOf(FUSE_SENTINEL);
  if (firstSentinel < 0) throw new Error("Packaged Electron framework has no fuse wire sentinel");
  if (binary.lastIndexOf(FUSE_SENTINEL) !== firstSentinel) {
    throw new Error("Host-only desktop package unexpectedly contains multiple fuse wires");
  }
  const wirePosition = firstSentinel + FUSE_SENTINEL.length;
  const version = binary[wirePosition];
  const length = binary[wirePosition + 1];
  if (version !== 1) throw new Error(`Unsupported packaged fuse wire version: ${version ?? "missing"}`);
  if (length !== KNOWN_FUSES.length) {
    throw new Error(
      `Packaged fuse wire has ${length ?? "missing"} entries; expected ${KNOWN_FUSES.length}. `
        + "Refusing an unknown or incomplete Electron fuse policy.",
    );
  }
  const states = binary.subarray(wirePosition + 2, wirePosition + 2 + length);
  for (let index = 0; index < KNOWN_FUSES.length; index += 1) {
    const [name, enabled] = KNOWN_FUSES[index]!;
    const expected = enabled ? FUSE_ENABLED : FUSE_DISABLED;
    if (states[index] !== expected) {
      throw new Error(
        `Packaged fuse ${index} (${name}) was ${describeFuseState(states[index])}; `
          + `expected ${enabled ? "enabled" : "disabled"}`,
      );
    }
  }
}

function describeFuseState(state: number | undefined): string {
  if (state === FUSE_ENABLED) return "enabled";
  if (state === FUSE_DISABLED) return "disabled";
  if (state === "r".charCodeAt(0)) return "removed";
  if (state === 0x90) return "inherited";
  return `unknown (${state ?? "missing"})`;
}

function smokeCanaryEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // This hostile inherited value must be stripped before the sidecar spawn.
    // The real 256-bit credential is delivered only through private fd 3.
    CHILI_DESKTOP_TOKEN: inheritedTokenCanary,
    CHILI_HOME: isolatedChiliHome,
    CHILI_DESKTOP_SMOKE_SECRET_CANARY: secretCanary,
    CHILI_DESKTOP_SMOKE_PATH_CANARY: pathCanary,
    CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES: JSON.stringify(
      rendererSensitiveNeedles.map((needle) => needle.value),
    ),
  };
  // The release smoke intentionally proves the documented local/ad-hoc path;
  // a developer shell must not silently turn this artifact into Developer ID.
  delete environment.CHILI_DESKTOP_SIGN_IDENTITY;
  return environment;
}

function pathNeedles(label: string, input: string): SensitiveNeedle[] {
  const path = resolve(input);
  const fileUrl = pathToFileURL(path).href;
  return [
    { label, value: path },
    { label: `${label} file URL`, value: fileUrl },
    ...encodedNeedles(`${label} URI encoding`, path),
    ...encodedNeedles(`${label} file URL encoding`, fileUrl),
  ];
}

function encodedNeedles(label: string, input: string): SensitiveNeedle[] {
  const encoded = encodeURIComponent(input);
  const lowerPercentEncoding = encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
  return [
    { label, value: encoded },
    { label: `${label} (lowercase escapes)`, value: lowerPercentEncoding },
  ];
}

function uniqueNeedles(needles: readonly SensitiveNeedle[]): SensitiveNeedle[] {
  const unique = new Map<string, SensitiveNeedle>();
  for (const needle of needles) {
    if (!needle.value || unique.has(needle.value)) continue;
    unique.set(needle.value, needle);
  }
  return [...unique.values()].sort((left, right) => right.value.length - left.value.length);
}

function assertTextOmitsSensitiveNeedles(
  subject: string,
  text: string,
  needles: readonly SensitiveNeedle[],
): void {
  const match = needles.find((needle) => text.includes(needle.value));
  if (match) throw new Error(`${subject} exposed ${match.label}`);
}

async function assertNoEmbeddedText(root: string, needles: readonly SensitiveNeedle[]): Promise<void> {
  const encoded = needles.map((needle) => ({ ...needle, bytes: Buffer.from(needle.value, "utf8") }));
  const entries = await artifactEntriesBelow(root);
  for (const path of entries.files) {
    const match = await fileContainsAny(path, encoded);
    if (match) {
      throw new Error(`Packaged artifact embeds ${match.label} in ${relative(root, path)}`);
    }
  }
  for (const path of entries.symlinks) {
    assertTextOmitsSensitiveNeedles(
      `Packaged artifact symlink ${relative(root, path)}`,
      await readlink(path),
      needles,
    );
  }
}

async function artifactEntriesBelow(root: string): Promise<{ files: string[]; symlinks: string[] }> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) symlinks.push(path);
      // Do not follow links: framework links form cycles. Their target text is
      // still checked separately so an absolute build path cannot hide there.
    }
  };
  await visit(root);
  return { files, symlinks };
}

async function fileContainsAny(
  path: string,
  needles: ReadonlyArray<SensitiveNeedle & { bytes: Buffer }>,
): Promise<SensitiveNeedle | undefined> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) return undefined;
  const maximumNeedleLength = Math.max(...needles.map((needle) => needle.bytes.length));
  let carry = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const match = needles.find((needle) => buffer.indexOf(needle.bytes) >= 0);
    if (match) return match;
    const carryLength = Math.min(Math.max(maximumNeedleLength - 1, 0), buffer.length);
    carry = Buffer.from(buffer.subarray(buffer.length - carryLength));
  }
  return undefined;
}

async function runChecked(
  command: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  assertNotTerminating();
  const child = Bun.spawn({
    cmd: command,
    cwd,
    ...(env ? { env } : {}),
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  trackDetachedProcess(child);
  const outputAbort = new AbortController();
  const stdoutPromise = handleOutput(collectOutput(child.stdout, "stdout", 32 * 1024 * 1024, outputAbort.signal));
  const stderrPromise = handleOutput(collectOutput(child.stderr, "stderr", 16 * 1024 * 1024, outputAbort.signal));
  let completed = false;
  try {
    const exitCode = await waitForExit(child, timeoutMs, child.pid);
    const [stdout, stderr] = await drainOutput([stdoutPromise, stderrPromise], outputAbort, 2_000);
    assertTextOmitsSensitiveNeedles(
      `Command ${command[0] ?? "unknown"} output`,
      `${stdout}\n${stderr}`,
      commandOutputSensitiveNeedles,
    );
    if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
    if (!await waitForProcessGroupExit(child.pid, 1_000)) {
      throw new Error(`${command.join(" ")} left descendants in process group ${child.pid}`);
    }
    completed = true;
    activeDetachedGroups.delete(child.pid);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  } finally {
    outputAbort.abort();
    if (!completed) await terminateTrackedProcessGroup(child.pid, child);
  }
}

async function runCapture(
  command: string[],
  cwd: string,
  timeoutMs: number,
  allowDuringCleanup = false,
  redactFailureOutput = false,
): Promise<{ stdout: string; stderr: string }> {
  if (!allowDuringCleanup) assertNotTerminating();
  // macOS rejects detached posix_spawn for several platform inspection tools
  // (including ps). Track these short-lived direct children separately; a
  // terminal signal already targets their shared foreground group, while the
  // explicit registry covers programmatic CI cancellation.
  const child = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  trackDirectProcess(child);
  const outputAbort = new AbortController();
  const stdoutPromise = handleOutput(collectOutput(child.stdout, "stdout", 16 * 1024 * 1024, outputAbort.signal));
  const stderrPromise = handleOutput(collectOutput(child.stderr, "stderr", 4 * 1024 * 1024, outputAbort.signal));
  let completed = false;
  try {
    const exitCode = await waitForExit(child, timeoutMs);
    const [stdout, stderr] = await drainOutput([stdoutPromise, stderrPromise], outputAbort, 2_000);
    if (exitCode !== 0) {
      throw new Error(
        `${command.join(" ")} failed with exit code ${exitCode}`
          + (redactFailureOutput ? " (captured output redacted)" : `\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }
    completed = true;
    activeDirectProcesses.delete(child.pid);
    return { stdout, stderr };
  } finally {
    outputAbort.abort();
    if (!completed) await terminateTrackedDirectProcess(child.pid, child);
  }
}

interface SpawnedProcess {
  pid: number;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): unknown;
}

function trackDetachedProcess(child: SpawnedProcess): void {
  if (activeDetachedGroups.has(child.pid)) {
    throw new Error(`Detached process group ${child.pid} was registered twice`);
  }
  activeDetachedGroups.set(child.pid, child);
}

function markContainmentAware(processGroupPid: number, prepareForParentLoss: () => void): void {
  if (!activeDetachedGroups.has(processGroupPid)) {
    throw new Error(`Containment-aware process group ${processGroupPid} was not registered`);
  }
  containmentPreparation.set(processGroupPid, prepareForParentLoss);
}

function terminateRegisteredProcessGroup(processGroupPid: number, child?: SpawnedProcess): Promise<void> {
  if (containmentPreparation.has(processGroupPid)) {
    const existing = containmentCleanup.get(processGroupPid);
    if (existing) return existing;
    const cleanup = (async (): Promise<void> => {
      try {
        containmentPreparation.get(processGroupPid)?.();
        await terminateSidecarAfterContainmentGrace(processGroupPid);
      } finally {
        containmentPreparation.delete(processGroupPid);
        containmentCleanup.delete(processGroupPid);
      }
    })();
    containmentCleanup.set(processGroupPid, cleanup);
    return cleanup;
  }
  return terminateTrackedProcessGroup(processGroupPid, child);
}

function trackDirectProcess(child: SpawnedProcess): void {
  if (activeDirectProcesses.has(child.pid)) {
    throw new Error(`Direct child process ${child.pid} was registered twice`);
  }
  activeDirectProcesses.set(child.pid, child);
}

function terminateTrackedProcessGroup(processGroupPid: number, child?: SpawnedProcess): Promise<void> {
  const existing = detachedGroupCleanup.get(processGroupPid);
  if (existing) return existing;
  if (!activeDetachedGroups.has(processGroupPid)) return Promise.resolve();
  const trackedChild = child ?? activeDetachedGroups.get(processGroupPid);
  const cleanup = (async (): Promise<void> => {
    try {
      await terminateProcessGroup(processGroupPid, trackedChild);
    } finally {
      activeDetachedGroups.delete(processGroupPid);
      detachedGroupCleanup.delete(processGroupPid);
    }
  })();
  detachedGroupCleanup.set(processGroupPid, cleanup);
  return cleanup;
}

function terminateTrackedDirectProcess(pid: number, child?: SpawnedProcess): Promise<void> {
  const existing = directProcessCleanup.get(pid);
  if (existing) return existing;
  if (!activeDirectProcesses.has(pid)) return Promise.resolve();
  const trackedChild = child ?? activeDirectProcesses.get(pid);
  const cleanup = (async (): Promise<void> => {
    try {
      if (trackedChild) {
        if (isAlive(pid)) signalPid(pid, "SIGTERM");
        if (!(await settleWithin(trackedChild.exited, 750)).settled) signalPid(pid, "SIGKILL");
        if (!(await settleWithin(trackedChild.exited, 2_000)).settled) {
          throw new Error(`Direct child process ${pid} survived SIGKILL`);
        }
      }
    } finally {
      activeDirectProcesses.delete(pid);
      directProcessCleanup.delete(pid);
    }
  })();
  directProcessCleanup.set(pid, cleanup);
  return cleanup;
}

async function waitForExit(
  child: SpawnedProcess,
  timeoutMs: number,
  processGroupPid?: number,
): Promise<number> {
  const exit = await settleWithin(child.exited, timeoutMs);
  if (exit.settled) return exit.value;
  if (processGroupPid) await terminateTrackedProcessGroup(processGroupPid, child);
  else {
    await terminateTrackedDirectProcess(child.pid, child);
  }
  return 124;
}

async function collectOutput(
  stream: ReadableStream<Uint8Array>,
  destination: "stdout" | "stderr",
  maximumBytes: number,
  signal: AbortSignal,
  observe?: (output: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let receivedBytes = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maximumBytes) {
        throw new Error(`Child ${destination} exceeded ${maximumBytes} bytes`);
      }
      const text = decoder.decode(chunk.value, { stream: true });
      output += text;
      observe?.(output);
    }
    output += decoder.decode();
    return output;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

type HandledOutput = { ok: true; value: string } | { ok: false; error: unknown };
type HandledCheck = { ok: true } | { ok: false; error: unknown };

function handleOutput(output: Promise<string>): Promise<HandledOutput> {
  // Attach both branches synchronously with stream creation. Bun treats a
  // rejection observed only after child.exited as unhandled and can terminate
  // the smoke runner before its detached-process cleanup executes.
  return output.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function handleCheck(check: Promise<void>): Promise<HandledCheck> {
  return check.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function assertOutputOverflowCleanupFixture(): Promise<void> {
  const outputAbort = new AbortController();
  assertNotTerminating();
  const child = Bun.spawn({
    cmd: ["/bin/sh", "-c", "while :; do printf overflow-fixture; done"],
    detached: true,
    stdout: "pipe",
    stderr: "ignore",
  });
  trackDetachedProcess(child);
  const output = handleOutput(collectOutput(child.stdout, "stdout", 128, outputAbort.signal));
  try {
    const observed = await settleWithin(output, 2_000);
    if (!observed.settled || observed.value.ok) {
      throw new Error("Output-overflow fixture did not produce a handled stream failure");
    }
    if (!safeErrorMessage(observed.value.error).includes("exceeded 128 bytes")) {
      throw new Error("Output-overflow fixture produced the wrong handled failure");
    }
  } finally {
    outputAbort.abort();
    await terminateTrackedProcessGroup(child.pid, child);
  }
  if (activeDetachedGroups.has(child.pid) || isProcessGroupAlive(child.pid)) {
    throw new Error("Output-overflow fixture left its detached process group alive");
  }
}

async function assertProcessGroupCleanupFixture(): Promise<void> {
  assertNotTerminating();
  const child = Bun.spawn({
    cmd: ["/bin/sh", "-c", "sleep 30 & printf '%s\\n' \"$!\"; wait"],
    detached: true,
    stdout: "pipe",
    stderr: "ignore",
  });
  trackDetachedProcess(child);
  try {
    const reader = child.stdout.getReader();
    let reportedPid = "";
    while (!reportedPid.includes("\n") && reportedPid.length <= 32) {
      const chunk = await settleWithin(reader.read(), 2_000);
      if (!chunk.settled || chunk.value.done) {
        throw new Error("Process-group fixture did not report its generic descendant");
      }
      reportedPid += new TextDecoder().decode(chunk.value.value);
    }
    await reader.cancel();
    if (!/^\d+\n$/u.test(reportedPid)) throw new Error("Process-group fixture descendant PID was malformed");
    const inheritedPid = Number.parseInt(reportedPid, 10);
    if (!Number.isSafeInteger(inheritedPid) || inheritedPid <= 1 || inheritedPid === child.pid || !isAlive(inheritedPid)) {
      throw new Error("Process-group fixture reported an invalid generic descendant");
    }
    const cleanup = await terminateDiscoveredProcesses([{
      pid: child.pid,
      processGroupPid: child.pid,
      processGroupIsSafe: true,
      isSidecar: false,
      command: "fixture leader",
      line: "fixture leader",
    }]);
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    await settleWithin(child.exited, 2_000);
    if (isProcessGroupAlive(child.pid) || isAlive(inheritedPid)) {
      throw new Error("Process-group fixture left its generic descendant alive");
    }
    activeDetachedGroups.delete(child.pid);
  } finally {
    await terminateTrackedProcessGroup(child.pid, child);
  }
}

async function assertSidecarContainmentGraceFixture(): Promise<void> {
  const fixtureSource = `
    const tool = Bun.spawn({
      cmd: ["/bin/sh", "-c", "sleep 30"],
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    process.stdout.write(JSON.stringify({ toolProcessGroupPid: tool.pid }) + "\\n");
    await Bun.stdin.text();
    await Bun.sleep(5100);
    try { process.kill(-tool.pid, "SIGKILL"); } catch (error) {
      if (!error || error.code !== "ESRCH") throw error;
    }
    await tool.exited;
  `;
  assertNotTerminating();
  const sidecar = Bun.spawn({
    cmd: [process.execPath, "-e", fixtureSource],
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  trackDetachedProcess(sidecar);
  markContainmentAware(sidecar.pid, () => sidecar.stdin.end());
  // Begin the exact signal/fallback cleanup path before reading the tool PID.
  // This covers the race where the outer smoke knows only the sidecar leader.
  const containment = terminateDiscoveredProcesses([{
    pid: sidecar.pid,
    processGroupPid: sidecar.pid,
    processGroupIsSafe: true,
    isSidecar: true,
    command: "sidecar containment fixture",
    line: "sidecar containment fixture",
  }]);
  let toolProcessGroupPid: number | undefined;
  try {
    const reader = sidecar.stdout.getReader();
    let fixtureJson = "";
    while (!fixtureJson.includes("\n") && fixtureJson.length <= 256) {
      const chunk = await settleWithin(reader.read(), 2_000);
      if (!chunk.settled || chunk.value.done) {
        throw new Error("Sidecar containment fixture did not report its detached tool group");
      }
      fixtureJson += new TextDecoder().decode(chunk.value.value);
    }
    await reader.cancel();
    const fixture = requireRecord(JSON.parse(fixtureJson), "Sidecar containment fixture");
    toolProcessGroupPid = positiveFixturePid(fixture.toolProcessGroupPid, "toolProcessGroupPid");
    if (!isProcessGroupAlive(sidecar.pid) || !isProcessGroupAlive(toolProcessGroupPid)) {
      throw new Error("Sidecar containment fixture was not alive before parent loss");
    }
    const cleanup = await containment;
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    if (isProcessGroupAlive(sidecar.pid) || isProcessGroupAlive(toolProcessGroupPid)) {
      throw new Error("Sidecar containment fixture left its detached tool group alive");
    }
  } finally {
    sidecar.stdin.end();
    await terminateRegisteredProcessGroup(sidecar.pid, sidecar);
    if (toolProcessGroupPid && isProcessGroupAlive(toolProcessGroupPid)) {
      await terminateProcessGroup(toolProcessGroupPid);
    }
  }
}

async function drainOutput(
  outputs: [Promise<HandledOutput>, Promise<HandledOutput>],
  controller: AbortController,
  timeoutMs: number,
): Promise<[string, string]> {
  const drained = await settleWithin(Promise.all(outputs), timeoutMs);
  if (!drained.settled) {
    controller.abort();
    await settleWithin(Promise.all(outputs), 1_000);
    throw new Error(`Child output pipes did not close within ${timeoutMs}ms of process exit`);
  }
  const [stdout, stderr] = drained.value;
  if (!stdout.ok) throw stdout.error;
  if (!stderr.ok) throw stderr.error;
  return [stdout.value, stderr.value];
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ settled: false }>((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise({ settled: false }), timeoutMs);
  });
  const result = await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    expired,
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function terminateProcessGroup(processGroupPid: number, child?: SpawnedProcess): Promise<void> {
  if (!Number.isSafeInteger(processGroupPid) || processGroupPid <= 1 || processGroupPid === process.pid) {
    throw new Error(`Refusing to terminate unsafe process group ${processGroupPid}`);
  }
  if (isProcessGroupAlive(processGroupPid)) signalProcessGroup(processGroupPid, "SIGTERM");
  if (child) await settleWithin(child.exited, 750);
  if (!await waitForProcessGroupExit(processGroupPid, 750)) {
    signalProcessGroup(processGroupPid, "SIGKILL");
  }
  if (child) await settleWithin(child.exited, 2_000);
  if (!await waitForProcessGroupExit(processGroupPid, 2_000)) {
    throw new Error(`Process group ${processGroupPid} survived SIGKILL`);
  }
}

function signalProcessGroup(processGroupPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupPid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

async function waitForProcessGroupExit(processGroupPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupPid)) return true;
    await Bun.sleep(50);
  }
  return !isProcessGroupAlive(processGroupPid);
}

async function processStillExists(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return false;
    await Bun.sleep(100);
  }
  return isAlive(pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 2_000);
}

function assertNotTerminating(): void {
  if (terminationSignal) throw new Error(`Desktop smoke is terminating after ${terminationSignal}`);
}

async function waitForNoPackagedProcesses(
  isolatedUserData: string,
  sidecar: string,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let processes = await packagedProcesses(isolatedUserData, sidecar);
  while (processes.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    processes = await packagedProcesses(isolatedUserData, sidecar);
  }
  return processes.map((processInfo) => processInfo.line);
}

async function assertNoHostVisibleSidecarCredential(
  isolatedUserData: string,
  sidecar: string,
  launch: number,
  parentExited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const candidates = (await packagedProcesses(isolatedUserData, sidecar))
      .filter((entry) => entry.isSidecar);
    if (candidates.length > 1) {
      throw new Error(`Packaged desktop launch ${launch} had multiple sidecar processes during credential audit`);
    }
    const candidate = candidates[0];
    if (candidate) {
      const result = await runCapture(
        ["/bin/ps", "-Eww", "-p", String(candidate.pid), "-o", "command="],
        repositoryRoot,
        5_000,
        false,
        true,
      );
      const hostView = `${result.stdout}\n${result.stderr}`.trim();
      if (!hostView) {
        throw new Error(`Packaged desktop launch ${launch} sidecar had no host-visible process record`);
      }
      if (candidate.command !== sidecar) {
        throw new Error(`Packaged desktop launch ${launch} sidecar had a host-visible argv argument`);
      }
      if (!hostView.includes(sidecar)) {
        throw new Error(`Packaged desktop launch ${launch} environment record did not identify its sidecar`);
      }
      if (
        !hostView.includes("CHILI_DESKTOP_SMOKE=1")
        || !hostView.includes(`CHILI_HOME=${isolatedChiliHome}`)
      ) {
        throw new Error(`Packaged desktop launch ${launch} did not expose its non-secret environment fixtures`);
      }
      assertTextOmitsSensitiveNeedles(
        `Packaged desktop launch ${launch} sidecar argv and initial environment`,
        hostView,
        hostVisibleCredentialNeedles,
      );
      return;
    }
    if (parentExited()) {
      throw new Error(`Packaged desktop launch ${launch} exited before its host credential audit`);
    }
    await Bun.sleep(25);
  }
  throw new Error(`Packaged desktop launch ${launch} did not expose a sidecar for host credential audit`);
}

async function packagedProcesses(
  isolatedUserData: string,
  sidecar?: string,
  allowDuringCleanup = false,
): Promise<PackagedProcess[]> {
  const { stdout } = await runCapture(
    ["/bin/ps", "-axo", "pid=,pgid=,command="],
    repositoryRoot,
    5_000,
    allowDuringCleanup,
  );
  const rows: Array<{ pid: number; processGroupPid: number; command: string; line: string }> = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      processGroupPid: Number.parseInt(match[2]!, 10),
      command: match[3]!,
      line,
    });
  }
  const smokeProcessGroupPid = rows.find((row) => row.pid === process.pid)?.processGroupPid;
  if (!smokeProcessGroupPid) throw new Error("Unable to resolve the desktop smoke process group");
  const matches: PackagedProcess[] = [];
  for (const row of rows) {
    const command = row.command;
    const isOwnedHelper = command.includes(isolatedUserData);
    const isOwnedSidecar = Boolean(
      sidecar && (command === sidecar || command.startsWith(`${sidecar} `)),
    );
    if (!isOwnedHelper && !isOwnedSidecar) continue;
    if (row.pid !== process.pid) {
      matches.push({
        pid: row.pid,
        processGroupPid: row.processGroupPid,
        processGroupIsSafe: row.processGroupPid > 1 && row.processGroupPid !== smokeProcessGroupPid,
        isSidecar: isOwnedSidecar,
        command,
        line: row.line,
      });
    }
  }
  return matches;
}

async function terminateOwnedProcesses(isolatedUserData: string, sidecar?: string): Promise<void> {
  const initial = await packagedProcesses(isolatedUserData, sidecar, true);
  const initialResults = await terminateDiscoveredProcesses(initial);
  const failures = initialResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);

  // Always perform a second independent discovery pass. It catches children
  // that appeared while the first set was terminating, and a failed probe is
  // surfaced only after the temporary-root cleanup has still been attempted.
  const remaining = await packagedProcesses(isolatedUserData, sidecar, true);
  const remainingResults = await terminateDiscoveredProcesses(remaining);
  failures.push(...remainingResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown));
  if (failures.length > 0) throw new AggregateError(failures, `Failed to terminate owned processes for ${isolatedUserData}`);
}

async function terminateDiscoveredProcesses(processes: readonly PackagedProcess[]): Promise<PromiseSettledResult<void>[]> {
  const safeGroups = new Set(
    processes.filter((entry) => entry.processGroupIsSafe).map((entry) => entry.processGroupPid),
  );
  const groupedPids = new Set(
    processes.filter((entry) => safeGroups.has(entry.processGroupPid)).map((entry) => entry.pid),
  );
  const sidecarGroups = new Set(
    processes.filter((entry) => entry.isSidecar && safeGroups.has(entry.processGroupPid))
      .map((entry) => entry.processGroupPid),
  );
  return Promise.allSettled([
    ...[...safeGroups].map((processGroupPid) => sidecarGroups.has(processGroupPid)
      ? containmentPreparation.has(processGroupPid)
        ? terminateRegisteredProcessGroup(processGroupPid)
        : terminateSidecarAfterContainmentGrace(processGroupPid)
      : activeDetachedGroups.has(processGroupPid)
        ? terminateTrackedProcessGroup(processGroupPid)
        : terminateProcessGroup(processGroupPid)),
    ...processes.filter((entry) => !groupedPids.has(entry.pid)).map((entry) => terminatePid(entry.pid)),
  ]);
}

async function terminateSidecarAfterContainmentGrace(processGroupPid: number): Promise<void> {
  // The sidecar's parent-loss watchdog owns detached tool groups that cannot be
  // rediscovered from argv. Give its 5s containment deadline time to complete
  // before the outer fallback is allowed to kill the sidecar leader.
  if (await waitForProcessGroupExit(processGroupPid, SIDECAR_CONTAINMENT_GRACE_MS)) {
    const tracked = activeDetachedGroups.get(processGroupPid);
    if (tracked) await settleWithin(tracked.exited, 1_000);
    activeDetachedGroups.delete(processGroupPid);
    return;
  }
  if (activeDetachedGroups.has(processGroupPid)) {
    await terminateTrackedProcessGroup(processGroupPid);
  } else {
    await terminateProcessGroup(processGroupPid);
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Refusing to terminate unsafe PID ${pid}`);
  }
  if (isAlive(pid)) signalPid(pid, "SIGTERM");
  if (await processStillExists(pid, 500)) {
    signalPid(pid, "SIGKILL");
  }
  if (await processStillExists(pid, 2_000)) throw new Error(`PID ${pid} survived SIGKILL`);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function cleanupSmokeResources(): Promise<unknown[]> {
  resourceCleanup ??= performSmokeResourceCleanup();
  return resourceCleanup;
}

async function performSmokeResourceCleanup(): Promise<unknown[]> {
  // Close/kill every known Electron/build group first. Only then discover the
  // sidecar, so its stdin has reached EOF and its parent-loss watchdog gets the
  // full containment grace before any fallback signal targets its own group.
  const registeredCleanup = await Promise.allSettled([
    ...[...activeDetachedGroups.entries()].map(([pid, child]) => terminateRegisteredProcessGroup(pid, child)),
    ...[...activeDirectProcesses.entries()].map(([pid, child]) => terminateTrackedDirectProcess(pid, child)),
    ...[...observedBlockedGitProcessGroups].map((pid) => terminateProcessGroup(pid)),
  ]);
  const ownedCleanup = await Promise.allSettled([
    terminateOwnedProcesses(userData, packagedSidecar),
    terminateOwnedProcesses(hardCrashUserData, packagedSidecar),
  ]);
  const failures = [...registeredCleanup, ...ownedCleanup]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  const resourceResults = await Promise.allSettled([
    rm(temporaryRoot, { recursive: true, force: true }),
  ]);
  failures.push(...resourceResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown));
  return failures;
}

function cleanupFailedRelease(): Promise<unknown[]> {
  failedReleaseCleanup ??= (async (): Promise<unknown[]> => {
    try {
      await rm(releaseRoot, { recursive: true, force: true });
      return [];
    } catch (error) {
      return [error];
    }
  })();
  return failedReleaseCleanup;
}
