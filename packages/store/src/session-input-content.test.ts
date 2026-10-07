import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import { StoredContentCodec } from "./content-store.js";
import { SQLITE_SCHEMA } from "./schema.js";
import { SessionInputRepository } from "./session-inputs.js";

const sessionId = "session_input_content" as SessionId;
const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

function fixture(codec?: Pick<StoredContentCodec, "storeText" | "readText" | "textBytes"> | false) {
  const db = new Database(":memory:");
  databases.push(db);
  for (const statement of SQLITE_SCHEMA) db.exec(statement);
  const contents = new Map<string, string>();
  const content: Pick<StoredContentCodec, "storeText" | "readText" | "textBytes"> = {
    storeText(text) {
      const ref = JSON.stringify({ ref: contents.size });
      contents.set(ref, text);
      return ref;
    },
    readText(stored) { return contents.get(stored) ?? stored; },
    textBytes(stored) { return Buffer.byteLength(contents.get(stored) ?? stored); },
  };
  const repository = new SessionInputRepository(db, {
    ...(codec !== false ? { content: codec ?? content } : {}),
    commit() {},
    claim: () => ({ status: "claimed" }),
    forgetClaim() {},
    assertSession() {},
    retry: (operation) => operation(),
  });
  const accept = (submissionId: string, payload: string, identity?: string) => repository.mutate({
    kind: "accept", sessionId, submissionId, inputId: `input_${submissionId}`, mode: "queue",
    payload, ...(identity !== undefined ? { identity } : {}), text: payload, source: "local",
  });
  return { db, repository, contents, accept };
}

test("input receipts retain content references and bounded previews while reads resolve full data", () => {
  const { db, repository, contents, accept } = fixture();
  const payload = "正文".repeat(2000);
  const identity = JSON.stringify({ text: payload, model: "test" });
  expect(accept("first", payload, identity).input).toMatchObject({ payload, identity });
  const stored = db.query<{ payload: string; identity: string; text: string; content_version: number }, []>(
    "select payload, identity, text, content_version from session_inputs",
  ).get()!;
  expect(stored.content_version).toBe(1);
  expect(stored.payload).not.toBe(payload);
  expect(stored.identity).not.toBe(identity);
  expect(stored.text).toBe(payload.slice(0, 2000));
  expect(repository.get(sessionId, "first")).toMatchObject({ payload, identity });
  expect(repository.getById(sessionId, "input_first")).toMatchObject({ payload, identity });
  expect(repository.queue(sessionId).items[0]?.text).toBe(payload.slice(0, 2000));
  expect(accept("first", payload, identity).duplicate).toBe(true);
  expect(contents.size).toBe(2);
  expect(() => accept("first", payload, "changed")).toThrow("different input");
  expect(contents.size).toBe(2);
});

test("matching payload and identity share one saved content reference", () => {
  const { db, contents, accept } = fixture();
  accept("default", "input");
  accept("explicit", "second", "second");
  for (const row of db.query<{ payload: string; identity: string }, []>("select payload, identity from session_inputs").all()) {
    expect(row.identity).toBe(row.payload);
  }
  expect(contents.size).toBe(2);
});

test("pending capacity counts original payload bytes instead of short content references", () => {
  const { repository, contents, accept } = fixture();
  const payload = "x".repeat(16 * 1024 * 1024);
  for (let index = 0; index < 4; index++) accept(`accepted_${index}`, payload);
  expect(() => accept("overflow", "x")).toThrow("Pending input capacity exceeded");
  expect(repository.queue(sessionId).pendingCount).toBe(4);
  expect(contents.size).toBe(4);
});

test("legacy input strings shaped like content wrappers stay literal for reads, retries, and capacity", () => {
  const codec = new StoredContentCodec(":memory:");
  const wrapper = codec.storeText("unrelated content");
  const { db, repository, accept } = fixture({
    storeText: codec.storeText.bind(codec),
    readText: codec.readText.bind(codec),
    textBytes: () => { throw new Error("Legacy payload must not be decoded for capacity"); },
  });
  db.query(`insert into session_inputs(input_id, submission_id, session_id, mode, state, payload, identity, text, source, accepted_at, updated_at)
    values ('input_legacy', 'legacy', ?, 'queue', 'pending', ?, ?, '', 'local', 0, 0)`).run(sessionId, wrapper, wrapper);
  expect(repository.get(sessionId, "legacy")).toMatchObject({ payload: wrapper, identity: wrapper });
  expect(repository.getById(sessionId, "input_legacy")).toMatchObject({ payload: wrapper, identity: wrapper });
  expect(accept("legacy", wrapper).duplicate).toBe(true);
  expect(() => accept("legacy", "unrelated content")).toThrow("different input");
  expect(accept("new", "new input").input?.payload).toBe("new input");
});

test("repositories without a content codec write literal input values with version zero", () => {
  const { db, repository, accept } = fixture(false);
  const wrapper = new StoredContentCodec(":memory:").storeText("original content");
  expect(accept("inline", wrapper).input?.payload).toBe(wrapper);
  expect(db.query<{ content_version: number }, []>("select content_version from session_inputs").get()?.content_version).toBe(0);
  expect(repository.getById(sessionId, "input_inline")?.identity).toBe(wrapper);
});
