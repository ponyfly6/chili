import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface DesktopPreviewManifest {
  schemaVersion: 1;
  productName: "Chili Preview";
  channel: "preview";
  revision: string;
  label: string;
  builtAt: string;
  platform: "darwin";
  architecture: "arm64" | "x64";
  signing: "ad-hoc";
  distribution: "local-preview";
  application: string;
  sha256: { executable: string; asar: string; sidecar: string };
}

export interface DesktopPreviewBuildInput {
  repositoryRoot: string;
  buildRoot: string;
  releaseRoot: string;
  revision: string;
}

export interface DesktopPreviewResult {
  directory: string;
  application: string;
  manifest: DesktopPreviewManifest;
}

/** The only ignored untracked files are the existing browser inspection artifacts. */
export function assertPreviewGitState(repositoryRoot: string): string {
  const revision = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) throw new Error("Preview requires a committed Git revision");
  const records = git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (const record of records) {
    if (!record) continue;
    if (record.startsWith("?? ") && record.slice(3).startsWith(".playwright-cli/")) continue;
    if (record.startsWith("?? ")) throw new Error("Preview requires all source files to be committed; untracked files remain");
    throw new Error("Preview requires a clean Git checkout; commit or discard tracked changes first");
  }
  // Local exclude rules must not hide source that the build would still consume.
  const ignoredSource = git(repositoryRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--",
    ":(glob)apps/*/src/**", ":(glob)apps/*/scripts/**", ":(glob)apps/*/*.ts",
    ":(glob)packages/*/src/**", ":(glob)packages/*/*.ts", ":(glob)scripts/**"]);
  if (ignoredSource) throw new Error("Preview requires all source files to be committed; ignored untracked source remains");
  return revision;
}

/** Each call owns one newly created directory; neither siblings nor outputRoot are removed. */
export async function createDesktopPreview(options: {
  repositoryRoot: string;
  outputRoot: string;
  architecture: "arm64" | "x64";
  build(input: DesktopPreviewBuildInput): Promise<void>;
}): Promise<DesktopPreviewResult> {
  const repositoryRoot = await realpath(options.repositoryRoot);
  const revision = assertPreviewGitState(repositoryRoot);
  const outputPath = resolve(options.outputRoot);
  if (isWithin(repositoryRoot, outputPath)) throw new Error("Preview output must be outside the source checkout");
  if (isWithin(repositoryRoot, await resolveProspectivePath(outputPath))) {
    throw new Error("Preview output must be outside the source checkout");
  }
  await mkdir(outputPath, { recursive: true, mode: 0o700 });
  const outputRoot = await realpath(outputPath);
  if (isWithin(repositoryRoot, outputRoot)) throw new Error("Preview output must be outside the source checkout");
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const directory = await mkdtemp(join(outputRoot, `preview-${revision.slice(0, 12)}-${timestamp}-`));
  const owner = randomBytes(24).toString("hex");
  const ownerFile = join(directory, ".preview-owner");
  await writeFile(ownerFile, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const buildRoot = join(directory, "build");
    const releaseRoot = join(directory, "release");
    await options.build({ repositoryRoot, buildRoot, releaseRoot, revision });
    if (assertPreviewGitState(repositoryRoot) !== revision) throw new Error("Git revision changed during the preview build");
    const applicationRelative = `release/${options.architecture === "arm64" ? "mac-arm64" : "mac"}/Chili Preview.app`;
    const application = join(directory, applicationRelative);
    if (!(await lstat(application)).isDirectory() || !(await realpath(application)).startsWith(`${directory}${sep}`)) {
      throw new Error("Preview package is not an owned application directory");
    }
    const hashes = await Promise.all([
      hashOwnedFile(directory, join(application, "Contents/MacOS/Chili Preview")),
      hashOwnedFile(directory, join(application, "Contents/Resources/app.asar")),
      hashOwnedFile(directory, join(application, "Contents/Resources/chili-sidecar")),
    ]);
    const manifest: DesktopPreviewManifest = {
      schemaVersion: 1,
      productName: "Chili Preview",
      channel: "preview",
      revision,
      label: `Preview · ${revision.slice(0, 12)}`,
      builtAt: new Date().toISOString(),
      platform: "darwin",
      architecture: options.architecture,
      signing: "ad-hoc",
      distribution: "local-preview",
      application: applicationRelative,
      sha256: { executable: hashes[0]!, asar: hashes[1]!, sidecar: hashes[2]! },
    };
    await writeFile(join(directory, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await assertOwnedDirectory(directory, owner);
    await rm(buildRoot, { recursive: true, force: true });
    await rm(ownerFile);
    return { directory, application, manifest };
  } catch (error) {
    await assertOwnedDirectory(directory, owner);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Do not forward provider keys, desktop state, TLS paths or signing credentials. */
export function desktopPreviewBuildEnvironment(environment: NodeJS.ProcessEnv, input: DesktopPreviewBuildInput): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return {
    ...result,
    CHILI_DESKTOP_BUILD_CHANNEL: "preview",
    CHILI_DESKTOP_BUILD_REVISION: input.revision,
    CHILI_DESKTOP_BUILD_ROOT: input.buildRoot,
    CHILI_DESKTOP_PACKAGE_OUTPUT_DIR: input.releaseRoot,
    CHILI_DESKTOP_SIGN_IDENTITY: "-",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
}

async function hashOwnedFile(directory: string, path: string): Promise<string> {
  if (!(await lstat(path)).isFile() || !(await realpath(path)).startsWith(`${directory}${sep}`)) {
    throw new Error("Preview contains an unexpected artifact reference");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertOwnedDirectory(directory: string, owner: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory
    || await readFile(join(directory, ".preview-owner"), "utf8") !== owner) {
    throw new Error("Preview cleanup refused an unowned output directory");
  }
}

/** Resolve existing parents before mkdir can follow a link back into the checkout. */
async function resolveProspectivePath(path: string): Promise<string> {
  let ancestor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...missing);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      // An existing dangling link must not be mistaken for a missing directory.
      let exists = false;
      try {
        await lstat(ancestor);
        exists = true;
      } catch (statError) {
        if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") throw statError;
      }
      if (exists) throw new Error("Preview output contains an unresolved filesystem link");
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function isWithin(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !local.startsWith(sep));
}

function git(repositoryRoot: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
}
