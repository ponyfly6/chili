import { openAdvancedTaskDialog } from "./conversation-design.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { ChiliDesktopApi, DesktopState } from "../src/shared/contracts.js";

const repositoryRoot = requiredEnvironment("CHILI_PROJECTS_REPOSITORY_ROOT");
const temporaryRoot = requiredEnvironment("CHILI_PROJECTS_TEMPORARY_ROOT");
const bunPath = requiredEnvironment("CHILI_PROJECTS_BUN_PATH");
const desktopRoot = join(repositoryRoot, "apps/desktop");
const artifacts = join(temporaryRoot, "artifacts");
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const replies = createInterface({ input: process.stdin });
let nextId = 0;
replies.on("line", (line) => {
  const reply = JSON.parse(line) as { id: number; value?: unknown; error?: string };
  const waiter = pending.get(reply.id);
  pending.delete(reply.id);
  if (reply.error) waiter?.reject(new Error(reply.error));
  else waiter?.resolve(reply.value);
});
const streams = new Map<string, { aborted: boolean; response: ServerResponse }>();
const providerErrors: string[] = [];
const provider = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET") {
      const asset = url.pathname.replace(/^\/renderer\//u, "");
      assert.ok(asset === "index.html" || /^assets\/[\w.-]+$/u.test(asset));
      response.writeHead(200, { "content-type": asset.endsWith("html") ? "text/html" : asset.endsWith("css") ? "text/css" : "text/javascript" });
      response.end(await readFile(join(desktopRoot, "out/renderer", asset)));
      return;
    }
    assert.equal(request.method, "POST");
    assert.ok(url.pathname.endsWith("/chat/completions"));
    assert.equal(request.headers.authorization, "Bearer project-process-fixture");
    let body = "";
    for await (const chunk of request) { body += String(chunk); assert.ok(body.length < 4_000_000); }
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
    const user = parsed.messages.filter((message) => message.role === "user").at(-1)?.content;
    const text = typeof user === "string" ? user : JSON.stringify(user);
    const match = /project-process-(native|crash)-(stream|tool)-([abc])/u.exec(text);
    assert.ok(match, `Unexpected provider prompt ${text.slice(0, 200)}`);
    const key = match[0];
    if (match[2] === "tool") {
      const command = "printf '%s\\n' \"$$\" > .process-tool-leader.pid\n/bin/sleep 300 &\nprintf '%s\\n' \"$!\" > .process-tool-child.pid\nwait";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: key, model: "deepseek-v4-pro", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `${key}-bash`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command, timeoutMs: 300_000 }) } }] } }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }));
      return;
    }
    assert.ok(!streams.has(key), `Unexpected duplicate stream ${key}`);
    const stream = { aborted: false, response };
    streams.set(key, stream);
    response.once("close", () => { stream.aborted = true; });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ id: key, model: "deepseek-v4-pro", choices: [{ index: 0, finish_reason: null, delta: { content: `Holding ${key}` } }] })}\n\n`);
  } catch (error) {
    providerErrors.push(String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
const providerUrl = `http://127.0.0.1:${address.port}/`;
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const measurements: unknown[] = [];
let activeApp: ElectronApplication | undefined;
let page: Page | undefined;

