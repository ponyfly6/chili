import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [logPath, dbPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const registered = Boolean(db.query("select pid from host_guardians where pid = ?").get(process.ppid));
db.close();
appendFileSync(logPath, JSON.stringify({ role: "server", pid: process.pid, guardianPid: process.ppid, registered }) + "\n");
const grandchild = spawn(process.execPath, ["-e", `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({role:'grandchild',pid:process.pid})+'\\n');process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "ignore"], detached: false });
const grandchildReady = new Promise((resolve) => grandchild.stdout.once("data", resolve));
process.on("SIGTERM", () => {});
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  await grandchildReady;
  const request = JSON.parse(line);
  let result;
  if (request.method === "server/discover") result = {
    resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
  };
  else if (request.method === "tools/list") result = {
    resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [],
  };
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
// Deliberately do not exit on stdin EOF or TERM: owner containment must work.
setInterval(() => {}, 1_000);
