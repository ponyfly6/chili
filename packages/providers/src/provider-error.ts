import { isIP } from "node:net";

export type ProviderErrorCategory =
  | "rate_limit"
  | "quota_exhausted"
  | "plan_capacity"
  | "authentication"
  | "invalid_request"
  | "server_error"
  | "unknown";

export interface ProviderErrorClassificationInput {
  provider: string;
  status?: number;
  code?: string | number;
  type?: string;
  message?: string;
}

export interface ProviderErrorClassification {
  category: ProviderErrorCategory;
  retryable: boolean;
  opensCircuit: boolean;
}

export interface ProviderErrorDetails {
  message?: string;
  publicMessage?: string;
  code?: string | number;
  type?: string;
  param?: string;
  requestId?: string;
  retryAfterMs?: number;
  category?: ProviderErrorCategory;
  retryable?: boolean;
  opensCircuit?: boolean;
}

export interface ProviderErrorOptions extends ProviderErrorClassificationInput {
  category?: ProviderErrorCategory;
  retryable?: boolean;
  opensCircuit?: boolean;
  param?: string;
  requestId?: string;
  retryAfterMs?: number;
}

export interface ProviderHttpErrorContext {
  status: number;
  json?: unknown;
}

export interface ProviderHttpErrorOptions {
  provider: string;
  label: string;
  selectJson?: (context: ProviderHttpErrorContext) => ProviderErrorDetails | undefined;
}

export interface ProviderPayloadErrorOptions {
  provider: string;
  label: string;
  status?: number;
  details?: ProviderErrorDetails;
  response?: Response;
}

export const PROVIDER_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const PROVIDER_PUBLIC_ERROR_MAX_BYTES = 1024;
export const PROVIDER_RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

const HTTP_STATUS_LABELS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Service Overloaded",
};

const MARKUP_PATTERN = /(?:<!doctype\s+html|<!--|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]{0,512})?\s*\/?>)/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const MACHINE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SENSITIVE_FIELD_NAME_PATTERN = /(?:credentials?|password|passwd|secrets?|cookies?|authorization|bearer|api[_ -]?keys?|tokens?)/i;
const IPV6_CANDIDATE_PATTERN = /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9:])/g;

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly provider: string;
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  readonly opensCircuit: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    const safeMessage = safePublicText(message) ?? "Provider request failed";
    super(safeMessage);
    const classification = classifyProviderError({
      provider: options.provider,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.code !== undefined ? { code: options.code } : {}),
      ...(typeof options.type === "string" ? { type: options.type } : {}),
      message: typeof message === "string" ? message : safeMessage,
    });
    this.provider = safeDetailText(options.provider) ?? "unknown";
    this.category = options.category ?? classification.category;
    this.retryable = options.retryable ?? classification.retryable;
    this.opensCircuit = options.opensCircuit ?? classification.opensCircuit;
    if (isFiniteStatus(options.status)) this.status = options.status;
    const code = safeMachineTag(normalizeCode(options.code));
    const type = safeMachineTag(typeof options.type === "string" ? options.type : undefined);
    const param = safeMachineTag(typeof options.param === "string" ? options.param : undefined);
    const requestId = safeRequestId(typeof options.requestId === "string" ? options.requestId : undefined);
    const retryAfterMs = clampProviderRetryAfterMs(options.retryAfterMs);
    if (code) this.code = code;
    if (type) this.type = type;
    if (param) this.param = param;
    if (requestId) this.requestId = requestId;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export type ProviderRequestError = ProviderError;

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

const MINIMAX_RATE_LIMIT_CODES = new Set(["1002"]);
const MINIMAX_PLAN_CAPACITY_CODES = new Set(["2062"]);
const MINIMAX_QUOTA_CODES = new Set(["1008", "2056"]);
const MINIMAX_AUTH_CODES = new Set(["1004"]);

const QUOTA_PATTERNS = [
  /\binsufficient (?:account )?(?:balance|credits?|quota)\b/i,
  /\b(?:quota|usage) (?:has been )?(?:exhausted|exceeded)\b/i,
  /\b(?:quota|usage|token plan)[^\n]{0,48}\blimit (?:has been )?(?:exhausted|exceeded|reached)\b/i,
  /\b(?:quota|usage|token plan) exhausted\b/i,
  /\bhit (?:your|the) [^\n]{0,48}\busage limit\b/i,
];

const QUOTA_TAG_PATTERNS = [
  /(?:^|[_-])insufficient[_-]?(?:balance|credits?|quota)(?:$|[_-])/i,
  /(?:^|[_-])(?:quota|usage)[_-]?(?:exhausted|exceeded)(?:$|[_-])/i,
  /(?:^|[_-])usage[_-]?limit[_-]?reached(?:$|[_-])/i,
  /(?:^|[_-])usage[_-]?not[_-]?included(?:$|[_-])/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\btraffic is currently high\b/i,
  /\bretry shortly\b/i,
  /\boverloaded\b/i,
];

const RATE_LIMIT_TAG_PATTERNS = [
  /(?:^|[_-])rate[_-]?limit(?:ed|_error|_exceeded)?(?:$|[_-])/i,
  /(?:^|[_-])too[_-]?many[_-]?requests(?:$|[_-])/i,
];