try {
  for (const mode of ["native", "crash"] as const) {
    log(`${mode}: launch three temporary projects`);
    const root = join(temporaryRoot, mode);
    const workspaces = ["a", "b", "c"].map((letter) => join(root, `project-${letter}`));
    const home = join(root, "home");
    const userData = join(root, "user-data");
    const temp = join(root, "tmp");
    for (const path of [...workspaces, home, userData, temp]) await mkdir(path, { recursive: true });
    for (const workspace of workspaces) {
      const initialized = spawnSync("/usr/bin/git", ["init", "--quiet", workspace], { env: { PATH: "/usr/bin:/bin", HOME: home } });
      assert.equal(initialized.status, 0);
      await writeFile(join(workspace, "README.md"), "# Isolated project process fixture\n");
    }
    activeApp = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: repositoryRoot,
      timeout: 30_000,
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: "/bin/zsh", HOME: home, CHILI_HOME: home, TMPDIR: temp,
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
        NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
        CHILI_BUN_PATH: bunPath, CHILI_DESKTOP_MODEL: "deepseek",
        CHILI_DESKTOP_WORKSPACE: workspaces[0]!, CHILI_DESKTOP_USER_DATA: userData,
        CHILI_DESKTOP_DISABLE_DEVTOOLS: "1", ELECTRON_RENDERER_URL: `${providerUrl}renderer/index.html`,
        DEEPSEEK_API_KEY: "project-process-fixture", DEEPSEEK_BASE_URL: providerUrl, DEEPSEEK_MODEL: "deepseek-v4-pro",
      },
    });
    const pid = activeApp.process().pid;
    assert.ok(pid);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      activeApp!.process().once("exit", (code, signal) => resolve({ code, signal }));
    });
    let output = "";
    activeApp.process().stderr?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-128_000); });
    page = await activeApp.firstWindow();
    // Keep real user keystrokes out of this fixture while Playwright continues
    // to drive this launch's renderer through its own automation connection.
    await activeApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setFocusable(false);
    });
    page.setDefaultTimeout(30_000);
    await healthy(page);
    await inspect("observe", pid);
    const sessions: string[] = [];
    const projectIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) {
        await activeApp.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspaces[index]!);
        await page.getByRole("button", { name: "Add project", exact: true }).click();
        await activeProject(page, workspaces[index]!);
      }
      await healthy(page);
      const state = await appState(page);
      assert.ok(state.projectId);
      projectIds.push(state.projectId);
      await createTask(page, `project-process-${mode}-stream-${"abc"[index]}`);
      await waitFor(() => streams.has(`project-process-${mode}-stream-${"abc"[index]}`));
      const tasks: Array<{ id: string }> = await page.evaluate(async () => (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop.invoke({ type: "sessions.list" }));
      assert.equal(tasks.length, 1);
      sessions.push(tasks[0]!.id);
    }
    const before = await inspect("observe", pid) as Observation;
    assert.equal(before.sidecarPids.length, 3, "Three live sidecar processes required");
    log(`${mode}: all three streams running; exercising 30 project switches`);
    const switches: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const selected = index % 3;
      const started = performance.now();
      await switchProject(page, selected);
      await activeProject(page, workspaces[selected]!);
      await page.getByRole("heading", { name: `project-process-${mode}-stream-${"abc"[selected]}`, exact: true }).waitFor();
      switches.push(Math.round((performance.now() - started) * 100) / 100);
      const observed = await inspect("observe", pid) as Observation;
      assert.deepEqual(observed.sidecarPids, before.sidecarPids, `Switch ${index + 1} restarted a sidecar`);
      for (const letter of "abc") assert.equal(streams.get(`project-process-${mode}-stream-${letter}`)?.aborted, false);
    }
    const after = await inspect("observe", pid);
    await switchProject(page, 0);
    await page.locator(".conversation-activity").getByRole("button", { name: "Stop current turn", exact: true }).click();
    await waitFor(() => streams.get(`project-process-${mode}-stream-a`)?.aborted === true);
    for (const letter of "bc") assert.equal(streams.get(`project-process-${mode}-stream-${letter}`)?.aborted, false, `Stop A aborted ${letter}`);
    log(`${mode}: Stop A isolated; creating shell child groups in all three projects`);
    const toolPids: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await switchProject(page, index);
      await createTask(page, `project-process-${mode}-tool-${"abc"[index]}`);
      for (const file of [".process-tool-leader.pid", ".process-tool-child.pid"]) {
        await waitFor(async () => /^\d+$/u.test((await readFile(join(workspaces[index]!, file), "utf8").catch(() => "")).trim()));
        toolPids.push(Number((await readFile(join(workspaces[index]!, file), "utf8")).trim()));
      }
    }
    await page.screenshot({ path: join(artifacts, `${mode}-three-projects.png`), fullPage: true });
    log(`${mode}: blocking native Git reads in each project before shutdown`);
    for (const workspace of workspaces) {
      const fifo = join(workspace, "blocked-git-config.fifo");
      assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
      const configPath = join(workspace, ".git/config");
      await writeFile(configPath, `${await readFile(configPath, "utf8")}\n[include]\n\tpath = ${JSON.stringify(fifo)}\n`);
    }
    await page.evaluate(({ ids, tasks }) => {
      const api = (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop;
      ids.forEach((projectId, index) => { void api.invoke({ type: "diff.get", scope: "workspace", sessionId: tasks[index]!, projectId }).catch(() => undefined); });
    }, { ids: projectIds, tasks: sessions });
    let fixtures: unknown;
    await waitFor(async () => {
      try { fixtures = await inspect("fixtures", pid, { workspaces, toolPids }); return true; } catch { return false; }
    }, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await inspect("fixtures", pid, { workspaces, toolPids }), fixtures, "Blocked children must remain alive across an independent observation");
    const measurement: Record<string, unknown> = { mode, switchesMs: switches, switchCount: switches.length, before, after, fixtures, outcome: "pending" };
    measurements.push(measurement);
    await saveMeasurements();
    const shutDownAt = performance.now();
    if (mode === "native") await deadline(activeApp.close(), 20_000);
    else await inspect("kill", pid);
    const exit = await deadline(exited, 5_000);
    if (mode === "native") assert.deepEqual(exit, { code: 0, signal: null }, "Native quit must exit successfully, without crashing");
    else assert.equal(exit.signal, "SIGKILL", "Hard-crash fixture must terminate from the injected signal");
    activeApp = undefined;
    const contained = await inspect("gone", pid);
    assert.deepEqual(providerErrors, []);
    Object.assign(measurement, { exit, contained, shutdownMs: Math.round(performance.now() - shutDownAt), outcome: "passed" });
    await saveMeasurements();
    await writeFile(join(artifacts, `${mode}-stderr.txt`), output);
    log(`${mode}: all observed runtime descendants gone; independent sentinel alive`);
  }
} catch (error) {
  await writeFile(join(artifacts, "failure.txt"), `${error instanceof Error ? error.stack : String(error)}\n`);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
    await writeFile(join(artifacts, "failure.html"), await page.content().catch(() => ""));
  }
  throw error;
} finally {
  if (activeApp) await deadline(activeApp.close(), 20_000).catch(() => undefined);
  provider.closeAllConnections();
  provider.close();
  replies.close();
}

