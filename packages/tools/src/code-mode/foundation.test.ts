import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { PolicyApprovalBroker } from "../approval.js";
import { createCodeModeTool } from "../builtins/code-mode.js";
import { createReadFileTool } from "../builtins/read-file.js";
import { createWriteFileTool } from "../builtins/write-file.js";
import { ToolExecutor } from "../executor.js";
import { InMemoryToolRegistry } from "../registry.js";

test("code_mode composes under resource restrictions without granting its children access", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-code-mode-resource-"));
  try {
    await writeFile(join(cwd, "public.txt"), "PUBLIC_CONTENT");
    await writeFile(join(cwd, "secret.txt"), "PRIVATE_CONTENT");
    const registry = new InMemoryToolRegistry();
    registry.register(createCodeModeTool());
    registry.register(createReadFileTool());
    registry.register(createWriteFileTool());
    const events: ChiliEvent[] = [];
    const executor = new ToolExecutor({
      registry,
      events: { publish: async (event) => { events.push(event); } },
      approvals: new PolicyApprovalBroker({ rulesets: [[
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "read", pattern: "secret.txt", action: "deny" },
      ]] }),
      policyResolver: { resolve: () => ({ allowedTools: ["code_mode", "read", "write"], writeScope: [], executeScope: [] }) },
    });
    const result = await executor.execute({
      cwd,
      sessionId: "code-resource" as SessionId,
      turnId: "turn" as TurnId,
      toolName: "code_mode",
      input: { code: `
        const allowed = await tools.read({filePath: "public.txt"});
        text(allowed.structuredData.content);
        try { await tools.read({filePath: "secret.txt"}); text("SECRET_WAS_READ"); }
        catch (error) { text("denied: " + error.message); }
        text(typeof tools.write);
      ` },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw result.error;
    expect(result.result.output).toContain("PUBLIC_CONTENT");
    expect(result.result.output).toContain("denied:");
    expect(result.result.output).toContain("undefined");
    expect(result.result.output).not.toContain("PRIVATE_CONTENT");
    expect(result.result.output).not.toContain("SECRET_WAS_READ");
    const starts = events.filter((event) => event.type === "tool.call_started");
    expect(starts.filter((event) => event.payload.toolName === "read")).toHaveLength(2);
    expect(starts.filter((event) => event.payload.toolName === "read").every((event) => event.payload.parentCallId === result.callId)).toBe(true);
    expect(await readFile(join(cwd, "secret.txt"), "utf8")).toBe("PRIVATE_CONTENT");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
