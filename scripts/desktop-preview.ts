import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createDesktopPreview, desktopPreviewBuildEnvironment } from "./desktop-preview-support.js";

if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
  throw new Error("Desktop Preview packaging requires an arm64 or x64 Mac");
}
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]?.trim())) {
  throw new Error("Usage: bun run desktop:preview [--output <parent-directory>]");
}
const preview = await createDesktopPreview({
  repositoryRoot: resolve(import.meta.dirname, ".."),
  outputRoot: arguments_[1] ? resolve(arguments_[1]) : join(homedir(), "Downloads", "Chili Previews"),
  architecture: process.arch,
  async build(input) {
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", "run", "desktop:package:dir"],
      cwd: input.repositoryRoot,
      env: desktopPreviewBuildEnvironment(process.env, input),
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Desktop Preview packaging failed with exit code ${exitCode}`);
  },
});
process.stdout.write(`${preview.manifest.label}\nLocal ad-hoc preview: ${preview.application}\nManifest: ${join(preview.directory, "build-manifest.json")}\nThe app has not been launched.\n`);
