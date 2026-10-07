import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { Message, SessionId } from "@chili/protocol";
import { AGENT_CONTROL_TOOLS, DEFAULT_CODING_TOOLS } from "@chili/tools";
import { createChiliHost } from "./host.js";

const textOf = (message: Message | undefined) => message?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
function agentText(text: string): string {
  if (!text.startsWith("Agent message:")) return text;
  const message = JSON.parse(text.slice(text.indexOf("\n") + 1));
  expect(message.sender.agentId).toBeString();
  return String(message.text);
}
function latestText(input: ModelStreamInput) {
  return agentText(textOf(input.messages.filter((message)=>message.role==="user").at(-1)));
}

async function workspace(limits = "max_children = 4\nmax_depth = 2\nmax_concurrent = 1") {
  const cwd = await mkdtemp(join(tmpdir(), "chili-unified-agent-"));
  await mkdir(join(cwd,".chili"));
  await writeFile(join(cwd,".chili","config.toml"), `[agents]\n${limits}\n`);
  return {cwd,chiliHome:join(cwd,"profile"),model:"fake" as const,mcpConnectMode:"manual" as const,staleTurnRecoveryIntervalMs:false as const};
}

test("Host recovers six Agent controls from durable session identities without Team tools", async () => {
  const options=await workspace();
  const captured:ModelStreamInput[]=[];
  const model:ModelRouter={async *stream(input){ captured.push(input); yield {type:"text_delta",text:`answer:${latestText(input)}`}; yield {type:"finish",reason:"stop"}; }};
  const host=await createChiliHost({...options,modelRouter:model});
  try {
    const root=(await host.service.createSession()).sessionId;
    await host.service.submitPrompt({sessionId:root,text:"hello"});
    expect(captured.at(-1)!.tools.map((tool)=>tool.name).sort()).toEqual(DEFAULT_CODING_TOOLS.filter((name)=>name!=="request_user_input").sort());
    const agents=host.agents.forSession(root);
    const first=await agents.spawnAgent({name:"reader",prompt:"first"});
    const second=await agents.sendAgent({agentId:first.agentId,text:"second"});
    const a=await agents.waitAgent({...first,timeoutMs:5000});
    const b=await agents.waitAgent({...second,timeoutMs:5000});
    expect(a.input.outcome).toBe("completed");
    expect(b.input.outcome).toBe("completed");
    expect(textOf(a.result as Message)).toBe("answer:first");
    expect(textOf(b.result as Message)).toBe("answer:second");
    expect(a.input.inputId).not.toBe(b.input.inputId);
    const child = await host.store.session(first.agentId as SessionId);
    expect(child?.agent?.parentSessionId).toBe(root);
    expect(child).not.toHaveProperty("source");
    const callsBeforeDirectPrompt = captured.length;
    await expect(host.service.submitPrompt({ sessionId: first.agentId as SessionId, text: "bypass Agent access" })).rejects.toThrow();
    expect(captured).toHaveLength(callsBeforeDirectPrompt);
    await host.service.submitPrompt({sessionId:root,text:"inspect agents"});
    const names=captured.at(-1)!.tools.map((tool)=>tool.name);
    expect(names).toEqual(expect.arrayContaining([...AGENT_CONTROL_TOOLS]));
    expect(names.some((name)=>name.startsWith("team_")||name==="complete_task")).toBe(false);
    expect(await host.store.childSessions(root)).toHaveLength(1);
  } finally {await host.close();await rm(options.cwd,{recursive:true,force:true});}
});

