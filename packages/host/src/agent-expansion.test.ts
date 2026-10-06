import { expect, test } from "bun:test";
import type { AgentPath, SessionId } from "@chili/protocol";
import type { SessionRow } from "@chili/store";
import { resolveAgentAncestry } from "./agent-expansion.js";

test("Agent ancestry uses persisted session parents instead of task or Team rows", async () => {
  const root:SessionRow={id:"root" as SessionId,cwd:"/repo",status:"active",createdAt:1,updatedAt:1};
  const child:SessionRow={...root,id:"child" as SessionId,source:"subagent",agent:{parentSessionId:root.id,name:"reader",path:"/root/reader" as AgentPath,policy:{}}};
  expect(await resolveAgentAncestry({sessions:async()=>[root,child]},child.id)).toEqual({path:"/root/reader" as AgentPath,depth:1,rootSessionId:"root" as SessionId});
  await expect(resolveAgentAncestry({sessions:async()=>[{id:child.id,cwd:child.cwd,source:"subagent",status:"active",createdAt:1,updatedAt:1}]},child.id)).rejects.toThrow("read-only");
});
