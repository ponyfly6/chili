import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readUserModelSelection, userModelStatePath, writeUserModelSelection } from "./user-model-state.js";

test("user model state returns undefined when missing", async () => {
  const root = await mkdtempName();
  try {
    expect(await readUserModelSelection({ chiliHome: root })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user model state writes and reads the last selected model", async () => {
  const root = await mkdtempName();
  try {
    await writeUserModelSelection(
      { provider: " openai-codex ", model: " gpt-5.5 " },
      { chiliHome: root, now: () => 123 },
    );

    expect(await readUserModelSelection({ chiliHome: root })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });
    expect(JSON.parse(await readFile(userModelStatePath(root), "utf8"))).toEqual({
      modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
      updatedAt: 123,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user model state ignores malformed files", async () => {
  const root = await mkdtempName();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(userModelStatePath(root), "{not-json", "utf8");

    expect(await readUserModelSelection({ chiliHome: root })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdtempName(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chili-user-model-"));
}
