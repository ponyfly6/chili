import { expect, test } from "bun:test";
import {
  assemblePromptFragments,
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
