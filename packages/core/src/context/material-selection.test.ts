import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolDefinition, TurnId } from "@chili/protocol";
import { assemblePromptFragments } from "../prompt/assembler.js";
import type { PromptFragment } from "../prompt/fragment.js";
import { contentHash, prepareModelRequest, preparedRequestFragments } from "./prepared-request.js";
import { ContextWindowBuilder } from "./window.js";

const sessionId = "material-selection" as SessionId;
const turnId = "material-selection-turn" as TurnId;

function fragment(id: string, content: string, overrides: Partial<PromptFragment> = {}): PromptFragment {
  return { id, content, layer: "contextual_user", source: "project", trust: "project", priority: 10, lifecycle: "turn", ...overrides };
}

function userMessage(): Message {
  const messageId = "current-user-correction" as MessageId;
  return {
    id: messageId, sessionId, role: "user", createdAt: 1 as TimestampMs,
    parts: [{ id: "current-user-text" as PartId, messageId, sessionId, type: "text", text: "Correction: use the new public API. The old preference is obsolete." }],
  };
}

test("empty rendered material cannot shift the source identity of the following real model content", () => {
  const sourceContent = "  full original project rule with untouched whitespace  ";
  const assembly = assemblePromptFragments([
    fragment("cannot-render", "a rule that does not fit", { maxChars: 0 }),
    fragment("current-rule", "short displayed project rule", { sourceContent }),
  ]);
  const sourceSurface = { contextualUser: assembly.contextualUser };
  const prepared = prepareModelRequest({
    sourceMessages: [], sourceSurface,
    modelInput: { sessionId, turnId, messages: [], tools: [], system: [], contextualUser: assembly.contextualUser, promptDebug: assembly.debug },
  });

  expect(prepared.contextualUser).toEqual(["short displayed project rule"]);
  expect(prepared.sources.find((source) => source.id === "cannot-render")).toMatchObject({ status: "omitted", reason: "source_fragment_budget" });
  expect(prepared.sources.find((source) => source.id === "current-rule")).toMatchObject({
    status: "included", version: contentHash(sourceContent),
    metadata: { sourceChars: sourceContent.length, renderedVersion: contentHash("short displayed project rule"), actualVersion: contentHash("short displayed project rule") },
  });
  expect(preparedRequestFragments(prepared).map((item) => item.id)).toEqual(["current-rule"]);
  expect(JSON.stringify(prepared)).not.toContain(sourceContent);
});

test("identical text from two sources cannot both claim the one admitted occurrence", () => {
  const assembly = assemblePromptFragments([fragment("rule-a", "same rule"), fragment("rule-b", "same rule")]);
  const sourceSurface = { contextualUser: assembly.contextualUser };
  const built = new ContextWindowBuilder({ maxPromptItemChars: 10 }).build([], sourceSurface);
  const prepared = prepareModelRequest({ sourceMessages: [], sourceSurface, modelInput: {
    sessionId, turnId, messages: [], tools: [], system: [], contextualUser: built.surface.contextualUser, promptDebug: assembly.debug,
  } });

  expect(prepared.contextualUser).toEqual(["same rule"]);
  expect(prepared.sources.filter((source) => source.status === "included").map((source) => source.id)).toEqual(["rule-a"]);
  expect(prepared.sources.find((source) => source.id === "rule-b")).toMatchObject({ status: "omitted", reason: "prompt_material_budget" });
});

test("optional Memory gives way to current corrections, project rules, tools and images under the full request budget", () => {
  const memory = (id: string, content: string) => fragment(id, content, {
    source: "memory", trust: "user", priority: 200, metadata: { kind: "user_memory", memoryId: id, memoryRevision: 2 },
  });
  const assembly = assemblePromptFragments([
    fragment("platform", "Always follow the current user's explicit correction.", { layer: "base", source: "core", trust: "system" }),
    fragment("project-rule", "Project rule: preserve exported interfaces."),
    memory("relevant-memory", "A useful historical project fact."),
    memory("large-memory", "旧".repeat(3_000)),
  ]);
  const current = userMessage();
  current.parts.push({ id: "image" as PartId, messageId: current.id, sessionId, type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  const tools: ToolDefinition[] = [{ name: "lookup", description: "Inspect current source facts", risk: "read", inputSchema: { type: "object" }, async execute() { return { title: "", output: "" }; } }];
  const sourceSurface = { system: assembly.system, developer: assembly.developer, contextualUser: assembly.contextualUser, tools,
    promptDebug: assembly.debug, contextWindowTokens: 5_000, requestMaxOutputTokens: 512 };
  const built = new ContextWindowBuilder().build([current], sourceSurface);
  expect(built.overflow).toBeUndefined();
  expect(built.messages).toEqual([current]);
  expect(built.surface.contextualUser).toEqual(["Project rule: preserve exported interfaces.", "A useful historical project fact."]);
  expect(built.surface.tools.map((tool) => tool.name)).toEqual(["lookup"]);
  expect(built.usage.estimatedRequestTokens).toBeLessThanOrEqual(5_000);
  expect(built.usage.estimatedRequestTokens).toBe((built.usage.contextTokens ?? 0) + (built.usage.fixedInputTokens ?? 0) + 512 + 2048);
  expect(sourceSurface.contextualUser).toHaveLength(3);
  const prepared = prepareModelRequest({ sourceMessages: [current], sourceSurface, usage: built.usage, modelInput: {
    sessionId, turnId, messages: built.messages, tools: built.surface.tools, system: built.surface.system,
    developer: built.surface.developer, contextualUser: built.surface.contextualUser, promptDebug: assembly.debug,
  } });
  expect(prepared.sources.find((source) => source.id === "large-memory")).toMatchObject({ status: "omitted", reason: "memory_context_budget", metadata: { memoryRevision: 2 } });
  expect(prepared.sources.find((source) => source.id === current.id)?.status).toBe("included");
  expect(preparedRequestFragments(prepared).map((item) => item.id)).toEqual(["platform", "project-rule", "relevant-memory"]);
});

test("identical rule and Memory text retain their different selection responsibilities", () => {
  const content = "规".repeat(3_000);
  const assembly = assemblePromptFragments([
    fragment("essential-rule", content),
    fragment("optional-memory", content, { source: "memory", priority: 200, metadata: { kind: "project_memory" } }),
  ]);
  const built = new ContextWindowBuilder().build([], {
    contextualUser: assembly.contextualUser, promptDebug: assembly.debug, contextWindowTokens: 5_000,
  });
  expect(built.surface.contextualUser).toEqual([content]);
  expect(built.overflow?.reason).toBe("fixed_input_exceeds_window");
});
