import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import type { Configuration } from "electron-builder";

const packageRoot = import.meta.dirname;
const buildRoot = process.env.CHILI_DESKTOP_BUILD_ROOT || packageRoot;
const execFileAsync = promisify(execFile);
const signingIdentity = process.env.CHILI_DESKTOP_SIGN_IDENTITY?.trim() || "-";
if (signingIdentity !== "-") {
  throw new Error(
    "Desktop Developer ID signing is not implemented; local packaging requires an ad-hoc identity",
  );
}

const config: Configuration = {
  appId: "dev.chili.control",
  productName: "Chili",
  copyright: "Copyright © 2026 Chili contributors",
  directories: {
    app: buildRoot,
    output: process.env.CHILI_DESKTOP_PACKAGE_OUTPUT_DIR || "release",
    buildResources: resolve(packageRoot, "../../assets/brand"),
  },
  files: [
    "out/**/*",
    "package.json",
    "!node_modules/**/*",
    "!src/**/*",
    "!scripts/**/*",
    "!**/*.map",
    "!**/*.tsbuildinfo",
    "!**/*.test.*",
  ],
  extraResources: [{
    from: resolve(buildRoot, "resources/chili-sidecar"),
    to: "chili-sidecar",
  }, {
    from: process.env.CHILI_DESKTOP_BUILD_ROOT
      ? resolve(buildRoot, "resources/control-web")
      : resolve(packageRoot, "../control-web/dist"),
    to: "control-web",
  }],
  asar: true,
  npmRebuild: false,
  mac: {
    category: "public.app-category.developer-tools",
    icon: resolve(packageRoot, "../../assets/brand/chili-icon-512.png"),
    target: ["dmg", "zip"],
    // This iteration is deliberately local-only. Developer ID is rejected above
    // until a separate signing and notarization pipeline exists.
    identity: signingIdentity,
    hardenedRuntime: true,
    // This iteration intentionally produces a local validation artifact. Keep
    // electron-builder from auto-discovering APPLE_* credentials and turning a
    // developer's environment into an accidental notarization workflow.
    notarize: false,
  },
  dmg: {
    sign: false,
    title: "Chili ${version}",
  },
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  afterPack: async (context) => {
    if (context.electronPlatformName !== "darwin") return;
    const productFilename = context.packager.appInfo.productFilename;
    const application = join(context.appOutDir, `${productFilename}.app`);
    const executable = join(application, "Contents", "MacOS", productFilename);
    const sidecar = join(application, "Contents", "Resources", "chili-sidecar");
    const metadata = await stat(sidecar);
    if (!metadata.isFile()) throw new Error("Packaged Chili sidecar is not a file");
    await access(sidecar, constants.X_OK);
    const requestedArch = builderArchName(context.arch);
    if (requestedArch !== process.arch) {
      throw new Error(
        `Desktop packaging only supports the host architecture (${process.arch}); received ${requestedArch}`,
      );
    }
    const expectedSlice = requestedArch === "arm64" ? "arm64" : "x86_64";
    const [applicationSlices, sidecarSlices] = await Promise.all([
      machOSlices(executable),
      machOSlices(sidecar),
    ]);
    if (applicationSlices !== expectedSlice || sidecarSlices !== expectedSlice) {
      throw new Error(
        `Desktop executable slices did not match ${expectedSlice}: app=${applicationSlices}, sidecar=${sidecarSlices}`,
      );
    }

    // electron-builder 26 bundles @electron/fuses 1.8, which only knows wire
    // indices 0-7. Electron 42 has a ninth fuse, so configure the complete wire
    // with a current library and fail closed if Electron adds another fuse.
    await flipFuses(application, {
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      // Chili stores no auth material in Chromium cookies. Keeping encryption
      // disabled avoids an unnecessary Keychain dependency for local sessions.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    });
  },
  afterSign: async (context) => {
    if (context.electronPlatformName !== "darwin") return;
    const productFilename = context.packager.appInfo.productFilename;
    const application = join(context.appOutDir, `${productFilename}.app`);
    const sidecar = join(application, "Contents", "Resources", "chili-sidecar");

    // electron-builder applies its Electron child entitlement template to every
    // nested executable, including extraResources. The Bun sidecar requires no
    // such capability. Replace only its signature, then refresh the outer
    // resource seal while preserving the already-signed Electron executable's
    // identifier, entitlements, requirements, and hardened-runtime flags.
    await execFileAsync("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      sidecar,
    ]);
    await execFileAsync("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--preserve-metadata=identifier,entitlements,requirements,flags",
      "--timestamp=none",
      application,
    ]);
    await execFileAsync("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      application,
    ]);
  },
};

function builderArchName(arch: number): NodeJS.Architecture {
  if (arch === 1) return "x64";
  if (arch === 3) return "arm64";
  throw new Error(`Unsupported desktop package architecture enum: ${arch}`);
}

async function machOSlices(executable: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", executable]);
  return stdout.trim().split(/\s+/u).sort().join(" ");
}

export default config;
