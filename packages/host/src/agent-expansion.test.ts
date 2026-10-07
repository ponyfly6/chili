import { expect, test } from "bun:test";
import type { AgentPath, SessionId } from "@chili/protocol";
import type { SessionRow } from "@chili/store";
import { resolveAgentAncestry } from "./agent-expansion.js";

const root: SessionRow = {
  id: "root" as SessionId, cwd: "/repo", status: "active", createdAt: 1, updatedAt: 1,
};
const child: SessionRow = {
  ...root,
  id: "child" as SessionId,
  agent: { parentSessionId: root.id, name: "reader", path: "/root/reader" as AgentPath, policy: {} },
};

test("Agent ancestry uses persisted session metadata without a source classification", async () => {
  expect(await resolveAgentAncestry({ sessions: async () => [root, child] }, child.id)).toEqual({
    path: "/root/reader" as AgentPath, depth: 1, rootSessionId: root.id,
  });
  expect(await resolveAgentAncestry({ sessions: async () => [root, child] }, root.id)).toEqual({
    path: "/root" as AgentPath, depth: 0, rootSessionId: root.id,
  });
});

test("Agent ancestry rejects unavailable and cyclic parent chains", async () => {
  await expect(resolveAgentAncestry({ sessions: async () => [child] }, child.id)).rejects.toThrow("not active");
  await expect(resolveAgentAncestry({ sessions: async () => [{ ...root, status: "archived" }, child] }, child.id)).rejects.toThrow("not active");
  const cyclicRoot: SessionRow = {
    ...root,
    agent: { parentSessionId: child.id, name: "root", path: "/root" as AgentPath, policy: {} },
  };
  await expect(resolveAgentAncestry({ sessions: async () => [cyclicRoot, child] }, child.id)).rejects.toThrow("cycle");
});
