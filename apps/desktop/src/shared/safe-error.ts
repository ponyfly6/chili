import { normalizePersistedError } from "@chili/protocol";

export const MAX_DESKTOP_ERROR_MESSAGE_BYTES = 2 * 1024;

export function safeDesktopErrorMessage(error: unknown): string {
  const normalized = normalizePersistedError(error).message;
  const withoutControls = normalized.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  // Re-run the central redactor after control bytes become whitespace. This
  // prevents inputs such as `password=\0secret` from bypassing label matching.
  const safelyRedacted = normalizePersistedError(withoutControls || "Unknown error").message;
  return truncateUtf8(safelyRedacted, MAX_DESKTOP_ERROR_MESSAGE_BYTES);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}
