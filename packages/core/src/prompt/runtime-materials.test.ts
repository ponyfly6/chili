import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { PreparedModelRequest } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "../runtime.js";
import { RuntimeService } from "../runtime-service.js";
import { SingleAgentRuntime } from "../single-agent-runtime.js";
import type { PromptFragment } from "./fragment.js";

const resources: Array<{ service: RuntimeService; store: SqliteEventStore }> = [];
afterEach(async () => {
  for (const { service, store } of resources.splice(0)) {
    await service.shutdown();
    store.close();
  }
});

for (const maxTurns of [4, 1]) {
  test(`each tool step reloads material and preserves exact source provenance${maxTurns === 1 ? " for the final response" : ""}`, async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new InMemoryToolRegistry();
    const requests: ModelStreamInput[] = [];
    let loadCount = 0;
    let revision = 1;
    const rawRule = () => `  ---\nalwaysApply: true\n---\nRULE_REVISION_${revision}\n`;
    registry.register({
      name: "refresh_material",
      description: "Update the fake project rule and saved memory.",
      risk: "read",
      inputSchema: { type: "object" },
      resources: () => false,
      execute: async () => {
        revision = 2;
        return { title: "updated", output: "rule and memory changed" };
      },
    });
    const model: ModelRouter = {
      async *stream(input): AsyncIterable<ModelStreamEvent> {
        requests.push(input);
        expect(input.system).toEqual(expect.arrayContaining(["trusted base"]));
        expect(input.system.join("\n")).not.toContain("RULE_REVISION");
        expect(input.developer?.join("\n")).not.toContain("RULE_REVISION");
        expect(input.contextualUser).toEqual([
          `<project_rule>\nRULE_REVISION_${revision}\n</project_rule>`,
          `MEMORY_REVISION_${revision}`,
        ]);
        if (requests.length === 1) {
          yield { type: "tool_call", name: "refresh_material", input: {} };
          yield { type: "finish", reason: "tool_use" };
        } else {
          expect(revision).toBe(2);
          expect(input.contextualUser?.join("\n")).not.toContain("STALE_DUPLICATE");
          if (maxTurns === 1) expect(input.tools).toHaveLength(0);
          yield { type: "text_delta", text: "used the latest material" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const runtime = new SingleAgentRuntime({
      store, model, toolRegistry: registry,
      toolExecutor: new ToolExecutor({ registry, events: { publish: (event) => store.append(event) }, gate: { review: async () => ({ decision: "allow" }) } }),
    });
    const service = new RuntimeService({
      runtime, store, cwd: tmpdir(), maxTurns,
      promptFragments: () => {
        loadCount++;
        const rule: PromptFragment = {
          id: "project.rule", source: "project", layer: "developer", trust: "project",
          lifecycle: "session", priority: 10,
          content: `RULE_REVISION_${revision}`, sourceContent: rawRule(),
          marker: { open: "<project_rule>", close: "</project_rule>" },
          metadata: { scope: "project", projectId: "fixture", path: "/project/rule.md", contentVersion: `file:${revision}` },
        };
        return [
          { id: "base", source: "core", layer: "base", trust: "system", lifecycle: "stable", priority: 0, content: "trusted base" },
          { ...rule, content: "STALE_DUPLICATE" },
          rule,
          { id: "memory.entry", source: "memory", layer: "contextual_user", trust: "user", lifecycle: "session", priority: 20, content: `MEMORY_REVISION_${revision}`, metadata: { scope: "user", memoryId: "memory_entry", memoryRevision: revision } },
        ];
      },
    });
    resources.push({ service, store });
    const { sessionId } = await service.createSession({ cwd: tmpdir() });
    const result = await service.submitPrompt({ sessionId, text: "Update the rule and then continue with the latest material." });
    expect(result.status).toBe("completed");
    expect(loadCount).toBe(2);
    expect(requests).toHaveLength(2);
    const preparedEvents = await store.events({ sessionId, type: "model.request_prepared" });
    const prepared = preparedEvents.map((event) => (event.payload as { request: PreparedModelRequest }).request);
    expect(prepared).toHaveLength(2);
    for (const [index, request] of prepared.entries()) {
      const version = index + 1;
      const exactRaw = `  ---\nalwaysApply: true\n---\nRULE_REVISION_${version}\n`;
      const ruleSource = request.sources.filter((source) => source.id === "project.rule");
      expect(ruleSource).toHaveLength(1);
      expect(ruleSource[0]).toMatchObject({
        kind: "contextual_user", status: "included",
        metadata: {
          source: "project", trust: "project", lifecycle: "session", scope: "project", projectId: "fixture", path: "/project/rule.md",
          requestedLayer: "developer", authority: "reference_material", contentVersion: `file:${version}`,
          sourceContentVersion: createHash("sha256").update(exactRaw).digest("hex"), sourceChars: exactRaw.length,
        },
      });
      expect(request.contextualUser).toEqual(requests[index]?.contextualUser ?? []);
      expect(JSON.stringify(request)).not.toContain("alwaysApply: true");
    }
    const inspected = await service.inspectPrompt({ sessionId, includeContent: true });
    expect(inspected.preparedRequest?.contentVersion).toBe(prepared[1]?.contentVersion);
    expect(inspected.fragments.find((item) => item.id === "project.rule")?.content).toBe(prepared[1]?.contextualUser[0]);
  });
}
