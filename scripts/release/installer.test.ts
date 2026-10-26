import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dirname, "../../apps/web/public/install.sh");

async function fixture(run: (directory: string, invoke: (extra?: Record<string, string>) => Promise<{ code: number; output: string }>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "chili-installer-test-"));
  const shims = join(directory, "shims");
  const assets = join(directory, "assets");
  const destination = join(directory, "installed tools");
  try {
    await Promise.all([mkdir(shims), mkdir(assets), mkdir(destination)]);
    await writeFile(join(assets, "chili"), '#!/bin/sh\nprintf "chili 0.1.0\\n"\n', { mode: 0o755 });
    const asset = "chili-0.1.0-darwin-arm64.tar.gz";
    const tar = Bun.spawn(["tar", "-czf", join(assets, asset), "chili"], { cwd: assets, stdout: "ignore", stderr: "pipe" });
    expect(await tar.exited).toBe(0);
    const checksum = createHash("sha256").update(await readFile(join(assets, asset))).digest("hex");
    await writeFile(join(assets, "SHA256SUMS"), `${checksum}  ${asset}\n`);
    await writeFile(join(shims, "uname"), '#!/bin/sh\ncase "$1" in -s) echo "${MOCK_OS:-Darwin}";; -m) echo arm64;; esac\n', { mode: 0o755 });
    await writeFile(join(shims, "curl"), `#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; out=$1 ;; https://*) url=$1 ;; esac
  shift
done
[ "\${MOCK_DOWNLOAD_FAILURE:-}" != 1 ] || exit 22
case "$url" in
  */latest) printf 'https://github.com/ponyfly6/chili/releases/tag/v0.1.0' ;;
  *) cp "$MOCK_ASSETS/\${url##*/}" "$out" ;;
esac
`, { mode: 0o755 });
    await writeFile(join(destination, "chili"), "previous installation");
    const invoke = async (extra: Record<string, string> = {}) => {
      const child = Bun.spawn(["/bin/sh", installer], {
        cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, HOME: directory, ZDOTDIR: directory, PATH: `${shims}:/usr/bin:/bin`, CHILI_NO_MODIFY_PATH: "1",
          CHILI_INSTALL_DIR: destination, CHILI_VERSION: "0.1.0", MOCK_ASSETS: assets, ...extra },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: stdout + stderr };
    };
    await run(directory, invoke);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("shell installer handles spaces, latest resolution and repeated installation", async () => {
  await fixture(async (directory, invoke) => {
    expect((await invoke({ CHILI_VERSION: "" })).code).toBe(0);
    expect((await invoke()).code).toBe(0);
    expect(await readFile(join(directory, "installed tools/chili"), "utf8")).toContain("chili 0.1.0");
  });
});

test("shell installer preserves the previous installation on a corrupt or unavailable release", async () => {
  await fixture(async (directory, invoke) => {
    const previous = join(directory, "installed tools/chili");
    expect((await invoke({ MOCK_DOWNLOAD_FAILURE: "1" })).code).not.toBe(0);
    expect(await readFile(previous, "utf8")).toBe("previous installation");
    await writeFile(join(directory, "assets/SHA256SUMS"), `${"0".repeat(64)}  chili-0.1.0-darwin-arm64.tar.gz\n`);
    const corrupt = await invoke();
    expect(corrupt.code).not.toBe(0);
    expect(corrupt.output).toContain("Checksum mismatch");
    expect(await readFile(previous, "utf8")).toBe("previous installation");
  });
});

test("shell installer rejects unsupported platforms and unsafe version inputs", async () => {
  await fixture(async (_directory, invoke) => {
    expect((await invoke({ MOCK_OS: "Windows_NT" })).code).not.toBe(0);
    expect((await invoke({ CHILI_VERSION: "../../evil" })).code).not.toBe(0);
  });
});

test("default installation adds the user PATH once without replacing shell configuration", async () => {
  await fixture(async (directory, invoke) => {
    const profile = join(directory, ".zshrc");
    await writeFile(profile, "# existing configuration\n");
    const environment = { CHILI_INSTALL_DIR: "", CHILI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" };
    expect((await invoke(environment)).code).toBe(0);
    expect((await invoke(environment)).code).toBe(0);
    const contents = await readFile(profile, "utf8");
    expect(contents.startsWith("# existing configuration\n")).toBe(true);
    expect(contents.split('export PATH="$HOME/.local/bin:$PATH"')).toHaveLength(2);
    expect(await readFile(join(directory, ".local/bin/chili"), "utf8")).toContain("chili 0.1.0");
  });
});
