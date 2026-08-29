import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = import.meta.dirname;
const repositoryRoot = resolve(packageRoot, "../..");

describe("local macOS package security", () => {
  test("keeps local packaging ad-hoc and disables notarization discovery", async () => {
    const source = await readFile(resolve(packageRoot, "electron-builder.config.ts"), "utf8");
    const viteConfig = await readFile(resolve(packageRoot, "electron.vite.config.ts"), "utf8");
    expect(source).toContain('const signingIdentity = process.env.CHILI_DESKTOP_SIGN_IDENTITY?.trim() || "-"');
    expect(source).toContain('if (signingIdentity !== "-")');
    expect(source).toContain("notarize: false");
    expect(viteConfig).toContain('const localAdHocBuild = desktopSigningIdentity === "-"');
    expect(viteConfig).toContain("__CHILI_DESKTOP_LOCAL_AD_HOC_BUILD__");
  });

  test("narrows only the Bun sidecar entitlements and preserves the Electron seal", async () => {
    const source = await readFile(resolve(packageRoot, "electron-builder.config.ts"), "utf8");
    const afterSign = source.indexOf("afterSign:");
    const sidecarSign = source.indexOf('await execFileAsync("/usr/bin/codesign"', afterSign);
    const outerSign = source.indexOf('await execFileAsync("/usr/bin/codesign"', sidecarSign + 1);
    const deepVerify = source.indexOf('await execFileAsync("/usr/bin/codesign"', outerSign + 1);
    expect(afterSign).toBeGreaterThan(0);
    expect(sidecarSign).toBeGreaterThan(afterSign);
    expect(outerSign).toBeGreaterThan(sidecarSign);
    expect(deepVerify).toBeGreaterThan(outerSign);

    const sidecarStep = source.slice(sidecarSign, outerSign);
    expect(sidecarStep).toContain('"--options",\n      "runtime"');
    expect(sidecarStep).toContain("sidecar");
    expect(sidecarStep).not.toContain("--entitlements");

    const outerStep = source.slice(outerSign, deepVerify);
    expect(outerStep).toContain(
      '"--preserve-metadata=identifier,entitlements,requirements,flags"',
    );
    expect(outerStep).toContain("application");

    const verifyStep = source.slice(deepVerify);
    expect(verifyStep).toContain('"--deep"');
    expect(verifyStep).toContain('"--strict"');
  });

  test("gates signature profiles and host-visible credentials in the final smoke", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts/smoke-desktop.ts"), "utf8");
    const rendererNeedlesStart = source.indexOf("const rendererSensitiveNeedles = uniqueNeedles([");
    const hostNeedlesStart = source.indexOf("const hostVisibleCredentialNeedles", rendererNeedlesStart);
    const rendererNeedles = source.slice(rendererNeedlesStart, hostNeedlesStart);
    expect(source).toContain("assertCodesigned(application, packagedSidecar)");
    expect(source).toContain("ELECTRON_HARDENED_RUNTIME_ENTITLEMENTS");
    expect(source).toContain('assertHardenedAdHocSignature(sidecar, "Bun sidecar", [])');
    expect(source).toContain('["/bin/ps", "-Eww", "-p", String(candidate.pid), "-o", "command="]');
    expect(source).toContain('redactFailureOutput ? " (captured output redacted)"');
    expect(source).toContain('{ label: "desktop token environment variable", value: "CHILI_DESKTOP_TOKEN=" }');
    expect(source).toContain("CHILI_DESKTOP_TOKEN: inheritedTokenCanary");
    expect(source).toContain("CHILI_HOME: isolatedChiliHome");
    expect(rendererNeedles).toContain(
      '{ label: "inherited desktop token canary", value: inheritedTokenCanary }',
    );
  });

  test("keeps the packaged sidecar credential on private fd 3", async () => {
    const manager = await readFile(resolve(packageRoot, "src/main/sidecar-manager.ts"), "utf8");
    const controlStream = await readFile(resolve(packageRoot, "src/main/sidecar-control-stream.ts"), "utf8");
    const sidecar = await readFile(resolve(packageRoot, "src/sidecar/index.ts"), "utf8");
    expect(manager).toContain('stdio: ["pipe", "pipe", "pipe", "pipe"]');
    expect(manager).toContain("delete env.CHILI_DESKTOP_TOKEN");
    expect(manager).toContain("child.stdio[SIDECAR_CREDENTIAL_FD]");
    expect(controlStream).toContain("export const SIDECAR_CREDENTIAL_FD = 3");
    expect(sidecar).toContain("fd: SIDECAR_CREDENTIAL_FD");
  });
});
