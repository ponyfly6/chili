import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suites = [
  "smoke",
  "smoke:cli",
  "smoke:p0p1",
  "smoke:p2",
  "smoke:p2-control",
  "smoke:p3",
  "smoke:p3-background",
  "smoke:p3-team-model",
  "smoke:p3-team-parallel",
] as const;

for (const suite of suites) {
  console.log(`\n[smoke:all] running ${suite}`);
  const proc = Bun.spawn(["bun", "run", suite], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`\n[smoke:all] failed: ${suite} (exit code ${exitCode})`);
    process.exit(exitCode || 1);
  }
}

console.log(`\n[smoke:all] passed: ${suites.length}/${suites.length} suites`);
