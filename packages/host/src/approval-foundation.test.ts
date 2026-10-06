import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, ApprovalId, SessionId, ToolCallId } from "@chili/protocol";
import type { PermissionRule } from "@chili/policy";
import type { ApprovalBrokerRequest } from "@chili/tools";
import { createApprovalRulesets, createHostApprovalBroker } from "./approval.js";
import { loadHostConfig } from "./config.js";

function request(identity = "target-a"): ApprovalBrokerRequest {
  return { approvalId: "approval" as ApprovalId, sessionId: "session" as SessionId, callId: "call" as ToolCallId,
    toolName: "mcp__docs__read", risk: "read", permission: "mcp", patterns: ["docs.read"],
    metadata: { resourceIdentity: identity } };
}

test("Host resolves fresh policy after waiting and does not persist a stale allow_always", async () => {
  const chiliHome = await mkdtemp(join(tmpdir(), "chili-host-approval-revision-"));
  let rules: PermissionRule[] = [];
  let approve!: (decision: ApprovalDecision) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const broker = createHostApprovalBroker({ chiliHome,
    rulesetsForRequest: () => [rules],
    askApproval: () => { started(); return new Promise((resolve) => { approve = resolve; }); },
  });
  try {
    const pending = broker.decide(request());
    await waiting;
    rules = [{ permission: "mcp", pattern: "*", action: "deny" }];
    approve({ action: "allow_always" });
    expect((await pending).action).toBe("deny");
    expect((await loadHostConfig(chiliHome, { chiliHome })).userPermissions).toEqual([]);
  } finally { await rm(chiliHome, { recursive: true, force: true }); }
});

test("Host persisted MCP approvals bind identity and config removal revokes them in the same session", async () => {
  const chiliHome = await mkdtemp(join(tmpdir(), "chili-host-approval-target-"));
  let asks = 0;
  const broker = createHostApprovalBroker({ chiliHome,
    rulesetsForRequest: async () => createApprovalRulesets("default", await loadHostConfig(chiliHome, { chiliHome })),
    askApproval: async () => { asks++; return { action: "allow_always" }; },
  });
  try {
    expect((await broker.decide(request())).action).toBe("allow_always");
    expect(asks).toBe(1);
    expect((await broker.preflight(request())).action).toBe("allow");
    expect((await broker.preflight(request("target-b"))).action).toBe("ask");
    expect(await readFile(join(chiliHome, "config.toml"), "utf8")).toContain("mcp.__resource__.target-a");
    await writeFile(join(chiliHome, "config.toml"), "[permissions]\nallow = []\n");
    expect((await broker.preflight(request())).action).toBe("ask");
  } finally { await rm(chiliHome, { recursive: true, force: true }); }
});
