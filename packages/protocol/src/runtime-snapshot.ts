import type { ChiliEvent } from "./event.js";
import type { SessionId } from "./ids.js";
import {
  parseChiliEventArray, parseRuntimeArray, parseRuntimeBoolean, parseRuntimeIdentifier,
  parseRuntimeRecord, parseRuntimeString, rejectRuntimeUnknownFields, RuntimeValidationError,
} from "./runtime-validation.js";

export const RUNTIME_STATE_SNAPSHOT_MAX_BYTES = 8_000_000;

/** A projection and durable high-water mark read from one consistent database view. */
export interface RuntimeStateSnapshot {
  version: 1;
  /** Omitted for an empty log. Synthetic seed event IDs are never resume cursors. */
  afterEventId?: string;
  events: ChiliEvent[];
  /** All sessions replaced by this snapshot, including those with truncated history. */
  coveredSessionIds: SessionId[];
  truncated: boolean;
  warning?: string;
  /** Intermediate tool output is not durable; final tool results are recoverable. */
  temporaryOutput: "not-replayed";
}

export function parseRuntimeStateSnapshot(value: unknown, path = "response"): RuntimeStateSnapshot {
  const fail = (field: string, expectation: string): never => {
    throw new RuntimeValidationError(`${path}.${field}`, expectation);
  };
  const record = parseRuntimeRecord(value, path);
  rejectRuntimeUnknownFields(record, ["version", "afterEventId", "events", "coveredSessionIds", "truncated", "warning", "temporaryOutput"], path);
  if (record.version !== 1) fail("version", "1");
  if (record.afterEventId !== undefined) parseRuntimeIdentifier(record.afterEventId, `${path}.afterEventId`);
  parseRuntimeBoolean(record.truncated, `${path}.truncated`);
  if (record.warning !== undefined) parseRuntimeString(record.warning, `${path}.warning`, { maxChars: 2_000 });
  if (record.temporaryOutput !== "not-replayed") fail("temporaryOutput", "not-replayed");
  if (!Array.isArray(record.coveredSessionIds) || record.coveredSessionIds.length > 1_024) {
    fail("coveredSessionIds", "bounded session identifiers");
  }
  parseRuntimeArray(record.coveredSessionIds, (value, itemPath) => {
    const id = parseRuntimeIdentifier(value, itemPath);
    if (["__proto__", "prototype", "constructor"].includes(id)) throw new RuntimeValidationError(itemPath, "a safe session identifier");
    return id;
  }, `${path}.coveredSessionIds`);
  parseChiliEventArray(record.events, `${path}.events`);
  return record as unknown as RuntimeStateSnapshot;
}
