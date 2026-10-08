#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserTestCertificate } from "./remote-control-fixtures.js";

// The native HTTP/vault boundary is a contract fixture. Browser crypto, the
// HTTPS host, Electron control service and compiled runtime are production code.
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const outputRoot = await mkdtemp(join(import.meta.dirname, ".mobile-node-run-"));
const fixtureRoot = await mkdtemp(join(tmpdir(), "chili-mobile-continuity-"));
const certificate = await createBrowserTestCertificate(join(fixtureRoot, "certificate"));
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const build = await Bun.build({ entrypoints: [join(import.meta.dirname, "mobile-continuity-harness.ts")],
    outdir: outputRoot, target: "node", packages: "external", sourcemap: "inline" });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  child = Bun.spawn({ cmd: ["node", join(outputRoot, "mobile-continuity-harness.js")], cwd: repositoryRoot,
    env: { ...process.env, CHILI_E2E_REPOSITORY_ROOT: repositoryRoot, CHILI_E2E_BUN_PATH: process.execPath,
      CHILI_MOBILE_E2E_ROOT: fixtureRoot, NODE_EXTRA_CA_CERTS: certificate.authority },
    stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(outputRoot, { recursive: true, force: true });
}
