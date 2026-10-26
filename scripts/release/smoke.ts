import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { releaseDirectory, targets, version } from "./config.js";

const selected = process.argv.slice(2);
const selectedTargets = selected.length ? selected : [...targets];
if (selectedTargets.some((target) => !targets.includes(target as typeof targets[number]))) throw new Error("Unsupported smoke target");
const temporary = await mkdtemp(join(tmpdir(), "chili-release-smoke-"));
try {
  for (const target of selectedTargets) {
    const native = target === `${process.platform}-${process.arch}`;
    if (!native && !target.startsWith("linux-")) throw new Error(`Run the ${target} smoke test on a matching host`);
    const binary = resolve(releaseDirectory, target, "chili");
    await readFile(binary); // Fail before starting a container when the build is missing.
    const script = `set -eu
mkdir -p /tmp/chili-test/project
cd /tmp/chili-test/project
export CHILI_HOME=/tmp/chili-test/profile
test "$($CHILI_BINARY --version)" = "chili ${version}"
$CHILI_BINARY --help > /tmp/chili-test/help
grep 'chili --version' /tmp/chili-test/help
printf '{"name":"release-smoke"}\\n' > package.json
$CHILI_BINARY --model fake --yes 'read package' > /tmp/chili-test/output
grep 'release-smoke' /tmp/chili-test/output
$CHILI_BINARY --model fake 'hello' > /tmp/chili-test/echo
grep 'Echo: hello' /tmp/chili-test/echo
$CHILI_BINARY --model fake --yes 'delegate read' > /tmp/chili-test/delegate
grep 'release-smoke' /tmp/chili-test/delegate
$CHILI_BINARY sessions > /tmp/chili-test/sessions
grep session_ /tmp/chili-test/sessions
printf 'RELEASE_SMOKE_OK\\n'
`;
    const scriptPath = join(temporary, `${target}.sh`);
    await writeFile(scriptPath, native ? script.replaceAll("/tmp/chili-test", join(temporary, target)) : script);
    const command = native
      ? ["/bin/sh", scriptPath]
      : ["docker", "run", "--rm", "--network=none", "--platform", target === "linux-x64" ? "linux/amd64" : "linux/arm64",
        "--mount", `type=bind,src=${binary},dst=/release/chili,readonly`,
        "--mount", `type=bind,src=${scriptPath},dst=/release/smoke.sh,readonly`,
        "--env", "CHILI_BINARY=/release/chili", "debian:bookworm-slim", "sh", "/release/smoke.sh"];
    const child = Bun.spawn(command, {
      cwd: temporary,
      env: { ...process.env, CHILI_BINARY: binary, ...(native ? { PATH: "/usr/bin:/bin" } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(120_000),
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 || !output.includes("RELEASE_SMOKE_OK")) throw new Error(`${target} smoke failed (${code}):\n${output}\n${error}`);
    console.log(`PASS ${target}: version, help, SQLite sessions, file tools and embedded Code Mode worker delegation, without Node/Bun`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
