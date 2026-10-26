import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checked, releaseDirectory, root, version } from "./config.js";

const directory = resolve(releaseDirectory, "npm/usechili");
await mkdir(resolve(directory, "bin"), { recursive: true });
for (const file of ["bin/chili.cjs", "install.cjs", "runtime.cjs", "verify.cjs", "README.md"]) {
  await copyFile(resolve(root, "npm/usechili", file), resolve(directory, file));
}
const pkg = JSON.parse(await readFile(resolve(root, "npm/usechili/package.json"), "utf8"));
if (pkg.version !== version) throw new Error("CLI and npm package versions must match");
await writeFile(resolve(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
await copyFile(resolve(releaseDirectory, "manifest.json"), resolve(directory, "manifest.json"));
await copyFile(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
await chmod(resolve(directory, "bin/chili.cjs"), 0o755);
await checked(["node", "verify.cjs"], directory);
await checked(["npm", "pack", "--ignore-scripts", "--pack-destination", releaseDirectory], directory);
