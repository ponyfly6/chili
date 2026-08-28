import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdtemp, opendir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BashRunner } from "./builtins/bash.js";
import { runProcess, type RunProcessOptions, type RunProcessResult } from "./process.js";

export const MACOS_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const MAX_PROTECTED_METADATA_ENTRIES = 100_000;
const MAX_PROTECTED_METADATA_SYMLINK_TARGETS = 4_096;

export interface MacOsSeatbeltBashRunnerOptions {
  processRunner?: (
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
  ) => Promise<RunProcessResult>;
}

const BASE_POLICY = String.raw`(version 1)

(deny default)

; Child processes inherit this profile, so nested sandbox-exec cannot relax it.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; Phase one intentionally permits reads while restricting all writes below.
(allow file-read*)
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; Runtime discovery used by shells, Bun, Node, Python, and common build tools.
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow user-preference-read)
`;

export function buildMacOsSeatbeltProfile(
  canonicalWorkspaceRoot: string,
  protectedSymlinkTargets: readonly string[] = [],
): string {
  const workspace = resolve(canonicalWorkspaceRoot);
  assertProfileSafePath(workspace);
  const gitRegex = protectedPathRegex(workspace, ".git");
  const chiliRegex = protectedPathRegex(workspace, ".chili");
  const normalizedSymlinkTargets = [...new Set(protectedSymlinkTargets.map((path) => resolve(path)))];
  if (normalizedSymlinkTargets.length > MAX_PROTECTED_METADATA_SYMLINK_TARGETS) {
    throw new Error(
      `Refusing to build macOS Seatbelt profile with more than `
      + `${MAX_PROTECTED_METADATA_SYMLINK_TARGETS} protected symlink targets.`,
    );
  }
  const symlinkTargetDenials = normalizedSymlinkTargets
    .map((path) => {
      assertProfileSafePath(path);
      const literal = seatbeltStringLiteral(path);
      return `    (require-not (literal "${literal}"))\n    (require-not (subpath "${literal}"))`;
    })
    .join("\n");
  const dynamicDenials = symlinkTargetDenials.length > 0 ? `\n${symlinkTargetDenials}` : "";

  return `${BASE_POLICY}
; Workspace writes are allowed except for agent and VCS control metadata.
(allow file-write*
  (require-all
    (subpath (param "WORKSPACE_ROOT"))
    (require-not (literal (param "PROTECTED_GIT")))
    (require-not (subpath (param "PROTECTED_GIT")))
    (require-not (literal (param "PROTECTED_GIT_TARGET")))
    (require-not (subpath (param "PROTECTED_GIT_TARGET")))
    (require-not (literal (param "PROTECTED_CHILI")))
    (require-not (subpath (param "PROTECTED_CHILI")))
    (require-not (literal (param "PROTECTED_CHILI_TARGET")))
    (require-not (subpath (param "PROTECTED_CHILI_TARGET")))
    (require-not (regex #"${gitRegex}"))
    (require-not (regex #"${chiliRegex}"))${dynamicDenials}))

; Each invocation receives a private temporary directory that is removed by Chili.
(allow file-write* (subpath (param "TEMP_ROOT")))
`;
}

