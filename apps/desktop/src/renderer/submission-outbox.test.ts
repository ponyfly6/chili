import { expect, test } from "bun:test";
import { SubmissionOutbox } from "./submission-outbox.js";

test("uncertain input survives a new renderer and keeps the original retry identity", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const first = new SubmissionOutbox(storage);
  const input = { projectId: "a", sessionId: "s", text: "Build it", mode: "followup" as const };
  const original = first.reserve(input);
  first.uncertain(original.submissionId);
  const restarted = new SubmissionOutbox(storage);
  expect(restarted.snapshot()).toEqual([{ ...original, state: "unknown" }]);
  expect(restarted.reserve(input).submissionId).toBe(original.submissionId);
  restarted.accepted(original.submissionId);
  expect(restarted.reserve(input).submissionId).not.toBe(original.submissionId);
});

test("editing a failed draft never overwrites its unresolved submission", () => {
  const outbox = new SubmissionOutbox();
  const input = { projectId: "a", sessionId: "s", text: "one", mode: "followup" as const };
  const first = outbox.reserve(input); outbox.uncertain(first.submissionId);
  outbox.reserve({ ...input, text: "two" });
  outbox.reserve({ ...input, projectId: "b" });
  expect(outbox.snapshot()).toHaveLength(3);
  expect(outbox.reserve(input).submissionId).toBe(first.submissionId);
});

test("storage failure prevents dispatch admission instead of pretending the message is saved", () => {
  const outbox = new SubmissionOutbox({ getItem: () => null, setItem: () => { throw new Error("full"); } });
  expect(() => outbox.reserve({ sessionId: "s", mode: "followup", text: "keep me" })).toThrow("full");
  expect(outbox.snapshot()).toHaveLength(0);
});

test("observed durable receipt keeps retry identity until the sender observes its acceptance", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value; } };
  const first = new SubmissionOutbox(storage);
  const input = { sessionId: "session", projectId: "project", text: "same text", mode: "followup" as const };
  const original = first.reserve(input);
  first.confirm(original.submissionId);
  expect(first.snapshot()[0]?.state).toBe("confirmed");
  expect(new SubmissionOutbox(storage).snapshot()).toHaveLength(0);
  expect(first.reserve(input).submissionId).toBe(original.submissionId);
  const restored = new SubmissionOutbox(storage);
  const unknown = restored.snapshot()[0]!;
  restored.confirm(unknown.submissionId);
  expect(restored.snapshot()[0]?.state).toBe("confirmed");
  expect(restored.reserve(input).submissionId).toBe(original.submissionId);
  restored.accepted(original.submissionId);
  expect(restored.reserve(input).submissionId).not.toBe(original.submissionId);
});
