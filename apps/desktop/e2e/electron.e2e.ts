#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const outputRoot = await mkdtemp(join(import.meta.dirname, ".node-run-"));
const outputFile = join(outputRoot, "harness.js");
let child: ReturnType<typeof Bun.spawn> | undefined;

try {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dirname, "harness.ts")],
    outdir: outputRoot,
    target: "node",
    packages: "external",
    sourcemap: "inline",
  });
  if (!build.success) {
    throw new Error(`Could not compile Electron E2E harness:\n${build.logs.map(String).join("\n")}`);
  }
  child = Bun.spawn({
    cmd: ["node", outputFile],
    cwd: repositoryRoot,
    env: {
      ...stringEnvironment(),
      CHILI_E2E_REPOSITORY_ROOT: repositoryRoot,
      CHILI_E2E_BUN_PATH: process.execPath,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(outputRoot, { recursive: true, force: true });
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
