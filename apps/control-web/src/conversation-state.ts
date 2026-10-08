/** Draft text stays in memory, independently for each task. */
export function clearSubmittedDraft(drafts: ReadonlyMap<string, string>, sessionId: string, submitted: string): ReadonlyMap<string, string> {
  if (drafts.get(sessionId) !== submitted) return drafts;
  const next = new Map(drafts);
  next.delete(sessionId);
  return next;
}

const RECENT_TASK_KEY = "chili.mobile.recent-task.v1";
type DeviceContext = { hostId: string; deviceId: string };

/** Navigation metadata only. Never persist a device record, credential or text. */
export function rememberTask(storage: Pick<Storage, "setItem">, context: DeviceContext, sessionId: string): void {
  try { storage.setItem(RECENT_TASK_KEY, JSON.stringify({ hostId: context.hostId, deviceId: context.deviceId, sessionId })); }
  catch { /* Optional navigation convenience must not block real work. */ }
}

export function readRememberedTask(storage: Pick<Storage, "getItem">, context: DeviceContext): string | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(RECENT_TASK_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.hostId === context.hostId && record.deviceId === context.deviceId
      && typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 128
      ? record.sessionId : null;
  } catch { return null; }
}

export function forgetRememberedTask(storage: Pick<Storage, "removeItem">): void {
  try { storage.removeItem(RECENT_TASK_KEY); } catch { /* Best effort; recovery still validates the current list. */ }
}
