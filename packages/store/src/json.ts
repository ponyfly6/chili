export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value.length === 0) {
    return fallback;
  }
  return JSON.parse(value) as T;
}