test("root and nested Agents compose the same tools in Code Mode at one execution slot", async () => {
  const options=await workspace();
  const composed=new Set<SessionId>();
  const catalog:Record<string,string[]>={};
  const model:ModelRouter={async *stream(input):AsyncIterable<ModelStreamEvent>{
    const text=latestText(input);
    catalog[text]=input.tools.map((tool)=>tool.name);
    if ((text==="root"||text==="middle")&&!composed.has(input.sessionId)) {
      composed.add(input.sessionId);
      yield {type:"tool_call",name:"code_mode",input:{code:`
        const catalog = ALL_TOOLS.map(t => t.name);
        const spawned = (await tools.agent_spawn({name:"${text==="root"?"middle":"leaf"}",prompt:"${text==="root"?"middle":"leaf"}"})).structuredData;
        const answer = (await tools.agent_wait({...spawned,timeoutMs:5000})).structuredData;
        text({catalog,answer});
      `}};
      yield {type:"finish",reason:"tool_use"}; return;
    }
    yield {type:"text_delta",text:`done:${text}`};yield {type:"finish",reason:"stop"};
  }};
  const host=await createChiliHost({...options,modelRouter:model});
  try {
    const root=(await host.service.createSession()).sessionId;
    expect((await host.service.submitPrompt({sessionId:root,text:"root"})).status).toBe("completed");
    await host.waitForAgents();
    expect((await host.agents.forSession(root).listAgents({})).filter((agent)=>agent.agentId!==root)).toHaveLength(2);
    for(const text of ["root","middle","leaf"]) expect(catalog[text]).toContain("code_mode");
    const children=(await host.store.sessions()).filter((session)=>session.agent);
    for(const session of [root,...children.map((child)=>child.id)]) {
      const results=(await host.store.messages(session)).flatMap((message)=>message.parts).filter((part)=>part.type==="tool_result");
      for(const result of results) expect(result.error).toBeUndefined();
    }
    const rootResults=(await host.store.messages(root)).flatMap((message)=>message.parts).filter((part)=>part.type==="tool_result");
    const scriptCatalog: string[] = JSON.parse(rootResults[0]!.output).catalog;
    expect(scriptCatalog).toEqual(expect.arrayContaining(["write", "bash", "git_worktree", "git_apply_patch"]));
    for (const removed of ["git_status", "git_diff", "git_stage", "git_commit", "git_branch"]) {
      expect(scriptCatalog).not.toContain(removed);
    }
    expect(JSON.stringify(rootResults)).not.toContain('team_create');
  } finally {await host.close();await rm(options.cwd,{recursive:true,force:true});}
});

test("Agent pause survives Host restart; resume keeps its input and creation allowance", async () => {
  const options=await workspace("max_children = 1\nmax_depth = 1\nmax_concurrent = 1");
  let blocked=true;
  const completed:string[]=[];
  let began!:()=>void;const started=new Promise<void>((resolve)=>began=resolve);
  const model:ModelRouter={async *stream(input){
    if(blocked){began();await new Promise<void>((resolve)=>{if(input.signal?.aborted)resolve();else input.signal?.addEventListener("abort",()=>resolve(),{once:true});});input.signal?.throwIfAborted();}
    let text=latestText(input);
    if(!text){
      const recovery=input.contextualUser?.join("\n")??"";
      const original = /^Original request: (.+)$/m.exec(recovery);
      expect(original).not.toBeNull();
      expect(recovery).toContain("Never blindly replay");
      text=agentText(JSON.parse(original![1]!));
      expect(text).toBe("first");
    }
    completed.push(text);
    yield {type:"text_delta",text:`done:${text}`};yield {type:"finish",reason:"stop"};
  }};
  let host=await createChiliHost({...options,modelRouter:model});
  try{
    const root=(await host.service.createSession()).sessionId;
    const first=await host.agents.forSession(root).spawnAgent({name:"worker",prompt:"first"});
    await started;
    await host.agents.forSession(root).stopAgent({agentId:first.agentId});
    const second=await host.agents.forSession(root).sendAgent({agentId:first.agentId,text:"second"});
    await host.close();blocked=false;
    host=await createChiliHost({...options,modelRouter:model});
    const agents=host.agents.forSession(root);
    expect((await agents.listAgents({})).find((agent)=>agent.agentId===first.agentId)?.state).toBe("paused");
    expect((await agents.waitAgent({...second,timeoutMs:0})).timedOut).toBe(true);
    const resumed=await agents.resumeAgent({agentId:first.agentId});
    expect(resumed.agentId).toBe(first.agentId);
    expect(resumed.inputId).toBe(first.inputId);
    expect((await agents.waitAgent({...second,timeoutMs:5000})).input.outcome).toBe("completed");
    expect((await agents.waitAgent({...first,timeoutMs:0})).input).toMatchObject({inputId:first.inputId,outcome:"completed"});
    expect(completed).toEqual(["first","second"]);
    expect(await host.store.childSessions(root)).toHaveLength(1);
    await expect(agents.spawnAgent({name:"extra",prompt:"extra"})).rejects.toThrow();
  }finally{await host.close();await rm(options.cwd,{recursive:true,force:true});}
});
