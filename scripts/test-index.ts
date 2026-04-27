import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["packages", "apps"];
const skipDirs = new Set([".git", "dist", "node_modules"]);

const [testFiles, packageJson] = await Promise.all([
  collectTests(),
  readPackageJson(),
]);

const smokeScripts = Object.entries(packageJson.scripts ?? {})
  .filter(([name]) => name.startsWith("smoke"))
  .sort(([left], [right]) => left.localeCompare(right));

console.log("Chili test index");
console.log("");
console.log(`Smoke scripts (${smokeScripts.length})`);
for (const [name, command] of smokeScripts) {
  console.log(` - bun run ${name}: ${command}`);
}

console.log("");
console.log(`Unit tests (${testFiles.length})`);
for (const [group, files] of groupByPackage(testFiles)) {
  console.log(` - ${group}: ${files.length}`);
  for (const file of files) console.log(`   ${file}`);
}

async function collectTests(): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    await walk(join(repoRoot, root), files);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(dir: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await walk(join(dir, entry.name), output);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isTestFile(entry.name)) continue;
    output.push(toPosix(relative(repoRoot, join(dir, entry.name))));
  }
}

async function readPackageJson(): Promise<{ scripts?: Record<string, string> }> {
  return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
}

function groupByPackage(files: readonly string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const [root, name] = file.split("/");
    const group = root && name ? `${root}/${name}` : "root";
    const items = groups.get(group) ?? [];
    items.push(file);
    groups.set(group, items);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[tj]sx?$/.test(name);
}

function toPosix(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