export function classifyProviderError(input: ProviderErrorClassificationInput): ProviderErrorClassification {
  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
  const code = normalizeCode(input.code)?.trim().toLowerCase();
  const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  const message = typeof input.message === "string" ? input.message : "";
  const tags = `${type}_${code ?? ""}`;

  if (provider === "minimax" && code) {
    if (MINIMAX_PLAN_CAPACITY_CODES.has(code)) {
      return { category: "plan_capacity", retryable: false, opensCircuit: true };
    }
    if (MINIMAX_QUOTA_CODES.has(code)) {
      return { category: "quota_exhausted", retryable: false, opensCircuit: true };
    }
    if (MINIMAX_RATE_LIMIT_CODES.has(code)) {
      return { category: "rate_limit", retryable: true, opensCircuit: false };
    }
    if (MINIMAX_AUTH_CODES.has(code)) {
      return { category: "authentication", retryable: false, opensCircuit: false };
    }
  }

  if (
    QUOTA_PATTERNS.some((pattern) => pattern.test(message))
    || QUOTA_TAG_PATTERNS.some((pattern) => pattern.test(tags))
  ) {
    return { category: "quota_exhausted", retryable: false, opensCircuit: true };
  }
  if (
    RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))
    || RATE_LIMIT_TAG_PATTERNS.some((pattern) => pattern.test(tags))
  ) {
    return { category: "rate_limit", retryable: true, opensCircuit: false };
  }

  if (input.status === 429) {
    return { category: "rate_limit", retryable: true, opensCircuit: false };
  }
  if (input.status === 401 || input.status === 403) {
    return { category: "authentication", retryable: false, opensCircuit: false };
  }
  if (input.status === 408 || (input.status !== undefined && input.status >= 500 && input.status <= 599)) {
    return { category: "server_error", retryable: true, opensCircuit: false };
  }
  if (input.status !== undefined && input.status >= 400 && input.status <= 499) {
    return { category: "invalid_request", retryable: false, opensCircuit: false };
  }
  return { category: "unknown", retryable: false, opensCircuit: false };
}

