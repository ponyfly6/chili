const MAX_PUBLIC_ERROR_CHARS = 600;
const MAX_FAILURE_CHECKPOINT_CHARS = 4_000;
const FAILURE_CHECKPOINT_HEADER =
  "Incomplete partial result saved before the model request failed. This is not a complete answer.";
const FAILURE_CHECKPOINT_FOOTER =
  "The task remains incomplete. Continue after the model service recovers.";

export function publicStatusReason(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (looksLikeMarkup(value)) {
    const status = httpStatusFromMarkup(value);
    return status
      ? `Provider request failed with HTTP ${status} (unsafe markup response hidden)`
      : "Provider request failed (unsafe markup response hidden)";
  }

  const normalized = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_PUBLIC_ERROR_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PUBLIC_ERROR_CHARS - 1).trimEnd()}…`;
}

export function publicSyntheticAssistantText(value: string, synthetic: boolean | undefined): string {
  if (!synthetic) return value;

  const checkpoint = publicFailureCheckpointText(value);
  if (checkpoint !== undefined) return checkpoint;

  const trimmed = value.trimStart();
  const failurePrefix = /^model request failed\s*:\s*/i.exec(trimmed);
  const payload = failurePrefix ? trimmed.slice(failurePrefix[0].length) : trimmed;
  const safe = publicStatusReason(payload)
    ?? (failurePrefix ? "Provider request failed" : "Synthetic runtime message hidden");
  return failurePrefix ? `Model request failed: ${safe}` : safe;
}

function publicFailureCheckpointText(value: string): string | undefined {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (
    normalized.length > MAX_FAILURE_CHECKPOINT_CHARS
    || !normalized.startsWith(`${FAILURE_CHECKPOINT_HEADER}\n\n`)
    || !normalized.endsWith(`\n\n${FAILURE_CHECKPOINT_FOOTER}`)
  ) {
    return undefined;
  }

  const lines = normalized.split("\n");
  const safeLines: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.startsWith("- ")) {
      let end = index + 1;
      while (end < lines.length && (lines[end] ?? "").startsWith("  ")) end += 1;
      const item = lines.slice(index, end);
      if (looksLikeMarkup(item.join("\n"))) {
        safeLines.push("- [unsafe markup hidden]");
      } else {
        safeLines.push(...item.map(sanitizeCheckpointLine));
      }
      index = end;
      continue;
    }

    safeLines.push(looksLikeMarkup(line) ? "[unsafe markup hidden]" : sanitizeCheckpointLine(line));
    index += 1;
  }
  return safeLines.join("\n");
}

function sanitizeCheckpointLine(value: string): string {
  return redactSensitiveText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

function looksLikeMarkup(value: string): boolean {
  const sample = value.slice(0, 8_192);
  return /<!doctype\b|<!--|<\/?[a-z][^>]*>/i.test(sample);
}

function httpStatusFromMarkup(value: string): string | undefined {
  return /(?:http\s*)?\b([45]\d{2})\b/i.exec(value.slice(0, 8_192))?.[1];
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b(?:[a-f\d]{0,4}:){2,7}[a-f\d]{0,4}\b/gi, "[redacted-ip]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted-token]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted-token]")
    .replace(/(basic\s+)[A-Za-z0-9+/=]{8,}/gi, "$1[redacted-credential]")
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted-credential]@")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|secret|credential|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted-credential]");
}
