import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "chili-code-mode-compiled-"));
try {
  const binary = join(temporary, process.platform === "win32" ? "code-mode.exe" : "code-mode");
  const build = Bun.spawn({
    cmd: [process.execPath, "build", "--compile", `--root=${root}`, `--outfile=${binary}`,
      resolve(root, "scripts/fixtures/code-mode-compiled.ts"),
      resolve(root, "packages/tools/src/code-mode/worker.ts"),
      resolve(root, "packages/tools/src/input-schema-worker.ts")],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    signal: AbortSignal.timeout(60_000),
  });
  if (await build.exited !== 0) throw new Error("Code mode smoke binary failed to compile");
  // An unrelated empty cwd proves the runtime uses its embedded worker and WASM.
  const run = Bun.spawn({ cmd: [binary], cwd: temporary, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) });
  const [status, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  if (status !== 0 || !stdout.includes("CODE_MODE_COMPILED_OK")) {
    throw new Error(`Compiled code mode smoke failed (${status})\n${stdout}\n${stderr}`);
  }
  console.log(stdout.trim());
} finally {
  await rm(temporary, { recursive: true, force: true });
}