export function createMacOsSeatbeltBashRunner(options: MacOsSeatbeltBashRunnerOptions = {}): BashRunner {
  const processRunner = options.processRunner ?? runProcess;

  return {
    async run(request) {
      const workspaceRoot = realpathSync.native(resolve(request.workspaceRoot));
      assertCwdInsideWorkspace(workspaceRoot, request.cwd);
      const gitPath = join(workspaceRoot, ".git");
      const chiliPath = join(workspaceRoot, ".chili");
      const gitTarget = resolveGitMetadataTarget(gitPath);
      const chiliTarget = canonicalPathOrLogical(chiliPath);
      const protectedSymlinkTargets = await inspectProtectedMetadataTrees([
        { label: ".git", path: gitPath },
        { label: ".git target", path: gitTarget },
        { label: ".chili", path: chiliPath },
        { label: ".chili target", path: chiliTarget },
      ]);
      // Exact canonical symlink targets preserve compatible metadata layouts while
      // preventing writes through aliases that resolve outside the protected roots.
      const profile = buildMacOsSeatbeltProfile(workspaceRoot, protectedSymlinkTargets);
      const temporaryRoot = realpathSync.native(await mkdtemp(join(tmpdir(), "chili-seatbelt-")));
      const definitions = [
        `-DWORKSPACE_ROOT=${workspaceRoot}`,
        `-DTEMP_ROOT=${temporaryRoot}`,
        `-DPROTECTED_GIT=${gitPath}`,
        `-DPROTECTED_GIT_TARGET=${gitTarget}`,
        `-DPROTECTED_CHILI=${chiliPath}`,
        `-DPROTECTED_CHILI_TARGET=${chiliTarget}`,
      ];
      const processOptions: RunProcessOptions = {
        cwd: request.cwd,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        env: {
          ...request.env,
          TMPDIR: temporaryRoot,
          TMP: temporaryRoot,
          TEMP: temporaryRoot,
          XDG_CACHE_HOME: join(temporaryRoot, "cache"),
          CHILI_SANDBOX: "macos-seatbelt",
          CHILI_SANDBOX_NETWORK_DISABLED: "1",
        },
      };
      if (request.onOutput) processOptions.onOutput = request.onOutput;
      if (request.onRawOutput) processOptions.onRawOutput = request.onRawOutput;
      try {
        const result = await processRunner(
          MACOS_SANDBOX_EXEC_PATH,
          ["-p", profile, ...definitions, "--", "/bin/bash", "-lc", request.command],
          processOptions,
        );
        return { ...result, sandbox: "macos-seatbelt" };
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}

interface ProtectedMetadataRoot {
  label: string;
  path: string;
}

async function inspectProtectedMetadataTrees(
  roots: readonly ProtectedMetadataRoot[],
): Promise<string[]> {
  const state: ProtectedMetadataInspectionState = {
    inspectedEntries: 0,
    symlinkTargets: new Set<string>(),
    visitedDirectories: new Set<string>(),
  };
  for (const root of roots) {
    const path = resolve(root.path);
    await inspectProtectedMetadataTree({ ...root, path }, state);
  }
  return [...state.symlinkTargets];
}

interface ProtectedMetadataInspectionState {
  inspectedEntries: number;
  symlinkTargets: Set<string>;
  visitedDirectories: Set<string>;
}

async function inspectProtectedMetadataTree(
  root: ProtectedMetadataRoot,
  state: ProtectedMetadataInspectionState,
): Promise<void> {
  const rootInfo = await inspectProtectedMetadataPath(root, root.path, true);
  if (!rootInfo) return;
  if (rootInfo.isSymbolicLink()) {
    await recordProtectedMetadataSymlinkTarget(root, root.path, state, []);
    return;
  }
  assertProtectedMetadataFileHasNoAliases(root, root.path, rootInfo);
  if (!rootInfo.isDirectory()) return;

  const pendingDirectories = [root.path];
  while (pendingDirectories.length > 0) {
    const requestedDirectory = pendingDirectories.pop();
    if (!requestedDirectory) continue;
    let directory: string;
    try {
      directory = await realpath(requestedDirectory);
    } catch (error) {
      throw protectedMetadataInspectionError(root, requestedDirectory, error);
    }
    if (state.visitedDirectories.has(directory)) continue;
    state.visitedDirectories.add(directory);
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throw protectedMetadataInspectionError(root, directory, error);
    }
    try {
      for await (const entry of handle) {
        state.inspectedEntries += 1;
        if (state.inspectedEntries > MAX_PROTECTED_METADATA_ENTRIES) {
          throw new Error(
            `Refusing to launch macOS Seatbelt: protected metadata trees `
            + `exceeds ${MAX_PROTECTED_METADATA_ENTRIES} entries; hard-link and symlink safety cannot be verified.`,
          );
        }
        const entryPath = join(directory, entry.name);
        const info = await inspectProtectedMetadataPath(root, entryPath, false);
        if (!info) continue;
        if (info.isSymbolicLink()) {
          await recordProtectedMetadataSymlinkTarget(root, entryPath, state, pendingDirectories);
          continue;
        }
        assertProtectedMetadataFileHasNoAliases(root, entryPath, info);
        if (info.isDirectory()) pendingDirectories.push(entryPath);
      }
    } catch (error) {
      if (isProtectedMetadataSafetyError(error)) throw error;
      throw protectedMetadataInspectionError(root, directory, error);
    }
  }
}

async function recordProtectedMetadataSymlinkTarget(
  root: ProtectedMetadataRoot,
  path: string,
  state: ProtectedMetadataInspectionState,
  pendingDirectories: string[],
): Promise<void> {
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    throw protectedMetadataInspectionError(root, path, error);
  }
  if (!state.symlinkTargets.has(target)) {
    if (state.symlinkTargets.size >= MAX_PROTECTED_METADATA_SYMLINK_TARGETS) {
      throw new Error(
        `Refusing to launch macOS Seatbelt: protected metadata trees exceed `
        + `${MAX_PROTECTED_METADATA_SYMLINK_TARGETS} symlink targets; alias safety cannot be verified.`,
      );
    }
    state.symlinkTargets.add(target);
  }
  let targetInfo: Stats;
  try {
    targetInfo = await stat(path);
  } catch (error) {
    throw protectedMetadataInspectionError(root, path, error);
  }
  assertProtectedMetadataFileHasNoAliases(root, target, targetInfo);
  if (targetInfo.isDirectory()) pendingDirectories.push(target);
}

async function inspectProtectedMetadataPath(
  root: ProtectedMetadataRoot,
  path: string,
  allowMissing: boolean,
): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (allowMissing && isNotFound(error)) return undefined;
    throw protectedMetadataInspectionError(root, path, error);
  }
}

