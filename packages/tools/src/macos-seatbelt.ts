import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BashRunner } from "./builtins/bash.js";
import { runProcess, type RunProcessOptions, type RunProcessResult } from "./process.js";

export const MACOS_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

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

export function buildMacOsSeatbeltProfile(canonicalWorkspaceRoot: string): string {
  const workspace = resolve(canonicalWorkspaceRoot);
  assertProfileSafePath(workspace);
  const gitRegex = protectedPathRegex(workspace, ".git");
  const chiliRegex = protectedPathRegex(workspace, ".chili");

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
    (require-not (regex #"${chiliRegex}"))))

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
      const profile = buildMacOsSeatbeltProfile(workspaceRoot);
      const temporaryRoot = realpathSync.native(await mkdtemp(join(tmpdir(), "chili-seatbelt-")));
      const gitPath = join(workspaceRoot, ".git");
      const chiliPath = join(workspaceRoot, ".chili");
      const definitions = [
        `-DWORKSPACE_ROOT=${workspaceRoot}`,
        `-DTEMP_ROOT=${temporaryRoot}`,
        `-DPROTECTED_GIT=${gitPath}`,
        `-DPROTECTED_GIT_TARGET=${resolveGitMetadataTarget(gitPath)}`,
        `-DPROTECTED_CHILI=${chiliPath}`,
        `-DPROTECTED_CHILI_TARGET=${canonicalPathOrLogical(chiliPath)}`,
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

function assertProfileSafePath(path: string): void {
  if (path.includes("\0") || path.includes("\n") || path.includes("\r") || path.includes('"')) {
    throw new Error(`Workspace path cannot be represented safely in a Seatbelt profile: ${JSON.stringify(path)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
