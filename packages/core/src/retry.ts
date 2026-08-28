export interface RetryPolicy {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  retryable?: (error: Error) => boolean;
}

const RETRYABLE_ERROR_NAMES = new Set([
  "FetchError",
  "NetworkError",
  "SseIdleTimeoutError",
  "TimeoutError",
]);

const RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  /\brate limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\boverloaded\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\binternal server error\b/i,
  /\bnetwork\b/i,
  /\btimeout\b/i,
  /\btimed\s*out\b/i,
  /\betimedout\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bsocket connection was closed unexpectedly\b/i,
  /\bconnection (?:reset|closed|aborted|terminated)\b/i,
  /\beconnreset\b/i,
  /\beconnaborted\b/i,
  /\beai_again\b/i,
  /\bepipe\b/i,
];
const MAX_ERROR_GRAPH_DEPTH = 8;
const MAX_ERROR_GRAPH_NODES = 256;
const MAX_AGGREGATE_ERRORS = 64;

export function normalizeRetryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  return {
    maxAttempts: policy?.maxAttempts ?? 2,
    initialDelayMs: policy?.initialDelayMs ?? 250,
    maxDelayMs: policy?.maxDelayMs ?? 2_000,
    factor: policy?.factor ?? 2,
    retryable: policy?.retryable ?? isRetryableTransientError,
  };
}

export function retryDelay(policy: Required<RetryPolicy>, attempt: number, error?: unknown): number {
  const delay = policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1);
  const backoffMs = Math.min(policy.maxDelayMs, Math.round(delay));
  const retryAfterMs = retryAfterDelayHint(error);
  return retryAfterMs === undefined ? backoffMs : Math.max(backoffMs, retryAfterMs);
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryableTransientError(error: unknown): boolean {
  // Provider classifications are authoritative anywhere in the wrapped error
  // graph. A non-retryable verdict vetoes retryable verdicts; heuristics run
  // only when no explicit verdict exists.
  const explicit = explicitRetryability(error, new Set<object>(), 0);
  if (explicit !== undefined) return explicit;
  return isRetryableTransientErrorValue(error, new Set<object>(), 0);
}

export function retryAfterDelayHint(error: unknown): number | undefined {
  return retryAfterHint(error, new Set<object>(), 0);
}

function isRetryableTransientErrorValue(value: unknown, seen: Set<object>, depth: number): boolean {
  if (typeof value === "string") return isRetryableMessage(value);
  if (!isRecord(value) || depth > MAX_ERROR_GRAPH_DEPTH || seen.size >= MAX_ERROR_GRAPH_NODES) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const name = stringProperty(value, "name");
  if (name && RETRYABLE_ERROR_NAMES.has(name)) return true;

  const code = stringProperty(value, "code") ?? stringProperty(value, "errno");
  if (code && RETRYABLE_ERROR_CODES.has(code.toUpperCase())) return true;

  const status = numberProperty(value, "status") ?? numberProperty(value, "statusCode");
  if (status !== undefined && isRetryableHttpStatus(status)) return true;

  const message = stringProperty(value, "message");
  if (message && isRetryableMessage(message)) return true;

  const cause = safeProperty(value, "cause");
  if (cause !== undefined && isRetryableTransientErrorValue(cause, seen, depth + 1)) return true;

  const errors = safeProperty(value, "errors");
  const errorCount = safeArrayLength(errors);
  if (errorCount > 0) {
    for (let index = 0; index < Math.min(errorCount, MAX_AGGREGATE_ERRORS); index += 1) {
      if (isRetryableTransientErrorValue(safeProperty(errors, index), seen, depth + 1)) return true;
    }
  }

  return false;
}

function explicitRetryability(value: unknown, seen: Set<object>, depth: number): boolean | undefined {
  if (!isRecord(value) || seen.has(value) || depth > MAX_ERROR_GRAPH_DEPTH || seen.size >= MAX_ERROR_GRAPH_NODES) {
    return undefined;
  }
  seen.add(value);

  const direct = booleanProperty(value, "retryable");
  if (direct === false) return false;
  let foundRetryable = direct === true;

  const cause = safeProperty(value, "cause");
  if (cause !== undefined) {
    const nested = explicitRetryability(cause, seen, depth + 1);
    if (nested === false) return false;
    if (nested === true) foundRetryable = true;
  }

  const errors = safeProperty(value, "errors");
  const errorCount = safeArrayLength(errors);
  if (errorCount > 0) {
    for (let index = 0; index < Math.min(errorCount, MAX_AGGREGATE_ERRORS); index += 1) {
      const nested = explicitRetryability(safeProperty(errors, index), seen, depth + 1);
      if (nested === false) return false;
      if (nested === true) foundRetryable = true;
    }
  }

  return foundRetryable ? true : undefined;
}

function isRetryableMessage(message: string): boolean {
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)) || isRetryableHttpStatusMessage(message);
}

function isRetryableHttpStatusMessage(message: string): boolean {
  const match = /\b(?:http|status(?:\s+code)?)[^0-9]{0,16}(\d{3})\b/i.exec(message);
  if (!match) return false;
  return isRetryableHttpStatus(Number.parseInt(match[1] ?? "", 10));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = safeProperty(record, key);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = safeProperty(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanProperty(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = safeProperty(record, key);
  return typeof value === "boolean" ? value : undefined;
}

function retryAfterHint(value: unknown, seen: Set<object>, depth: number): number | undefined {
  if (!isRecord(value) || seen.has(value) || depth > MAX_ERROR_GRAPH_DEPTH || seen.size >= MAX_ERROR_GRAPH_NODES) {
    return undefined;
  }
  seen.add(value);

  const direct = numberProperty(value, "retryAfterMs");
  if (direct !== undefined && direct >= 0) return Math.round(direct);
  const cause = safeProperty(value, "cause");
  return cause === undefined ? undefined : retryAfterHint(cause, seen, depth + 1);
}

function safeProperty(record: unknown, key: PropertyKey): unknown {
  if ((typeof record !== "object" && typeof record !== "function") || record === null) return undefined;
  try {
    return Reflect.get(record, key);
  } catch {
    return undefined;
  }
}

function safeArrayLength(value: unknown): number {
  try {
    if (!Array.isArray(value)) return 0;
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortError(): Error {
  const error = new Error("Retry wait aborted");
  error.name = "AbortError";
  return error;
}
