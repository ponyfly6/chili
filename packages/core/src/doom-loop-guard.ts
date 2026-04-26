export interface DoomLoopGuardOptions {
  maxRepeatedToolCalls?: number;
  maxToolCallsPerTurn?: number;
}

export interface DoomLoopCheckInput {
  toolName: string;
  input: unknown;
}

export type DoomLoopCheckResult =
  | { ok: true; count: number; total: number }
  | { ok: false; reason: "repeated_tool_call" | "tool_call_limit"; count: number; total: number };

export class DoomLoopGuard {
  private readonly seen = new Map<string, number>();
  private total = 0;
  private readonly maxRepeatedToolCalls: number;
  private readonly maxToolCallsPerTurn: number;

  constructor(options: DoomLoopGuardOptions = {}) {
    this.maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? 3;
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 30;
  }

  check(input: DoomLoopCheckInput): DoomLoopCheckResult {
    this.total++;
    if (this.total > this.maxToolCallsPerTurn) {
      return { ok: false, reason: "tool_call_limit", count: this.total, total: this.total };
    }

    const signature = stableStringify([input.toolName, input.input]);
    const count = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, count);
    if (count > this.maxRepeatedToolCalls) {
      return { ok: false, reason: "repeated_tool_call", count, total: this.total };
    }

    return { ok: true, count, total: this.total };
  }
}

export class DoomLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoomLoopError";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
