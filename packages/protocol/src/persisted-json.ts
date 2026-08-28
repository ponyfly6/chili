export const PERSISTED_JSON_LIMITS = {
  eventValueBytes: 512_000,
  stringBytes: 128_000,
  items: 128,
  depth: 12,
  nodes: 2_048,
} as const;

export interface PersistedJsonBoundOptions {
  maxBytes: number;
  maxStringBytes?: number;
  maxItems?: number;
  maxDepth?: number;
  maxNodes?: number;
  label?: string;
}

/** Detaches an untrusted value into a JSON-safe tree with an exact serialized byte cap. */
export function boundPersistedJsonValue(value: unknown, options: PersistedJsonBoundOptions): unknown {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("persisted JSON maxBytes must be a positive safe integer");
  }
  if (options.maxBytes === 1) return 0;
  const limits = {
    maxBytes: options.maxBytes,
    maxStringBytes: Math.max(2, finiteLimit(options.maxStringBytes, 128_000)),
    maxItems: finiteLimit(options.maxItems, 128),
    maxDepth: finiteLimit(options.maxDepth, 12),
    maxNodes: finiteLimit(options.maxNodes, 2_048),
    label: options.label ?? "persisted value",
  };
  const bounded = visit(value, { nodes: 0, seen: new WeakSet<object>() }, 0, limits.maxBytes, limits);
  if (jsonBytes(bounded) <= limits.maxBytes) return bounded;
  return fitString(safeString(value), limits.maxBytes, limits.label);
}

function visit(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth: number,
  budget: number,
  limits: Required<PersistedJsonBoundOptions>,
): unknown {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) return fitString(`[omitted: ${limits.label} node limit exceeded]`, budget);
  if (typeof value === "string") {
    return fitString(value, Math.min(budget, limits.maxStringBytes + 2), `${limits.label} string`);
  }
  if (value === null || typeof value === "boolean") return fitPrimitive(value, budget, limits.label);
  if (typeof value === "number") {
    return fitPrimitive(Number.isFinite(value) ? value : null, budget, limits.label);
  }
  if (typeof value !== "object") return fitString(safeString(value), budget, limits.label);
  if (depth >= limits.maxDepth) return fitString(`[omitted: ${limits.label} depth limit exceeded]`, budget);
  if (state.seen.has(value)) return fitString(`[omitted: circular ${limits.label}]`, budget);
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let bytes = 2;
    const length = safeArrayLength(value);
    for (let index = 0; index < Math.min(length, limits.maxItems); index += 1) {
      const separatorBytes = result.length === 0 ? 0 : 1;
      const childBudget = budget - bytes - separatorBytes;
      if (childBudget < 2) break;
      const child = visit(safeGet(value, String(index)), state, depth + 1, childBudget, limits);
      const childBytes = jsonBytes(child);
      if (childBytes > childBudget) break;
      result.push(child);
      bytes += separatorBytes + childBytes;
    }
    if (length > result.length) appendArrayMarker(result, `[${length - result.length} ${limits.label} items omitted]`, budget);
    return result;
  }

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let bytes = 2;
  let entries = 0;
  let omitted = false;
  try {
    for (const rawKey in value) {
      if (!safeHasOwn(value, rawKey)) continue;
      if (entries >= limits.maxItems) {
        omitted = true;
        break;
      }
      entries += 1;
      const key = truncateUtf8(rawKey, 512);
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const prefixBytes = separatorBytes + jsonBytes(key) + 1;
      const childBudget = budget - bytes - prefixBytes;
      if (childBudget < 2) {
        omitted = true;
        break;
      }
      const child = visit(safeGet(value, rawKey), state, depth + 1, childBudget, limits);
      const childBytes = jsonBytes(child);
      if (childBytes > childBudget) {
        omitted = true;
        break;
      }
      result[key] = child;
      bytes += prefixBytes + childBytes;
    }
  } catch {
    omitted = true;
  }
  if (omitted) appendRecordMarker(result, `additional ${limits.label} keys omitted`, budget);
  return result;
}

function fitPrimitive(value: null | boolean | number, budget: number, label: string): unknown {
  if (jsonBytes(value) <= budget) return value;
  return fitString(safeString(value), budget, label);
}

function fitString(value: string, budget: number, label?: string): string {
  if (budget < 2) return "";
  if (jsonBytes(value) <= budget) return value;
  const marker = label ? `\n[${label} truncated from ${utf8Bytes(value)} bytes]` : "";
  const boundedMarker = jsonBytes(marker) <= budget ? marker : stringPrefix(marker, budget);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(`${safeUtf16Prefix(value, middle)}${boundedMarker}`) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${safeUtf16Prefix(value, low)}${boundedMarker}`;
}

function stringPrefix(value: string, budget: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(safeUtf16Prefix(value, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return safeUtf16Prefix(value, low);
}

function appendArrayMarker(result: unknown[], marker: string, budget: number): void {
  const available = budget - jsonBytes(result) - (result.length === 0 ? 0 : 1);
  if (available < 2) return;
  const bounded = fitString(marker, available);
  if (jsonBytes(bounded) <= available) result.push(bounded);
}

function appendRecordMarker(result: Record<string, unknown>, marker: string, budget: number): void {
  const key = Object.prototype.hasOwnProperty.call(result, "__omitted__") ? "__chili_omitted__" : "__omitted__";
  const available = budget - jsonBytes(result) - (Object.keys(result).length === 0 ? 0 : 1) - jsonBytes(key) - 1;
  if (available < 2) return;
  const bounded = fitString(marker, available);
  if (jsonBytes(bounded) <= available) result[key] = bounded;
}

function safeGet(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return `[omitted: ${key} getter threw]`;
  }
}

function safeHasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function safeArrayLength(value: unknown[]): number {
  try {
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[omitted: value could not be converted to text]";
  }
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(serialized);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(safeUtf16Prefix(value, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return safeUtf16Prefix(value, low);
}

function safeUtf16Prefix(value: string, end: number): string {
  let safeEnd = end;
  if (safeEnd > 0) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function finiteLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
