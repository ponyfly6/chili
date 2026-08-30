import { chmod, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const buildRoot = process.env.CHILI_DESKTOP_BUILD_ROOT || packageRoot;
const output = resolve(buildRoot, "resources/chili-sidecar");
const target = compileTarget(process.platform, process.arch);

await mkdir(resolve(buildRoot, "resources"), { recursive: true });
if (buildRoot !== packageRoot) {
  await copyFile(resolve(packageRoot, "package.json"), resolve(buildRoot, "package.json"));
}

const child = Bun.spawn({
  cmd: [
    process.execPath,
    "build",
    "--compile",
    "--production",
    `--target=${target}`,
    `--outfile=${output}`,
    resolve(packageRoot, "src/sidecar/index.ts"),
  ],
  cwd: resolve(packageRoot, "../.."),
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Desktop sidecar build failed with exit code ${exitCode}`);
await chmod(output, 0o755);

function compileTarget(platform: NodeJS.Platform, arch: string): string {
  const targetPlatform = platform === "win32" ? "windows" : platform;
  if (!(["darwin", "linux", "windows"] as string[]).includes(targetPlatform)) {
    throw new Error(`Unsupported desktop sidecar platform: ${platform}`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported desktop sidecar architecture: ${arch}`);
  }
  return `bun-${targetPlatform}-${arch}`;
}
