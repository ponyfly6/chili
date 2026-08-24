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

export interface ProviderErrorOptions extends ProviderErrorClassificationInput {
  category?: ProviderErrorCategory;
  retryable?: boolean;
  opensCircuit?: boolean;
  retryAfterMs?: number;
  details?: unknown;
  cause?: unknown;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly provider: string;
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  readonly opensCircuit: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    const classification = classifyProviderError({
      provider: options.provider,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.code !== undefined ? { code: options.code } : {}),
      ...(options.type !== undefined ? { type: options.type } : {}),
      message,
    });
    this.provider = options.provider;
    this.category = options.category ?? classification.category;
    this.retryable = options.retryable ?? classification.retryable;
    this.opensCircuit = options.opensCircuit ?? classification.opensCircuit;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = String(options.code);
    if (options.type !== undefined) this.type = options.type;
    if (isFiniteNonNegative(options.retryAfterMs)) this.retryAfterMs = options.retryAfterMs;
    if (options.details !== undefined) this.details = options.details;
  }
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
];

const QUOTA_TAG_PATTERNS = [
  /(?:^|[_-])insufficient[_-]?(?:balance|credits?|quota)(?:$|[_-])/i,
  /(?:^|[_-])(?:quota|usage)[_-]?(?:exhausted|exceeded)(?:$|[_-])/i,
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
  const provider = input.provider.trim().toLowerCase();
  const code = input.code === undefined ? undefined : String(input.code).trim().toLowerCase();
  const type = input.type?.trim().toLowerCase() ?? "";
  const message = input.message ?? "";
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

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
