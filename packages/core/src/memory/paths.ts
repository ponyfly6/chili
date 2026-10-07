import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChiliMemoryDirectories, ChiliMemoryOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/** Resolve locations only. No directory creation, Memory reads, or database access. */
export async function resolveChiliMemoryDirectories(options: ChiliMemoryOptions): Promise<ChiliMemoryDirectories> {
  const requestedProfile = resolve(options.chiliHome ?? join(options.homeDir ?? homedir(), ".chili"));
  const profile = await realpath(requestedProfile).catch(() => requestedProfile);
  const projectId = options.projectId ?? await currentProjectId(options.projectRoot ?? options.cwd);
  const root = join(profile, "memory");
  return { root, personal: join(root, "personal"), project: join(root, "projects", memoryProjectDirectoryName(projectId)), projectId };
}

export function memoryProjectDirectoryName(id: string): string {
  return /^project_[a-f0-9]{32}$/.test(id) ? id : `project_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

async function currentProjectId(cwd: string): Promise<string> {
  let key = await realpath(resolve(cwd)).catch(() => resolve(cwd));
  try {
    const result = await execFileAsync("git", ["-C", key, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeout: 1_000, maxBuffer: 16_000,
    });
    const common = result.stdout.trim();
    if (common) key = await realpath(common);
  } catch {
    // Non-Git directories use their canonical project root, just like the Host.
  }
  return memoryProjectDirectoryName(key);
}