function assertProtectedMetadataFileHasNoAliases(
  root: ProtectedMetadataRoot,
  path: string,
  info: Stats,
): void {
  if (!info.isFile() || info.nlink <= 1) return;
  throw new Error(
    `Refusing to launch macOS Seatbelt: protected metadata file ${path} (${root.label}) `
    + `has ${info.nlink} hard links; remove its aliases before running sandboxed commands.`,
  );
}

function protectedMetadataInspectionError(root: ProtectedMetadataRoot, path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Refusing to launch macOS Seatbelt: cannot safely inspect protected metadata path `
    + `${path} (${root.label}): ${message}`,
  );
}

function isProtectedMetadataSafetyError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Refusing to launch macOS Seatbelt:");
}

function assertCwdInsideWorkspace(workspaceRoot: string, cwd: string): void {
  const canonicalCwd = realpathSync.native(resolve(cwd));
  const path = relative(workspaceRoot, canonicalCwd);
  if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))) {
    return;
  }
  throw new Error(`Bash cwd must stay inside its workspace: ${cwd}`);
}

function resolveGitMetadataTarget(gitPath: string): string {
  let target = canonicalPathOrLogical(gitPath);
  try {
    if (!statSync(gitPath).isFile()) return target;
    const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(readFileSync(gitPath, "utf8"));
    if (!pointer?.[1]) return target;
    target = canonicalPathOrLogical(resolve(dirname(gitPath), pointer[1]));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return target;
}

function canonicalPathOrLogical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isNotFound(error)) return resolve(path);
    throw error;
  }
}

function protectedPathRegex(workspace: string, name: string): string {
  return `^${regexEscape(workspace)}/${regexEscape(name)}(/.*)?$`.replaceAll('"', '\\"');
}

function regexEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function seatbeltStringLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\");
}

function assertProfileSafePath(path: string): void {
  if (path.includes("\0") || path.includes("\n") || path.includes("\r") || path.includes('"')) {
    throw new Error(`Workspace path cannot be represented safely in a Seatbelt profile: ${JSON.stringify(path)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
