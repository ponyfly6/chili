export interface RetryPolicy {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  retryable?: (error: Error) => boolean;
}

export function normalizeRetryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  return {
    maxAttempts: policy?.maxAttempts ?? 2,
    initialDelayMs: policy?.initialDelayMs ?? 250,
    maxDelayMs: policy?.maxDelayMs ?? 2_000,
    factor: policy?.factor ?? 2,
    retryable: policy?.retryable ?? defaultRetryable,
  };
}

export function retryDelay(policy: Required<RetryPolicy>, attempt: number): number {
  const delay = policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.round(delay));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRetryable(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    message.includes("econnreset") ||
    message.includes("network")
  );
}
