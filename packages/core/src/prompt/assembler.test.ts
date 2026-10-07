import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PromptAssembler,
  assemblePromptFragments,
  assembleRenderedPromptFragments,
  renderPromptFragment,
  type PromptFragment,
} from "./index.js";

test("prompt assembler sorts by layer and priority while preserving stable ties", () => {
  const assembly = assemblePromptFragments([
    fragment("ctx-b", "contextual_user", 10, "context b"),
    fragment("dev-b", "developer", 20, "developer b"),
    fragment("base", "base", 50, "base"),
    fragment("dev-a", "developer", 10, "developer a"),
    fragment("dev-a-tie", "developer", 10, "developer a tie"),
    fragment("ctx-a", "contextual_user", 0, "context a"),
    fragment("conversation", "conversation", 0, "conversation history"),
  ]);

  expect(assembly.fragments.map((item) => item.id)).toEqual([
    "base",
    "dev-a",
    "dev-a-tie",
    "dev-b",
    "ctx-a",
    "ctx-b",
    "conversation",
  ]);
  expect(assembly.system).toEqual(["base"]);
  expect(assembly.developer).toEqual(["developer a", "developer a tie", "developer b"]);
  expect(assembly.contextualUser).toEqual(["context a", "context b"]);
  expect(assembly.conversation).toEqual(["conversation history"]);
});

test("same material ID uses its latest value once and empty updates remove it", () => {
  const assembler = new PromptAssembler()
    .add(fragment("rule", "contextual_user", 20, "stale rule"))
    .add(fragment("other", "contextual_user", 20, "other material"))
    .add(fragment("rule", "contextual_user", 20, "fresh rule"));
  expect(assembler.assemble().contextualUser).toEqual(["fresh rule", "other material"]);
  expect(assembler.assemble().debug.fragments.filter((item) => item.id === "rule")).toHaveLength(1);
  assembler.add(fragment("rule", "contextual_user", 20, "  "));
  expect(assembler.assemble().contextualUser).toEqual(["other material"]);
});

test("duplicate material IDs cannot override another source, trust, or scope", () => {
  const original: PromptFragment = {
    ...fragment("shared", "contextual_user", 0, "original"),
    source: "memory", trust: "project", metadata: { scope: "project", projectId: "one", profile: "default", path: "/repo/rules.md" },
  };
  for (const changed of [
    { ...original, source: "runtime" as const },
    { ...original, trust: "system" as const },
    { ...original, metadata: { ...original.metadata, scope: "user" } },
    { ...original, metadata: { ...original.metadata, projectId: "two" } },
    { ...original, metadata: { ...original.metadata, profile: "other" } },
    { ...original, metadata: { ...original.metadata, path: "/elsewhere/rules.md" } },
  ]) {
    expect(() => assemblePromptFragments([original, { ...changed, content: "replacement" }])).toThrow("Prompt fragment identity collision: shared");
  }
});

test("material priority never promotes project or tool material into an instruction role", () => {
  const assembly = assemblePromptFragments([
    fragment("base", "base", 1_000, "system authority"),
    { ...fragment("project", "developer", -1_000, "project rule"), source: "project", trust: "project" },
    { ...fragment("tool", "base", -2_000, "tool instructions"), source: "mcp", trust: "tool" },
  ]);
  expect(assembly.system).toEqual(["system authority"]);
  expect(assembly.developer).toEqual([]);
  expect(assembly.contextualUser).toEqual(["tool instructions", "project rule"]);
  expect(assembly.debug.fragments.find((item) => item.id === "project")).toMatchObject({ layer: "contextual_user", metadata: { requestedLayer: "developer", authority: "reference_material" } });
  expect(renderPromptFragment({ ...fragment("direct", "base", 0, "reference"), trust: "tool" }).layer).toBe("contextual_user");
});

test("rendered extensions preserve exact source identity without adding raw text to the debug manifest", () => {
  const sourceContent = "  ---\nalwaysApply: true\n---\noriginal rule text\n";
  const assembly = assemblePromptFragments([{
    ...fragment("rule", "contextual_user", 10, "rule preview"),
    sourceContent,
    marker: { open: "<rule>", close: "</rule>" },
    metadata: { truncated: true, contentVersion: "document-revision" },
  }]);
  const extended = assembleRenderedPromptFragments([
    ...assembly.fragments,
    renderPromptFragment(fragment("final", "base", 100, "finish now")),
  ]);
  expect(extended.contextualUser).toEqual(assembly.contextualUser);
  const rendered = extended.fragments.find((item) => item.id === "rule");
  expect(rendered?.sourceContent).toBe(sourceContent);
  expect(rendered?.metadata).toEqual(assembly.fragments[0]?.metadata);
  expect(rendered?.metadata).toMatchObject({
    sourceContentVersion: createHash("sha256").update(sourceContent).digest("hex"),
    sourceChars: sourceContent.length,
    contentVersion: "document-revision",
    truncated: true,
  });
  expect(extended.debug.fragments.find((item) => item.id === "rule")).not.toHaveProperty("sourceContent");
});

test("debug manifest records id source layer and rendered char counts", () => {
  const assembly = assemblePromptFragments([
    {
      ...fragment("skills", "developer", 0, "skill catalog"),
      source: "skills",
      marker: { open: "<available_skills>", close: "</available_skills>" },
    },
  ]);

  expect(assembly.debug.fragments).toEqual([
    expect.objectContaining({
      id: "skills",
      source: "skills",
      layer: "developer",
      chars: "<available_skills>\nskill catalog\n</available_skills>".length,
    }),
  ]);
  expect(assembly.debug.totalChars).toBe(assembly.developer.join("").length);
});

test("prompt fragments have a default hard limit including marker wrappers", () => {
  const defaultBounded = assemblePromptFragments([
    fragment("unbounded", "developer", 0, "x".repeat(100_000)),
  ]).fragments[0];
  const explicitlyBounded = assemblePromptFragments([
    {
      ...fragment("wrapped", "developer", 0, "y".repeat(1_000)),
      marker: { open: "<wrapped_context>", close: "</wrapped_context>" },
      maxChars: 80,
    },
  ]).fragments[0];

  expect(defaultBounded?.content.length).toBeLessThanOrEqual(80_000);
  expect(defaultBounded?.content).toContain("fragment truncated");
  expect(explicitlyBounded?.content.length).toBeLessThanOrEqual(80);
  expect(explicitlyBounded?.content).toStartWith("<wrapped_context>");
  expect(explicitlyBounded?.content).toEndWith("</wrapped_context>");

  const impossibleWrapper = assemblePromptFragments([{
    ...fragment("impossible-wrapper", "developer", 0, "content"),
    marker: { open: "<wrapper_that_cannot_fit>", close: "</wrapper_that_cannot_fit>" },
    maxChars: 10,
  }]).fragments[0];
  expect(impossibleWrapper?.content).toBe("");

  const surrogateBounded = assemblePromptFragments([{
    ...fragment("surrogate", "developer", 0, `head${"🙂".repeat(100)}`),
    maxChars: 50,
  }]).fragments[0];
  const surrogateContent = surrogateBounded?.content ?? "";
  expect(Buffer.from(surrogateContent, "utf8").toString("utf8")).toBe(surrogateContent);
});

function fragment(
  id: string,
  layer: PromptFragment["layer"],
  priority: number,
  content: string,
): PromptFragment {
  return {
    id,
    layer,
    source: "runtime",
    priority,
    lifecycle: "turn",
    trust: "system",
    content,
  };
}