export async function providerHttpError(
  response: Response,
  options: ProviderHttpErrorOptions,
): Promise<ProviderError> {
  const json = await readProviderErrorJson(response);
  const extracted = extractProviderErrorDetails(json);
  let selected: ProviderErrorDetails | undefined;
  try {
    selected = options.selectJson?.({ status: response.status, ...(json === undefined ? {} : { json }) });
  } catch {
    selected = undefined;
  }
  const details = mergeProviderErrorDetails(extracted, selected);
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? details?.retryAfterMs;
  const requestId = safeRequestId(details?.requestId) ?? responseRequestId(response);
  return createProviderError({
    provider: options.provider,
    label: options.label,
    status: response.status,
    ...(details ? { details } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function providerPayloadError(payload: unknown, options: ProviderPayloadErrorOptions): ProviderError {
  const details = mergeProviderErrorDetails(extractProviderErrorDetails(payload), options.details);
  const retryAfterMs = options.response
    ? parseRetryAfterMs(options.response.headers.get("retry-after")) ?? details?.retryAfterMs
    : details?.retryAfterMs;
  const requestId = safeRequestId(details?.requestId)
    ?? (options.response ? responseRequestId(options.response) : undefined);
  return createProviderError({
    provider: options.provider,
    label: options.label,
    ...(options.status !== undefined
      ? { status: options.status }
      : options.response
        ? { status: options.response.status }
        : {}),
    ...(details ? { details } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function extractProviderErrorDetails(value: unknown): ProviderErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const response = isRecord(value.response) ? value.response : undefined;
  const nested = isRecord(value.error)
    ? value.error
    : isRecord(response?.error)
      ? response.error
      : undefined;
  const stringError = stringValue(value.error) ?? stringValue(response?.error);
  const errorDescription = firstString(value.error_description);
  const message = firstString(nested?.message, value.message, errorDescription, stringError);
  const explicitCode = firstCode(
    nested?.code,
    nested?.error_code,
    nested?.status_code,
    value.code,
    value.error_code,
    value.status_code,
  );
  const stringErrorCode = stringError && MACHINE_TAG_PATTERN.test(stringError)
    ? stringError
    : undefined;
  const code = explicitCode ?? stringErrorCode;
  const type = firstString(nested?.type, value.type);
  const param = firstString(nested?.param, value.param);
  const requestId = firstString(
    nested?.request_id,
    nested?.requestId,
    value.request_id,
    value.requestId,
  );
  const retryAfterMs = firstRetryAfterMs(...(nested ? [nested, value] : [value]));
  if (!message && code === undefined && !type && !param && !requestId && retryAfterMs === undefined) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(type ? { type } : {}),
    ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function safePublicText(value: string | undefined): string | undefined {
  const normalized = typeof value === "string"
    ? redactSensitiveText(value)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    : undefined;
  if (!normalized || MARKUP_PATTERN.test(normalized)) return undefined;
  return truncateUtf8(normalized, PROVIDER_PUBLIC_ERROR_MAX_BYTES);
}

export function clampProviderRetryAfterMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(PROVIDER_RETRY_AFTER_MAX_MS, Math.round(value));
}

async function readProviderErrorJson(response: Response): Promise<unknown | undefined> {
  const body = await readResponseBodyBounded(response, PROVIDER_ERROR_BODY_MAX_BYTES);
  const trimmed = body.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function createProviderError(input: {
  provider: string;
  label: string;
  status?: number;
  details?: ProviderErrorDetails;
  requestId?: string;
  retryAfterMs?: number;
}): ProviderError {
  const details = input.details;
  const requestId = safeRequestId(details?.requestId) ?? safeRequestId(input.requestId);
  const publicMessage = details && Object.prototype.hasOwnProperty.call(details, "publicMessage")
    ? safePublicText(details.publicMessage)
    : undefined;
  let message = publicMessage ?? httpFailureMessage(input.label, input.status);
  if (!publicMessage && requestId && !message.includes(requestId)) {
    message = `${message} (request id: ${requestId})`;
  }
  message = safePublicText(message) ?? httpFailureMessage(input.label, input.status);
  const retryAfterMs = clampProviderRetryAfterMs(input.retryAfterMs ?? details?.retryAfterMs);
  const classification = classifyProviderError({
    provider: input.provider,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(details?.code !== undefined ? { code: details.code } : {}),
    ...(details?.type !== undefined ? { type: details.type } : {}),
    ...(typeof details?.message === "string"
      ? { message: details.message }
      : typeof details?.publicMessage === "string"
        ? { message: details.publicMessage }
        : {}),
  });
  return new ProviderError(message, {
    provider: input.provider,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(details?.code !== undefined ? { code: details.code } : {}),
    ...(details?.type !== undefined ? { type: details.type } : {}),
    ...(details?.param !== undefined ? { param: details.param } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    category: details?.category ?? classification.category,
    retryable: details?.retryable ?? classification.retryable,
    opensCircuit: details?.opensCircuit ?? classification.opensCircuit,
  });
}

function mergeProviderErrorDetails(
  base: ProviderErrorDetails | undefined,
  override: ProviderErrorDetails | undefined,
): ProviderErrorDetails | undefined {
  if (!base && !override) return undefined;
  const merged: ProviderErrorDetails = { ...base };
  if (!override) return merged;
  for (const key of Object.keys(override) as Array<keyof ProviderErrorDetails>) {
    const value = override[key];
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

function safeDetailText(value: string | undefined): string | undefined {
  const safe = safePublicText(value);
  if (!safe || safe.length > 160) return undefined;
  return safe;
}

function safeMachineTag(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !MACHINE_TAG_PATTERN.test(normalized)) return undefined;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(normalized)) return undefined;
  return redactSensitiveText(normalized) === normalized ? normalized : undefined;
}

function safeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !REQUEST_ID_PATTERN.test(normalized)) return undefined;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(normalized)) return undefined;
  return redactSensitiveText(normalized) === normalized ? normalized : undefined;
}

function responseRequestId(response: Response): string | undefined {
  return safeRequestId(
    response.headers.get("x-request-id")
      ?? response.headers.get("request-id")
      ?? response.headers.get("x-correlation-id")
      ?? undefined,
  );
}

function httpFailureMessage(label: string, status: number | undefined): string {
  const safeLabel = safePublicText(label) ?? "Provider request";
  if (status === undefined || (status >= 200 && status <= 299)) return safeLabel;
  const statusLabel = HTTP_STATUS_LABELS[status];
  return `${safeLabel} failed with HTTP ${status}${statusLabel ? ` ${statusLabel}` : ""}`;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = finiteNumber(value);
  if (seconds !== undefined && seconds >= 0) return clampProviderRetryAfterMs(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? clampProviderRetryAfterMs(Math.max(0, at - Date.now())) : undefined;
}

function firstRetryAfterMs(...records: Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const milliseconds = finiteNumber(record.retry_after_ms);
    if (milliseconds !== undefined && milliseconds >= 0) return clampProviderRetryAfterMs(milliseconds);
    const seconds = finiteNumber(record.retry_after);
    if (seconds !== undefined && seconds >= 0) return clampProviderRetryAfterMs(seconds * 1_000);
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const ellipsis = new TextEncoder().encode("…");
  const prefixBytes = encoded.subarray(0, Math.max(0, maxBytes - ellipsis.byteLength));
  const prefix = new TextDecoder().decode(prefixBytes, { stream: true }).trimEnd();
  return `${prefix}…`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "sk-[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g, "[REDACTED_JWT]")
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|session[_ -]?cookie|credentials?|password|passwd|authorization|token)\s*(?::|=|\bis\b)\s*)["']?[^\s,;'"<>]{3,}["']?/gi, "$1[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(IPV6_CANDIDATE_PATTERN, (candidate) => isIP(candidate) === 6 ? "[REDACTED_IP]" : candidate);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstCode(...values: unknown[]): string | number | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCode(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return typeof value === "string" ? value : undefined;
}

function isFiniteStatus(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
