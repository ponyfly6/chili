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

export function normalizeRetryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  return {
    maxAttempts: policy?.maxAttempts ?? 2,
    initialDelayMs: policy?.initialDelayMs ?? 250,
    maxDelayMs: policy?.maxDelayMs ?? 2_000,
    factor: policy?.factor ?? 2,
    retryable: policy?.retryable ?? isRetryableTransientError,
  };
}

export function retryDelay(policy: Required<RetryPolicy>, attempt: number): number {
  const delay = policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.round(delay));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableTransientError(error: unknown): boolean {
  return isRetryableTransientErrorValue(error, new Set<object>());
}

function isRetryableTransientErrorValue(value: unknown, seen: Set<object>): boolean {
  if (typeof value === "string") return isRetryableMessage(value);
  if (!isRecord(value)) return false;
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

  if ("cause" in value && isRetryableTransientErrorValue(value.cause, seen)) return true;

  const errors = value.errors;
  if (Array.isArray(errors) && errors.some((item) => isRetryableTransientErrorValue(item, seen))) return true;

  return false;
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
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
