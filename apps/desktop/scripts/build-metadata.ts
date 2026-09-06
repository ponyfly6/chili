import { execFileSync } from "node:child_process";
import type { DesktopBuildInfo } from "../src/shared/build-info.js";

export function desktopBuildMetadata(environment: NodeJS.ProcessEnv, repositoryRoot: string): DesktopBuildInfo {
  const channel = environment.CHILI_DESKTOP_BUILD_CHANNEL ?? "development";
  if (channel !== "development" && channel !== "preview") throw new Error("Invalid desktop build channel");
  let revision = environment.CHILI_DESKTOP_BUILD_REVISION;
  if (!revision && channel === "development") {
    try {
      revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
      }).trim();
    } catch { /* Source archives have no Git revision. */ }
  }
  if (!revision || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) {
    if (channel === "preview") throw new Error("Preview builds require a verified full Git revision");
    return { channel, revision: "unknown", label: "Development" };
  }
  return { channel, revision, label: `${channel === "preview" ? "Preview" : "Development"} · ${revision.slice(0, 12)}` };
}