interface Observation { sidecarPids: number[]; }

function inspect(action: string, electronPid: number, fixture: { workspaces?: string[]; toolPids?: number[] } = {}): Promise<unknown> {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  process.stdout.write(`CHILI_PROJECT_PROCESS_REQUEST ${JSON.stringify({ id, action, electronPid, ...fixture })}\n`);
  return deadline(promise, 20_000).finally(() => pending.delete(id));
}

async function saveMeasurements(): Promise<void> {
  await writeFile(join(artifacts, "measurements.json"), JSON.stringify({ capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, measurements }, null, 2));
}

async function createTask(page: Page, prompt: string): Promise<void> {
  const dialog = await openAdvancedTaskDialog(page);
  await dialog.getByLabel("Task title", { exact: true }).fill(prompt);
  await dialog.getByLabel("What should Chili accomplish?", { exact: true }).fill(prompt);
  const permissions = dialog.getByLabel("Permission profile", { exact: true });
  const option = await permissions.locator("option").evaluateAll((options) => options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent ?? "" })).find((option) => /^full access\b/iu.test(option.text))?.value);
  assert.ok(option);
  await permissions.selectOption(option);
  await dialog.getByRole("button", { name: "Create & run", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: prompt, exact: true }).waitFor();
}

async function switchProject(page: Page, index: number): Promise<void> {
  await page.getByRole("button", { name: `Open project project-${"abc"[index]}`, exact: true }).click();
}

async function activeProject(page: Page, workspace: string): Promise<void> {
  await waitFor(async () => (await appState(page)).workspace === workspace);
}

async function appState(page: Page): Promise<DesktopState> {
  return page.evaluate(async () => (window as unknown as { chiliDesktop: ChiliDesktopApi }).chiliDesktop.invoke({ type: "app.state" }));
}

async function healthy(page: Page): Promise<void> {
  await waitFor(async () => (await appState(page)).sidecar.phase === "healthy");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < end) {
    try { if (await deadline(Promise.resolve(predicate()), Math.max(1, end - Date.now()))) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Desktop project fixture condition timed out", { cause: lastError });
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Project fixture deadline exceeded")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value && value.startsWith("/"), `${name} must be an absolute launcher-owned path`);
  return value;
}

function log(message: string): void { process.stdout.write(`[desktop-projects] ${message}\n`); }
