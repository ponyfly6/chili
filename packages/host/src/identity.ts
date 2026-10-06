import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionIdentity } from "@chili/protocol";
import { defaultAuthPath, defaultChiliHome } from "@chili/providers";

const execFileAsync = promisify(execFile);

export async function resolveHostExecutionIdentity(input: {
  cwd: string;
  chiliHome?: string;
  projectRoot?: string;
  authPath?: string;
}): Promise<ExecutionIdentity> {
  const profile = resolve(input.chiliHome ?? defaultChiliHome());
  await mkdir(profile, { recursive: true });
  const profilePath = await realpath(profile);
  const authPath = resolve(input.authPath ?? (input.chiliHome === undefined ? defaultAuthPath() : defaultAuthPath(profilePath)));
  const workspaceRoot = await realpath(resolve(input.cwd));
  let projectRoot = input.projectRoot ? await realpath(resolve(input.projectRoot)) : workspaceRoot;
  let projectKey = projectRoot;
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      timeout: 1_000, maxBuffer: 16_000,
    });
    const [root, common] = result.stdout.trim().split("\n");
    if (!input.projectRoot && root) projectRoot = await realpath(root);
    if (common) projectKey = await realpath(common);
  } catch {
    // Non-Git workspaces have their own canonical project identity.
  }
  return {
    profileId: resourceId("profile", `${profilePath}\0${authPath}`),
    profilePath,
    authPath,
    projectId: resourceId("project", projectKey),
    projectRoot,
    workspaceId: resourceId("workspace", workspaceRoot),
    workspaceRoot,
  };
}

function resourceId(kind: string, path: string): string {
  return `${kind}_${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}
