import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assetName, checked, releaseDirectory, repository, root, tag, targets, version } from "./config.js";

const selected = process.argv.slice(2);
if (selected.some((target) => !targets.includes(target as typeof targets[number]))) {
  throw new Error(`Supported release targets: ${targets.join(", ")}`);
}
const builds = selected.length ? selected : [...targets];
await mkdir(releaseDirectory, { recursive: true });
for (const target of builds) {
  const directory = resolve(releaseDirectory, target);
  await mkdir(directory, { recursive: true });
  const binary = resolve(directory, "chili");
  // x64 baseline supports CPUs without AVX2 with the pinned Bun 1.3 runtime.
  const bunTarget = target === "linux-x64" ? "bun-linux-x64-baseline" : `bun-${target}`;
  await checked([
    process.execPath, "build", "--compile", "--production", `--root=${root}`, `--target=${bunTarget}`,
    `--define=CHILI_CLI_VERSION=${JSON.stringify(version)}`, `--outfile=${binary}`,
    resolve(root, "apps/cli/src/index.ts"),
    resolve(root, "packages/tools/src/code-mode/worker.ts"),
    resolve(root, "packages/tools/src/input-schema-worker.ts"),
  ]);
  await chmod(binary, 0o755);
  await copyFile(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
  await checked(["tar", "-czf", resolve(releaseDirectory, assetName(target)), "chili", "LICENSE"], directory);
}

// Finalize only after every advertised target has been built. Never publish a partial manifest.
const assets: Record<string, { file: string; sha256: string; binarySha256: string; url: string }> = {};
for (const target of targets) {
  const file = assetName(target);
  assets[target] = {
    file,
    sha256: createHash("sha256").update(await readFile(resolve(releaseDirectory, file))).digest("hex"),
    binarySha256: createHash("sha256").update(await readFile(resolve(releaseDirectory, target, "chili"))).digest("hex"),
    url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
  };
}
await writeFile(resolve(releaseDirectory, "manifest.json"), JSON.stringify({ version, tag, assets }, null, 2) + "\n");
await writeFile(resolve(releaseDirectory, "SHA256SUMS"), Object.values(assets).map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""));
await copyFile(resolve(root, "apps/web/public/install.sh"), resolve(releaseDirectory, "install.sh"));
console.log(`Release ${tag} built in ${releaseDirectory}`);
