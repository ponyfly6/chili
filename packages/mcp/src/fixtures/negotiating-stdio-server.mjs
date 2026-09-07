import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, logPath] = process.argv.slice(2);
const modern = mode === "modern";
let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, method: request.method, params: request.params })}\n`);
  if (mode === "wait") return;
  if (mode === "overflow") {
    process.stdout.write(Buffer.alloc(65, 0x78));
    return;
  }
  if (!modern && !initialized && request.method !== "initialize") process.exit(17);
  let result;
  if (modern && request.method === "server/discover") {
    result = {
      resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-stdio", version: "2" } },
    };
  } else if (!modern && request.method === "initialize") {
    initialized = true;
    result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "strict-legacy-stdio", version: "1" } };
  } else if (request.method === "notifications/initialized") {
    return;
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", inputSchema: { type: "object" } }], ...(modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}) };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
lines.on("close", () => process.exit(0));
