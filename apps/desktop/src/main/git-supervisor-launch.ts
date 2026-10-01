import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_SUPERVISOR_MODE } from "../shared/git-supervisor-protocol.js";

export interface GitSupervisorLaunch {
  executable: string;
  args: readonly string[];
}

export async function gitSupervisorLaunch(options: {
  repositoryRoot?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
} = {}): Promise<GitSupervisorLaunch> {
  if (options.isPackaged) {
    if (!options.resourcesPath) throw new Error("Packaged Git supervisor resources are unavailable");
    return { executable: resolve(options.resourcesPath, "chili-sidecar"), args: [GIT_SUPERVISOR_MODE] };
  }
  const source = options.repositoryRoot
    ? resolve(options.repositoryRoot, "apps/desktop/src/sidecar/entry.ts")
    : fileURLToPath(new URL("../sidecar/entry.ts", import.meta.url));
  const args = ["--no-env-file", "--config=/dev/null", "--no-install", source, GIT_SUPERVISOR_MODE];
  if (process.versions.bun) return { executable: process.execPath, args };
  if (!options.repositoryRoot) throw new Error("Desktop Git supervisor launch is not configured");
  // Resolve before scrubbing Git's environment. Packaged execution never reads
  // these development overrides and never launches Electron as a Node runtime.
  const configured = process.env.CHILI_BUN_PATH?.trim() || "bun";
  const candidates = isAbsolute(configured)
    ? [configured]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, configured));
  for (const executable of candidates) {
    try {
      await access(executable, constants.X_OK);
      return { executable, args };
    } catch {
      // Try the next development PATH entry, never Git's scrubbed PATH.
    }
  }
  throw new Error("Bun executable for the desktop Git supervisor was not found");
}
