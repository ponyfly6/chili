export interface PendingSubmission {
  projectId?: string;
  sessionId: string;
  mode: "queue" | "steer" | "followup";
  text: string;
  submissionId: string;
  state: "sending" | "unknown" | "confirmed";
}
interface OutboxStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = "chili.pending-submissions.v1";

/** Stores uncertain delivery identity before IPC. It never automatically resends. */
export class SubmissionOutbox {
  private entries: PendingSubmission[];
  private listeners = new Set<() => void>();
  constructor(private readonly storage?: OutboxStorage) {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved) || saved.some((entry) => !entry || typeof entry !== "object"
      || typeof entry.submissionId !== "string" || typeof entry.sessionId !== "string" || typeof entry.text !== "string"
      || !["queue", "steer", "followup"].includes(entry.mode))) throw new Error("无法恢复未确认的消息，请保留当前内容并重试。");
    this.entries = (saved as PendingSubmission[]).map((entry) => ({ ...entry, state: "unknown" }));
  }
  snapshot = (): readonly PendingSubmission[] => this.entries;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  reserve(input: Omit<PendingSubmission, "submissionId" | "state">): PendingSubmission {
    const existing = this.entries.find((entry) => entry.projectId === input.projectId && entry.sessionId === input.sessionId && entry.mode === input.mode && entry.text === input.text);
    const entry: PendingSubmission = { ...input, submissionId: existing?.submissionId ?? crypto.randomUUID(), state: "sending" };
    this.publish([...this.entries.filter((item) => item.submissionId !== entry.submissionId), entry]);
    return entry;
  }
  accepted(id: string): void { this.publish(this.entries.filter((entry) => entry.submissionId !== id)); }
  confirm(id: string): void {
    this.publish(this.entries.map((entry) => entry.submissionId === id ? { ...entry, state: "confirmed" } : entry));
  }
  uncertain(id: string): void { this.publish(this.entries.map((entry) => entry.submissionId === id ? { ...entry, state: "unknown" } : entry)); }
  private publish(entries: PendingSubmission[]): void {
    this.storage?.setItem(KEY, JSON.stringify(entries.filter((entry) => entry.state !== "confirmed")));
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

let outbox: SubmissionOutbox | undefined;
export function submissionOutbox(): SubmissionOutbox {
  return outbox ??= new SubmissionOutbox(typeof localStorage === "undefined" ? undefined : localStorage);
}
