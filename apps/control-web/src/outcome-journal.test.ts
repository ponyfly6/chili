import { describe, expect, test } from "bun:test";
import { OutcomeJournal, browserOutcomeStore, journaledMutation, readStoredOutcomes, type OutcomeStore, type StoredMutationOutcome } from "./outcome-journal.js";
import type { UnknownMutationOutcome } from "./control-feedback.js";
import { readAnswerReceipt, readSendReceipt, readStopReceipt } from "./view-model.js";

const send: UnknownMutationOutcome = { id: "local-1", sessionId: "session-1", sessionTitle: "私密任务", command: "Queue", startedAt: 1_700_000_000_000, promptPreview: "私密正文" };
const answer: UnknownMutationOutcome = { ...send, id: "local-2", command: "Answer", inputId: "input-1" };

function memoryStore() {
  let records: readonly StoredMutationOutcome[] = [];
  const store: OutcomeStore = { async load() { return records; }, async save(next) { records = structuredClone(next); } };
  return { store, read: () => records };
}

describe("durable command reminders", () => {
  test("writes a minimal reminder before a mutation and clears it only after a valid receipt", async () => {
    const { store, read } = memoryStore();
    const journal = new OutcomeJournal(store);
    await journal.load();
    expect(await journaledMutation(journal, send, async () => {
      expect(read()).toHaveLength(1);
      expect(JSON.stringify(read())).not.toContain("私密");
      expect(read()[0]).toEqual({ id: send.id, sessionId: send.sessionId, command: send.command, startedAt: send.startedAt });
      return { status: "accepted" };
    }, readSendReceipt)).toBe("accepted");
    expect(read()).toHaveLength(0);
  });

  test("app termination after dispatch restores the warning without replaying a command", async () => {
    const { store } = memoryStore();
    const journal = new OutcomeJournal(store);
    await journal.load();
    await journal.prepare(answer);
    const restored = await new OutcomeJournal(store).load();
    expect(restored).toEqual([{ id: answer.id, sessionId: answer.sessionId, command: "Answer", inputId: "input-1", startedAt: answer.startedAt, sessionTitle: "此前任务" }]);
    expect(JSON.stringify(restored)).not.toContain("私密");
  });

  test("unknown results and malformed receipts survive reload for all write kinds", async () => {
    for (const [outcome, reader] of [[send, readSendReceipt], [answer, readAnswerReceipt], [{ ...send, command: "Stop" }, readStopReceipt]] as const) {
      const { store } = memoryStore();
      const journal = new OutcomeJournal(store);
      await journal.load();
      await expect(journaledMutation(journal, outcome, async () => ({}), (value) => reader(value))).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(await new OutcomeJournal(store).load()).toHaveLength(1);
    }
  });

  test("storage failure prevents the command from being sent", async () => {
    let dispatched = false;
    const journal = new OutcomeJournal({ async load() { return []; }, async save() { throw new Error("disk full"); } });
    await journal.load();
    await expect(journaledMutation(journal, send, async () => { dispatched = true; return {}; }, readSendReceipt)).rejects.toMatchObject({ code: "outcome_storage_unavailable" });
    expect(dispatched).toBe(false);
  });

  test("any receipt validation failure retains the dispatched operation", async () => {
    const { store, read } = memoryStore();
    const journal = new OutcomeJournal(store);
    await journal.load();
    await expect(journaledMutation(journal, send, async () => ({ malformed: true }), () => {
      throw Object.assign(new Error("bad receipt"), { code: "invalid_response" });
    })).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(read()).toHaveLength(1);
    expect(await new OutcomeJournal(store).load()).toHaveLength(1);
  });

  test("a definite remote rejection removes only its own reminder", async () => {
    const { store, read } = memoryStore();
    const journal = new OutcomeJournal(store);
    await journal.load();
    await journal.prepare(answer);
    await expect(journaledMutation(journal, send, async () => { throw { code: "capability_not_granted" }; }, readSendReceipt)).rejects.toMatchObject({ code: "capability_not_granted" });
    expect(read().map((item) => item.id)).toEqual([answer.id]);
  });

  test("concurrent prepare and confirmation cannot erase a different pending operation", async () => {
    const { store, read } = memoryStore();
    const journal = new OutcomeJournal(store);
    await journal.load();
    await Promise.all([journal.prepare(send), journal.prepare(answer)]);
    expect(read()).toHaveLength(2);
    await journal.confirm(send.id);
    expect(read().map((item) => item.id)).toEqual([answer.id]);
  });

  test("receipt received but storage cleanup failed remains a conservative unknown", async () => {
    const { store, read } = memoryStore();
    const journal = new OutcomeJournal({ load: store.load, async save(items) { if (items.length === 0) throw new Error("locked"); await store.save(items); } });
    await journal.load();
    await expect(journaledMutation(journal, answer, async () => ({ resolved: true }), readAnswerReceipt)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(read()).toHaveLength(1);
  });

  test("corrupt journals fail closed rather than silently deleting uncertainty", async () => {
    for (const value of [{}, [null], [{ ...send, startedAt: -1 }], [{ ...send, command: "Execute" }], [send, send]]) {
      expect(() => readStoredOutcomes(value)).toThrow();
    }
    expect(readStoredOutcomes([send])[0]).not.toHaveProperty("promptPreview");
    expect(readStoredOutcomes([send])[0]).not.toHaveProperty("sessionTitle");
  });

  test("browser storage contains reminders only and removing them does not affect other keys", async () => {
    const values = new Map<string, string>([["unrelated", "retained"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
    const journal = new OutcomeJournal(browserOutcomeStore(() => storage));
    await journal.load();
    await journal.prepare(send);
    const persisted = [...values.values()].join();
    expect(persisted).not.toContain("私密");
    expect(persisted).not.toContain("token");
    expect(await new OutcomeJournal(browserOutcomeStore(() => storage)).load()).toHaveLength(1);
    await journal.confirm(send.id);
    expect([...values.entries()]).toEqual([["unrelated", "retained"]]);
  });
});
