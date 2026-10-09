import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { StoredContentCodec } from "./content-store.js";

test("deleting content scopes removes disk blobs and preserves other sessions and global content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-content-delete-"));
  const codec = new StoredContentCodec(join(directory, "events.sqlite"));
  try {
    const deleted = codec.storeText("private text", "session_delete");
    const structured = codec.jsonReference({ output: "private structured text" }, "session_delete");
    const kept = codec.storeText("private text", "session_keep");
    const global = codec.storeText("global text");

    codec.deleteSessions(["session_delete", "session_delete", "../../missing"]);

    expect(() => codec.readText(deleted)).toThrow();
    expect(() => codec.resolve(structured, true)).toThrow();
    expect(codec.readText(kept)).toBe("private text");
    expect(codec.readText(global)).toBe("global text");
    expect(await readdir(codec.directory!)).toHaveLength(2);
    codec.deleteSessions(["session_delete"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleting content scopes releases in-memory blobs without affecting other sessions", () => {
  const codec = new StoredContentCodec(":memory:");
  const deleted = codec.storeText("same text", "session_delete");
  const kept = codec.storeText("same text", "session_keep");
  codec.deleteSessions(["session_delete"]);
  expect(() => codec.readText(deleted)).toThrow();
  expect(codec.readText(kept)).toBe("same text");
  expect(codec.readText(codec.storeText("new text", "session_delete"))).toBe("new text");
});

test("deleting a literal global session preserves its legacy shared unscoped content", () => {
  const codec = new StoredContentCodec(":memory:");
  const global = codec.storeText("unrelated unscoped content");
  const session = codec.storeText("legacy session content", "global");
  codec.deleteSessions(["global"]);
  expect(codec.readText(global)).toBe("unrelated unscoped content");
  expect(codec.readText(session)).toBe("legacy session content");
});
