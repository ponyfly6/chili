const encoder = new TextEncoder();

export function serializedJsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return encoder.encode(serialized).byteLength;
}
