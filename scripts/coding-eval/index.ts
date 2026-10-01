import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codingEvalTask, codingEvalTasks, type CodingEvalTask } from "./tasks.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = "/tmp";
const version = 1;

interface PreparedRun {
  version: number;
  taskId: string;
  workspace: string;
  snapshotCommit: string;
  baseCommit: string;
  baseLockSha256: string;
  createdAt: string;
}

interface CommandResult {
  command: string[];
  exitCode: number;
  timedOut: boolean;
  wallClockMs: number;
  stdout: string;
  stderr: string;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// Do not inherit provider keys, NODE_OPTIONS, Bun preloads, or user MCP config.
// This is environment hygiene for local tests, not an OS sandbox.
function verificationEnvironment(home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, TMPDIR: temporaryRoot, CI: "1", NO_COLOR: "1" };
  for (const key of ["PATH", "SYSTEMROOT", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  return env;
}

async function command(args: string[], cwd: string, input?: Uint8Array, timeoutMs = 60_000): Promise<CommandResult> {
  const started = Date.now();
  const home = await mkdtemp(join(temporaryRoot, "chili-coding-eval-home-"));
  const child = Bun.spawn(args, {
    cwd, env: verificationEnvironment(home), stdin: input ? new Blob([new Uint8Array(input)]) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { command: args, exitCode, timedOut, wallClockMs: Date.now() - started, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await rm(home, { recursive: true, force: true });
  }
}

async function checked(args: string[], cwd = repository, input?: Uint8Array): Promise<string> {
  const result = await command(args, cwd, input);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function gitFile(commit: string, path: string): Promise<string> {
  return checked(["git", "show", `${commit}:${path}`]);
}

async function archive(commit: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const filename = join(dirname(destination), `archive-${Date.now()}-${Math.random().toString(16).slice(2)}.tar`);
  try {
    await checked(["git", "archive", "--format=tar", `--output=${filename}`, commit]);
    await checked(["tar", "-xf", filename, "-C", destination]);
  } finally {
    await rm(filename, { force: true });
  }
}

// Package exports target dist, but every snapshot's tsconfig maps @chili/* to
// its own src. Workspace package links also point inside the snapshot. Only
// installed third-party packages are shared; never borrow workspace dist/src.
async function linkDependencies(workspace: string): Promise<string[]> {
  const links: string[] = [];
  const installedRoot = await realpath(join(repository, "node_modules"));
  async function copyLinks(source: string, target: string): Promise<void> {
    let entries;
    try { entries = await readdir(source, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await mkdir(target, { recursive: true });
    const localInstalledRoot = await realpath(source);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.name === "@chili") {
        await mkdir(to, { recursive: true });
        for (const name of await readdir(from)) {
          const local = relative(repository, await realpath(join(from, name)));
          if (!local.startsWith(`packages${sep}`) && !local.startsWith(`apps${sep}`)) throw new Error("Unexpected workspace dependency");
          await symlink(join(workspace, local), join(to, name));
        }
      } else if (entry.name.startsWith("@") && entry.isDirectory()) {
        await copyLinks(from, to);
      } else {
        const physical = await realpath(from);
        if (!physical.startsWith(`${installedRoot}${sep}`) && !physical.startsWith(`${localInstalledRoot}${sep}`)) throw new Error(`Dependency is outside installed packages: ${from}`);
        await symlink(physical, to);
        links.push(`${relative(workspace, to)} -> ${physical}`);
      }
    }
  }
  await copyLinks(join(repository, "node_modules"), join(workspace, "node_modules"));
  for (const group of ["packages", "apps"]) {
    for (const entry of await readdir(join(workspace, group), { withFileTypes: true })) {
      if (entry.isDirectory()) await copyLinks(join(repository, group, entry.name, "node_modules"), join(workspace, group, entry.name, "node_modules"));
    }
  }
  return links.sort();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function prepare(task: CodingEvalTask): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, `chili-coding-eval-${task.id}-`));
  const workspace = join(directory, "workspace");
  await archive(task.baseCommit, workspace);
  await checked(["git", "init", "--quiet"], workspace);
  await checked(["git", "add", "--all"], workspace);
  await checked(["git", "-c", "user.name=Coding Eval Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Coding task starting snapshot"], workspace);
  const snapshotCommit = (await checked(["git", "rev-parse", "HEAD"], workspace)).trim();
  const dependencies = await linkDependencies(workspace);
  const prompt = `# Coding task: ${task.title}\n\n${task.requirements}\n\nWork only in this workspace. You may add tests and run focused local checks. Do not fetch upstream history or inspect other checkouts, evaluator files, reference patches, or external acceptance tests. Do not modify dependency manifests, lockfiles, or test infrastructure to bypass validation. Finish by reporting changed behavior, checks actually run, and remaining uncertainty.\n`;
  await writeFile(join(workspace, "CODING_TASK.md"), prompt);
  await writeFile(join(workspace, ".git/info/exclude"), "\nCODING_TASK.md\n");
  const metadata: PreparedRun = {
    version, taskId: task.id, workspace, snapshotCommit, baseCommit: task.baseCommit,
    baseLockSha256: digest(await readFile(join(workspace, "bun.lock"))), createdAt: new Date().toISOString(),
  };
  await json(join(directory, "run.json"), metadata);
  await json(join(directory, "dependencies.json"), { mode: "reuse-installed-third-party-packages", bun: Bun.version, links: dependencies });
  return directory;
}

async function readRun(directory: string): Promise<{ run: PreparedRun; task: CodingEvalTask }> {
  const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as PreparedRun;
  if (run.version !== version) throw new Error("Unsupported run metadata version");
  const task = codingEvalTask(run.taskId);
  if (run.baseCommit !== task.baseCommit || resolve(run.workspace) !== join(resolve(directory), "workspace")) throw new Error("Run metadata does not match fixture");
  const head = (await checked(["git", "rev-parse", "HEAD"], run.workspace)).trim();
  if (head !== run.snapshotCommit) throw new Error("Keep candidate edits uncommitted; verification expects the prepared snapshot as HEAD");
  return { run, task };
}

async function overlayCandidate(workspace: string, shadow: string): Promise<{ patchSha256: string; changedFiles: string[] }> {
  const tracked = (await checked(["git", "diff", "--name-only", "-z", "HEAD", "--"], workspace)).split("\0").filter(Boolean);
  for (const path of tracked) {
    if (path.split(/[\\/]/).some((part) => [".git", "node_modules"].includes(part))) throw new Error(`Candidate cannot edit dependency/Git infrastructure: ${path}`);
    try {
      const source = join(workspace, path);
      if (!(await lstat(source)).isFile() || !(await realpath(source)).startsWith(`${await realpath(workspace)}${sep}`)) throw new Error(`Changed candidate path must be a regular file within the workspace: ${path}`);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  const patch = await checked(["git", "diff", "--binary", "HEAD", "--"], workspace);
  if (patch) await checked(["git", "apply", "-"], shadow, new TextEncoder().encode(patch));
  const untracked = (await checked(["git", "ls-files", "--others", "--exclude-standard", "-z"], workspace)).split("\0").filter(Boolean).sort();
  const extraDigests: string[] = [];
  for (const path of untracked) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("Invalid candidate path");
    const source = join(workspace, path);
    if (!(await lstat(source)).isFile()) throw new Error(`New candidate path must be a regular file: ${path}`);
    const bytes = await readFile(source);
    await mkdir(dirname(join(shadow, path)), { recursive: true });
    const mode = (await lstat(source)).mode;
    await writeFile(join(shadow, path), bytes, { mode });
    extraDigests.push(`${path}\0${mode}\0${digest(bytes)}`);
  }
  return { patchSha256: digest(`${patch}\0${extraDigests.join("\0")}`), changedFiles: [...new Set([...tracked, ...untracked])].sort() };
}

async function restoreChecks(shadow: string, commit: string, files: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of files) {
    const source = await gitFile(commit, path);
    await mkdir(dirname(join(shadow, path)), { recursive: true });
    await writeFile(join(shadow, path), source);
    hashes[path] = digest(source);
  }
  return hashes;
}

async function testGate(shadow: string, files: readonly string[], log: string, expectedTests?: number, pattern?: string) {
  const args = [process.execPath, "test", ...files];
  if (pattern) args.push("--test-name-pattern", pattern);
  const result = await command(args, shadow, undefined, 45_000);
  await writeFile(log, `${result.stdout}${result.stderr}`);
  const passedTests = Number(result.stderr.match(/\n\s*(\d+) pass\b/)?.[1] ?? 0);
  const failedTests = Number(result.stderr.match(/\n\s*(\d+) fail\b/)?.[1] ?? 0);
  const passed = result.exitCode === 0 && !result.timedOut && failedTests === 0 && passedTests > 0
    && (expectedTests === undefined || passedTests === expectedTests);
  return { passed, command: args, exitCode: result.exitCode, timedOut: result.timedOut, wallClockMs: result.wallClockMs, passedTests, failedTests, log };
}

async function verify(directory: string) {
  const { run, task } = await readRun(directory);
  const resultDirectory = await mkdtemp(join(directory, "verification-"));
  const shadow = join(resultDirectory, "snapshot");
  await archive(task.baseCommit, shadow);
  const candidate = await overlayCandidate(run.workspace, shadow);
  // Runtime configuration and canonical checks belong to the evaluator. The
  // candidate may add tests, but cannot weaken these gates by editing them.
  await restoreChecks(shadow, task.baseCommit, ["bunfig.toml", "tsconfig.base.json", "tsconfig.json"]);
  const dependencies = await linkDependencies(shadow);
  const regressionHashes = await restoreChecks(shadow, task.baseCommit, task.regressionFiles);
  const regression = await testGate(shadow, task.regressionFiles, join(resultDirectory, "regression.log"));
  const acceptanceHashes = await restoreChecks(shadow, task.referenceCommit, task.acceptanceFiles);
  const acceptance = await testGate(shadow, task.acceptanceFiles, join(resultDirectory, "acceptance.log"), task.expectedAcceptanceTests, task.acceptanceNamePattern);
  const result = {
    version, taskId: task.id, dataset: "public-development", recordedAt: new Date().toISOString(),
    baseCommit: task.baseCommit, snapshotCommit: run.snapshotCommit, ...candidate,
    passed: regression.passed && acceptance.passed, regression, acceptance,
    fixtureHashes: { regression: regressionHashes, acceptance: acceptanceHashes },
    evaluatorSha256: digest(`${await readFile(fileURLToPath(import.meta.url), "utf8")}\0${await readFile(join(dirname(fileURLToPath(import.meta.url)), "tasks.ts"), "utf8")}`),
    environment: { bun: Bun.version, platform: process.platform, architecture: process.arch, baseLockSha256: run.baseLockSha256, installedLockSha256: digest(await readFile(join(repository, "bun.lock"))), dependencyLinksSha256: digest(JSON.stringify(dependencies)) },
    modelRun: null, codingWallClockMs: null, humanActiveMs: null, inputTokens: null, outputTokens: null, costUsd: null,
    note: "Local candidate verification only; no model was invoked. Test wall clocks are not end-to-end coding performance.",
  };
  await json(join(resultDirectory, "result.json"), result);
  await json(join(resultDirectory, "dependencies.json"), dependencies);
  return { resultFile: join(resultDirectory, "result.json"), ...result };
}

async function selfCheck(tasks: readonly CodingEvalTask[]) {
  const summaryDirectory = await mkdtemp(join(temporaryRoot, "chili-coding-eval-calibration-"));
  const results = [];
  for (const task of tasks) {
    const directory = await prepare(task);
    const baseline = await verify(directory);
    console.error(`${task.id}: original ${baseline.passed ? "unexpected PASS" : "FAIL"}`);
    const patch = await checked(["git", "diff", "--binary", task.baseCommit, task.referenceCommit, "--", ...task.productionFiles]);
    const { run } = await readRun(directory);
    await checked(["git", "apply", "-"], run.workspace, new TextEncoder().encode(patch));
    const reference = await verify(directory);
    console.error(`${task.id}: historical production patch ${reference.passed ? "PASS" : "FAIL"}`);
    // A no-op baseline must fail specifically on behavioral acceptance while
    // its old regression tests still pass. Infrastructure errors do not count.
    results.push({ taskId: task.id, passed: baseline.regression.passed && !baseline.acceptance.passed && baseline.acceptance.failedTests > 0 && !baseline.acceptance.timedOut && reference.passed, baseline: baseline.resultFile, reference: reference.resultFile });
  }
  const summary = { version, kind: "verifier-calibration", modelInvoked: false, passed: results.every((result) => result.passed), results };
  await json(join(summaryDirectory, "calibration.json"), summary);
  return { summaryFile: join(summaryDirectory, "calibration.json"), ...summary };
}

async function main(): Promise<void> {
  const [action, argument, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Unexpected extra arguments");
  if (action === "list" && argument === undefined) {
    console.log(JSON.stringify(codingEvalTasks.map(({ id, title, baseCommit }) => ({ id, title, baseCommit, dataset: "public-development" })), null, 2));
  } else if (action === "prepare" && argument) {
    const directory = await prepare(codingEvalTask(argument));
    console.log(JSON.stringify({ runDirectory: directory, workspace: join(directory, "workspace"), prompt: join(directory, "workspace/CODING_TASK.md"), modelInvoked: false }, null, 2));
  } else if (action === "verify" && argument) {
    const result = await verify(resolve(argument));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else if (action === "self-check" && (argument === undefined || argument === "all" || codingEvalTasks.some((task) => task.id === argument))) {
    const result = await selfCheck(argument && argument !== "all" ? [codingEvalTask(argument)] : codingEvalTasks);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else {
    throw new Error("Usage: bun run scripts/coding-eval/index.ts list | prepare <task-id> | verify <run-directory> | self-check [task-id|all]\nThese commands never run a model. See docs/evaluation/README.md for explicit opt-in execution.");
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
