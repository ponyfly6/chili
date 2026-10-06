import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSdkMcpClient } from "./sdk-client.js";
import { McpStdioGuardianOwner, type McpGuardianLifecycleEvent } from "./stdio-guardian.js";

const fixture = fileURLToPath(new URL("./fixtures/negotiating-stdio-server.mjs", import.meta.url));

test("guarded SDK discovery and its session register separate groups before starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-guardian-"));
  const log = join(root, "requests.jsonl");
  const lifecycle: McpGuardianLifecycleEvent[] = [];
  const owner = await McpStdioGuardianOwner.create((event) => { lifecycle.push(event); });
  const client = createSdkMcpClient({ name: "guarded", type: "stdio", command: process.execPath,
    args: [fixture, "modern", log], cwd: root, source: "user", enabled: true, required: true, trust: true, raw: {},
  }, { stdioGuardian: owner });
  try {
    expect(await client.initialize()).toMatchObject({ protocolVersion: "2026-07-28" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    await client.close();
    await owner.close();
    const frames = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string });
    expect(new Set(frames.map((frame) => frame.pid)).size).toBe(2);
    expect(lifecycle.filter((event) => event.type === "started")).toHaveLength(2);
    expect(lifecycle.filter((event) => event.type === "finished")).toHaveLength(2);
    for (const event of lifecycle) expect(() => process.kill(-event.pid, 0)).toThrow();
  } finally {
    await client.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("registration failure starts no MCP server or discovery effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-registration-"));
  const log = join(root, "requests.jsonl");
  const owner = await McpStdioGuardianOwner.create(() => { throw new Error("fixture registration rejected"); });
  const client = createSdkMcpClient({ name: "guarded", type: "stdio", command: process.execPath,
    args: [fixture, "modern", log], cwd: root, source: "user", enabled: true, required: true, trust: true, raw: {},
  }, { stdioGuardian: owner });
  try {
    await expect(client.initialize()).rejects.toThrow();
    await expect(readFile(log)).rejects.toThrow();
  } finally {
    await client.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);


test("SIGKILL of a real Host reaps MCP session and discovery descendants after durable registration", async () => {
  const root = await mkdtemp(join("/tmp", "chili-mcp-crash-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "profile");
  await mkdir(cwd);
  await mkdir(chiliHome);
  const log = join(root, "processes.jsonl");
  const database = join(cwd, ".chili", "chili.sqlite");
  const serverPath = fileURLToPath(new URL("./fixtures/stubborn-stdio-server.mjs", import.meta.url));
  const hostPath = fileURLToPath(new URL("./fixtures/guarded-host.mjs", import.meta.url));
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({ servers: { stubborn: {
    command: process.execPath, args: [serverPath, log, database], cwd, required: true,
  } } }));
  const child = Bun.spawn([process.execPath, hostPath, cwd, chiliHome], { cwd: fileURLToPath(new URL("../../../..", import.meta.url)), stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: root } });
  const processes: Array<{ role: string; pid: number; guardianPid?: number; registered?: boolean }> = [];
  try {
    const reader = child.stdout.getReader();
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          let output = "";
          while (!output.includes("HOST_READY")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`MCP Host exited early: ${await new Response(child.stderr).text()}`);
            output += new TextDecoder().decode(chunk.value);
          }
        })(),
        new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("MCP Host fixture did not start")), 10_000); }),
      ]);
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
      reader.releaseLock();
    }
    await eventually(async () => {
      const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.role === "server").length).toBe(2);
      expect(entries.filter((entry) => entry.role === "grandchild").length).toBe(2);
      processes.splice(0, processes.length, ...entries);
    });
    expect(processes.filter((entry) => entry.role === "server").every((entry) => entry.registered)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    await eventually(async () => {
      for (const entry of processes) expect(() => process.kill(entry.pid, 0)).toThrow();
      for (const entry of processes.filter((entry) => entry.guardianPid)) expect(() => process.kill(-entry.guardianPid!, 0)).toThrow();
    });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    for (const entry of processes) {
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* already reaped */ }
      if (entry.guardianPid) { try { process.kill(-entry.guardianPid, "SIGKILL"); } catch { /* already reaped */ } }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let failure: unknown;
  while (Date.now() < deadline) {
    try { await assertion(); return; }
    catch (error) { failure = error; await Bun.sleep(25); }
  }
  throw failure;
}

test("compiled application uses its own transparent guardian entry for probe and session", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-compiled-"));
  const binary = join(root, "fixture");
  const log = join(root, "requests.jsonl");
  const entry = fileURLToPath(new URL("./fixtures/compiled-stdio-guardian.mjs", import.meta.url));
  try {
    const build = Bun.spawn([process.execPath, "build", "--compile", entry, `--outfile=${binary}`], { stdout: "ignore", stderr: "pipe" });
    const buildErrors = await new Response(build.stderr).text();
    expect(await build.exited, buildErrors).toBe(0);
    const app = Bun.spawn([binary, process.execPath, fixture, log, root], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(app.stdout).text();
    const errors = await new Response(app.stderr).text();
    expect(await app.exited, errors).toBe(0);
    expect(output).toContain("COMPILED_GUARDIAN_OK");
    const frames = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number });
    expect(new Set(frames.map((frame) => frame.pid)).size).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
