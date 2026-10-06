const MAX_BYTES = 4 * 1024 * 1024;
export class StructuredToolDataLimitError extends Error {}

/** Copy plain JSON without executing getters or silently truncating program data. */
export function validateStructuredToolData(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 64) throw new StructuredToolDataLimitError("Structured tool data exceeds its structural limit");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > MAX_BYTES) throw new StructuredToolDataLimitError("Structured tool data exceeds 4 MiB");
      return item;
    }
    if (typeof item !== "object" || item === null) throw new Error("Structured tool data must be JSON");
    if (ancestors.has(item)) throw new Error("Structured tool data contains a cycle");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Structured tool data must contain plain JSON objects");
    }
    ancestors.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      if (item.length > 100_000) throw new StructuredToolDataLimitError("Structured tool data exceeds its structural limit");
      const array: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor || !("value" in descriptor)) throw new Error("Structured tool data cannot contain accessors or holes");
        array.push(copy(descriptor.value, depth + 1));
      }
      result = array;
    } else {
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw new Error("Structured tool data cannot contain accessors");
        bytes += Buffer.byteLength(key);
        if (bytes > MAX_BYTES) throw new StructuredToolDataLimitError("Structured tool data exceeds 4 MiB");
        record[key] = copy(descriptor.value, depth + 1);
      }
      result = record;
    }
    ancestors.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new StructuredToolDataLimitError("Structured tool data exceeds 4 MiB");
  return result;
}
