import type { UnknownMutationOutcome } from "./control-feedback.js";

/** No titles, prompts, answers, credentials, or replay identifiers are stored. */
export interface StoredMutationOutcome {
  id: string;
  sessionId: string;
  command: UnknownMutationOutcome["command"];
  startedAt: number;
  inputId?: string;
}

export interface OutcomeStore {
  load(): Promise<readonly StoredMutationOutcome[]>;
  save(outcomes: readonly StoredMutationOutcome[]): Promise<void>;
}

const STORAGE_KEY = "chili.control.unresolved.v1";
const MAX_OUTCOMES = 200;

/** Browser authorization remains memory-only; this store contains reminders only. */
export function browserOutcomeStore(storage: () => Storage = () => window.localStorage): OutcomeStore {
  return {
    async load() {
      const value = storage().getItem(STORAGE_KEY);
      return value === null ? [] : readStoredOutcomes(JSON.parse(value));
    },
    async save(outcomes) {
      if (outcomes.length === 0) storage().removeItem(STORAGE_KEY);
      else storage().setItem(STORAGE_KEY, JSON.stringify(outcomes));
    },
  };
}

/** Serialize read-modify-write so a concurrent Stop cannot erase a Send reminder. */
export class OutcomeJournal {
  #records: readonly StoredMutationOutcome[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  #loaded = false;
  constructor(private readonly store: OutcomeStore) {}

  load(): Promise<UnknownMutationOutcome[]> {
    return this.#serialize(async () => {
      this.#records = readStoredOutcomes(await this.store.load());
      this.#loaded = true;
      return this.#records.map((record) => ({ ...record, sessionTitle: "此前任务" }));
    });
  }

  prepare(outcome: UnknownMutationOutcome): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#loaded || this.#records.length >= MAX_OUTCOMES) throw storageError();
      if (this.#records.some((record) => record.id === outcome.id)) throw storageError();
      const record: StoredMutationOutcome = {
        id: outcome.id, sessionId: outcome.sessionId, command: outcome.command, startedAt: outcome.startedAt,
        ...(outcome.inputId ? { inputId: outcome.inputId } : {}),
      };
      const records = [...this.#records, record];
      await this.store.save(records);
      this.#records = records;
    });
  }

  confirm(id: string): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#loaded) throw storageError();
      const records = this.#records.filter((record) => record.id !== id);
      await this.store.save(records);
      this.#records = records;
    });
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(action).catch(() => { throw storageError(); });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

export function readStoredOutcomes(value: unknown): StoredMutationOutcome[] {
  if (!Array.isArray(value) || value.length > MAX_OUTCOMES) throw storageError();
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw storageError();
    const record = item as Record<string, unknown>;
    if (!shortString(record.id) || !shortString(record.sessionId) || seen.has(record.id)
      || typeof record.command !== "string" || !["Queue", "Steer", "Stop", "Answer"].includes(record.command)
      || typeof record.startedAt !== "number" || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0
      || (record.inputId !== undefined && !shortString(record.inputId))) throw storageError();
    seen.add(record.id);
    return {
      id: record.id, sessionId: record.sessionId, command: record.command as StoredMutationOutcome["command"], startedAt: record.startedAt,
      ...(typeof record.inputId === "string" ? { inputId: record.inputId } : {}),
    };
  });
}

/** A durable marker must exist before any write reaches the desktop. */
export async function journaledMutation<T>(
  journal: OutcomeJournal,
  outcome: UnknownMutationOutcome,
  dispatch: () => Promise<unknown>,
  readReceipt: (value: unknown) => T,
): Promise<T> {
  await journal.prepare(outcome);
  let result: unknown;
  try {
    result = await dispatch();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code).toLowerCase() === "outcome_unknown") throw error;
    try { await journal.confirm(outcome.id); }
    catch { throw unknownError(); }
    throw error;
  }
  // Once dispatch returns, a parser failure is never evidence of non-execution.
  let receipt: T;
  try { receipt = readReceipt(result); }
  catch { throw unknownError(); }
  try { await journal.confirm(outcome.id); }
  catch { throw unknownError(); }
  return receipt;
}

function unknownError(): Error & { code: string } {
  return Object.assign(new Error("Command reminder still needs review"), { code: "outcome_unknown" });
}

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function storageError(): Error & { code: string } {
  return Object.assign(new Error("Unable to save command reminder"), { code: "outcome_storage_unavailable" });
}
