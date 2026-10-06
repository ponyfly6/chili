import { expect, test } from "bun:test";
import type { AgentPath, SessionId } from "@chili/protocol";
import type { SessionRow } from "@chili/store";
import { DelegationPolicyGate, resolveDelegationConfig } from "./delegation.js";

function session(id: string, parent?: string): SessionRow {
  return { id: id as SessionId, cwd: "/repo", status: "active", createdAt: 1, updatedAt: 1,
    ...(parent ? { agent: { parentSessionId: parent as SessionId, name: id, path: `/root/${id}` as AgentPath, policy: {} } } : {}) };
}
function gate(sessions: SessionRow[]) {
  return new DelegationPolicyGate({store: {sessions: async () => sessions},
    getDelegationConfig: async (sessionId) => ({sessionId,policy:"off",source:"session"})});
}

test("Agents delegate proactively by default and retain explicit user policy overrides", () => {
  expect(resolveDelegationConfig({sessionId:"root" as SessionId})).toMatchObject({policy:"proactive",source:"default"});
  expect(resolveDelegationConfig({sessionId:"root" as SessionId,defaultPolicy:"explicit"})).toMatchObject({policy:"explicit"});
  expect(resolveDelegationConfig({sessionId:"root" as SessionId,sessionPolicy:"off",defaultPolicy:"proactive"})).toMatchObject({policy:"off",source:"session"});
});
test("nested Agent operations inherit the persisted root delegation override", async () => {
  const service=gate([session("root"),session("child","root"),session("leaf","child")]);
  expect(await service.rootSessionId("leaf" as SessionId)).toBe("root" as SessionId);
  await expect(service.assertEnabled({sessionId:"leaf" as SessionId,action:"agent_spawn"})).rejects.toThrow("off");
});
test("missing, archived and legacy child ownership cannot become a root grant", async () => {
  await expect(gate([session("child","missing")]).rootSessionId("child" as SessionId)).rejects.toThrow("not found");
  await expect(gate([{...session("root"),status:"archived"},session("child","root")]).rootSessionId("child" as SessionId)).rejects.toThrow("not active");
  await expect(gate([{...session("legacy"),readOnly:true}]).rootSessionId("legacy" as SessionId)).rejects.toThrow("read-only");
});
test("persisted parent cycles and oversized chains fail closed", async () => {
  await expect(gate([session("a","b"),session("b","a")]).rootSessionId("a" as SessionId)).rejects.toThrow("Cyclic");
  const chain=Array.from({length:65},(_,i)=>session(`s${i}`,i?`s${i-1}`:undefined));
  await expect(gate(chain).rootSessionId("s64" as SessionId)).rejects.toThrow("exceeds");
});
