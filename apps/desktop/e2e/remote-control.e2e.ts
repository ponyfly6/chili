#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { createBrowserTestCertificate } from "./remote-control-fixtures.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const outputRoot = await mkdtemp(join(import.meta.dirname, ".remote-node-run-"));
const fixtureRoot = await mkdtemp(join(tmpdir(), "chili-remote-browser-e2e-"));
const privateAddress = Object.entries(networkInterfaces()).sort(([left], [right]) => Number(!left.startsWith("en")) - Number(!right.startsWith("en")))
  .flatMap(([, addresses]) => addresses ?? []).find((address) => address.family === "IPv4" && !address.internal
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u.test(address.address))?.address ?? "127.0.0.1";
const certificate = await createBrowserTestCertificate(join(fixtureRoot, "certificate"), privateAddress);
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const build = await Bun.build({ entrypoints: [join(import.meta.dirname, "remote-control-harness.ts")],
    outdir: outputRoot, target: "node", packages: "external", sourcemap: "inline" });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  child = Bun.spawn({ cmd: ["node", join(outputRoot, "remote-control-harness.js")], cwd: repositoryRoot,
    env: { ...process.env, CHILI_E2E_REPOSITORY_ROOT: repositoryRoot, CHILI_E2E_BUN_PATH: process.execPath,
      CHILI_REMOTE_E2E_ROOT: fixtureRoot,
      CHILI_REMOTE_E2E_BIND_ADDRESS: privateAddress,
      // Playwright's fault-injection HTTP fetches also validate this one test CA.
      // This affects only the spawned harness process, never OS/browser trust.
      NODE_EXTRA_CA_CERTS: certificate.authority },
    stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(outputRoot, { recursive: true, force: true });
}
