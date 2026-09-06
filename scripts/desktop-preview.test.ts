import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPreviewGitState, createDesktopPreview, desktopPreviewBuildEnvironment, type DesktopPreviewBuildInput } from "./desktop-preview-support.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("desktop preview delivery", () => {
  test("requires committed source and rejects tracked, staged, renamed and untracked changes", async () => {
    const fixture = await repository();
    const revision = assertPreviewGitState(fixture.repositoryRoot);
    expect(revision).toMatch(/^[a-f0-9]{40}$/u);
    await writeFile(join(fixture.repositoryRoot, "source.ts"), "changed\n");
    expect(() => assertPreviewGitState(fixture.repositoryRoot)).toThrow("clean Git checkout");
    git(fixture.repositoryRoot, ["add", "source.ts"]);
    expect(() => assertPreviewGitState(fixture.repositoryRoot)).toThrow("clean Git checkout");
    git(fixture.repositoryRoot, ["reset", "--hard", "HEAD"]);
    git(fixture.repositoryRoot, ["mv", "source.ts", "renamed.ts"]);
    expect(() => assertPreviewGitState(fixture.repositoryRoot)).toThrow("clean Git checkout");
    git(fixture.repositoryRoot, ["reset", "--hard", "HEAD"]);
    await writeFile(join(fixture.repositoryRoot, "new-source.ts"), "untracked\n");
    expect(() => assertPreviewGitState(fixture.repositoryRoot)).toThrow("untracked files");
    await rm(join(fixture.repositoryRoot, "new-source.ts"));
    await mkdir(join(fixture.repositoryRoot, ".playwright-cli"));
    await writeFile(join(fixture.repositoryRoot, ".playwright-cli", "page.yaml"), "inspection\n");
    expect(assertPreviewGitState(fixture.repositoryRoot)).toBe(revision);
  });

  test("two deliveries own distinct persistent version roots and preserve old output", async () => {
    const fixture = await repository();
    const old = join(fixture.outputRoot, "old-release");
    await mkdir(old);
    await writeFile(join(old, "keep"), "old app\n");
    const first = await createDesktopPreview({ ...fixture, architecture: "arm64", build: packageFixture });
    const second = await createDesktopPreview({ ...fixture, architecture: "arm64", build: packageFixture });
    expect(first.directory).not.toBe(second.directory);
    expect(await readFile(join(old, "keep"), "utf8")).toBe("old app\n");
    expect(await readdir(first.directory)).toEqual(["build-manifest.json", "release"]);
    expect(await readFile(join(first.application, "Contents/MacOS/Chili Preview"), "utf8")).toBe("executable\n");
    const manifestText = await readFile(join(first.directory, "build-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    expect(Object.keys(manifest).sort()).toEqual(["application", "architecture", "builtAt", "channel", "distribution", "label", "platform", "productName", "revision", "schemaVersion", "sha256", "signing"].sort());
    expect(manifest.revision).toBe(assertPreviewGitState(fixture.repositoryRoot));
    expect(manifest.application).toBe("release/mac-arm64/Chili Preview.app");
    expect(manifestText).not.toContain(fixture.repositoryRoot);
    expect(manifestText).not.toContain(fixture.outputRoot);
    expect(manifest.sha256.executable).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("local ignore rules cannot hide untracked application source", async () => {
    const fixture = await repository();
    await mkdir(join(fixture.repositoryRoot, "apps/desktop/src"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, ".git/info/exclude"), "apps/desktop/src/hidden.ts\n");
    await writeFile(join(fixture.repositoryRoot, "apps/desktop/src/hidden.ts"), "untracked build input\n");
    expect(() => assertPreviewGitState(fixture.repositoryRoot)).toThrow("ignored untracked source");
  });

  test("failed build removes only its own new directory", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.outputRoot, "existing-app"), "preserve\n");
    let ownRoot: string | undefined;
    await expect(createDesktopPreview({ ...fixture, architecture: "arm64", async build(input) {
      ownRoot = input.buildRoot;
      await mkdir(input.buildRoot, { recursive: true });
      throw new Error("fixture build failure");
    } })).rejects.toThrow("fixture build failure");
    expect(ownRoot).toBeDefined();
    expect(await readdir(fixture.outputRoot)).toEqual(["existing-app"]);
  });

  test("does not build dirty source or use output inside checkout", async () => {
    const fixture = await repository();
    let calls = 0;
    const build = async () => { calls++; };
    await expect(createDesktopPreview({ ...fixture, outputRoot: join(fixture.repositoryRoot, "release"), architecture: "arm64", build })).rejects.toThrow("outside the source checkout");
    await writeFile(join(fixture.repositoryRoot, "source.ts"), "dirty\n");
    await expect(createDesktopPreview({ ...fixture, architecture: "arm64", build })).rejects.toThrow("clean Git checkout");
    expect(calls).toBe(0);
    expect(await readdir(fixture.outputRoot)).toEqual([]);
  });

  test("rejects output parents linked into the checkout before creating directories", async () => {
    const fixture = await repository();
    const revision = assertPreviewGitState(fixture.repositoryRoot);
    const alias = join(fixture.outputRoot, "checkout-link");
    await symlink(fixture.repositoryRoot, alias);
    let calls = 0;
    await expect(createDesktopPreview({ ...fixture, outputRoot: join(alias, "new", "delivery"), architecture: "arm64", async build() {
      calls++;
    } })).rejects.toThrow("outside the source checkout");
    expect(calls).toBe(0);
    expect((await readdir(fixture.repositoryRoot)).sort()).toEqual([".git", "source.ts"]);
    expect(assertPreviewGitState(fixture.repositoryRoot)).toBe(revision);
    expect(await readdir(fixture.outputRoot)).toEqual(["checkout-link"]);
  });

  test("supports new output hierarchies through an external directory link", async () => {
    const fixture = await repository();
    const target = join(fixture.outputRoot, "external");
    const alias = join(fixture.outputRoot, "external-link");
    await mkdir(target);
    await symlink(target, alias);
    const result = await createDesktopPreview({ ...fixture, outputRoot: join(alias, "new", "delivery"), architecture: "arm64", build: packageFixture });
    expect(result.directory).toStartWith(join(await realpath(target), "new", "delivery"));
    expect(await readFile(join(result.application, "Contents/MacOS/Chili Preview"), "utf8")).toBe("executable\n");
  });

  test("rejects source changes during build instead of stamping the old revision", async () => {
    const fixture = await repository();
    await expect(createDesktopPreview({ ...fixture, architecture: "arm64", async build(input) {
      await packageFixture(input);
      await writeFile(join(fixture.repositoryRoot, "source.ts"), "changed during build\n");
    } })).rejects.toThrow("clean Git checkout");
    expect(await readdir(fixture.outputRoot)).toEqual([]);
  });

  test("rejects a package artifact symlink without touching its target", async () => {
    const fixture = await repository();
    const outside = join(fixture.outputRoot, "existing-app");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "old app\n");
    await expect(createDesktopPreview({ ...fixture, architecture: "arm64", async build(input) {
      const parent = join(input.releaseRoot, "mac-arm64");
      await mkdir(parent, { recursive: true });
      await symlink(outside, join(parent, "Chili Preview.app"));
    } })).rejects.toThrow("owned application directory");
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("old app\n");
    expect(await readdir(fixture.outputRoot)).toEqual(["existing-app"]);
  });

  test("build environment does not inherit auth, remote setup, signing or output overrides", () => {
    const input = { repositoryRoot: "/fixture/source", buildRoot: "/fixture/build", releaseRoot: "/fixture/release", revision: "a".repeat(40) };
    const environment = desktopPreviewBuildEnvironment({ PATH: "/fixture/bin", HOME: "/fixture/home", CHILI_HOME: "sensitive-home",
      OPENAI_API_KEY: "secret-key", CHILI_REMOTE_TLS_KEY: "secret-path", APPLE_ID: "private-account",
      CSC_LINK: "private-signing", CHILI_DESKTOP_PACKAGE_OUTPUT_DIR: "old-release", CHILI_DESKTOP_BUILD_CHANNEL: "wrong" }, input);
    expect(environment.PATH).toBe("/fixture/bin");
    expect(environment.CHILI_DESKTOP_PACKAGE_OUTPUT_DIR).toBe(input.releaseRoot);
    expect(environment.CHILI_DESKTOP_BUILD_CHANNEL).toBe("preview");
    expect(environment.CHILI_DESKTOP_SIGN_IDENTITY).toBe("-");
    for (const forbidden of ["CHILI_HOME", "OPENAI_API_KEY", "CHILI_REMOTE_TLS_KEY", "APPLE_ID", "CSC_LINK"]) {
      expect(environment[forbidden]).toBeUndefined();
    }
  });
});

async function repository(): Promise<{ repositoryRoot: string; outputRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "chili-preview-unit-"));
  roots.push(root);
  const repositoryRoot = join(root, "source");
  const outputRoot = join(root, "deliveries");
  await mkdir(repositoryRoot);
  await mkdir(outputRoot);
  git(repositoryRoot, ["init", "--quiet"]);
  await writeFile(join(repositoryRoot, "source.ts"), "original\n");
  git(repositoryRoot, ["add", "source.ts"]);
  git(repositoryRoot, ["-c", "user.name=Chili fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  return { repositoryRoot, outputRoot };
}

async function packageFixture(input: DesktopPreviewBuildInput): Promise<void> {
  await mkdir(input.buildRoot, { recursive: true });
  const application = join(input.releaseRoot, "mac-arm64", "Chili Preview.app", "Contents");
  await mkdir(join(application, "MacOS"), { recursive: true });
  await mkdir(join(application, "Resources"), { recursive: true });
  await writeFile(join(application, "MacOS", "Chili Preview"), "executable\n");
  await writeFile(join(application, "Resources", "app.asar"), "asar\n");
  await writeFile(join(application, "Resources", "chili-sidecar"), "sidecar\n");
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
}
