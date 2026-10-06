/** Program data is rejected at this boundary, never silently truncated. */
export const MAX_STRUCTURED_TOOL_RESULT_BYTES = 4 * 1024 * 1024;

export function validateStructuredToolData(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  let textBytes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 64) throw new Error("Tool structured data exceeds its structural limit.");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      textBytes += Buffer.byteLength(item, "utf8");
      if (textBytes > MAX_STRUCTURED_TOOL_RESULT_BYTES) throw new Error("Tool structured data exceeds 4 MiB.");
      return item;
    }
    if (typeof item !== "object" || item === null) throw new Error("Tool structured data must be valid JSON.");
    if (ancestors.has(item)) throw new Error("Tool structured data contains a cycle.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Tool structured data must contain plain JSON objects.");
    }
    ancestors.add(item);
    let copy: unknown;
    if (Array.isArray(item)) {
      if (item.length > 100_000) throw new Error("Tool structured data exceeds its structural limit.");
      const array: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !("value" in descriptor)) throw new Error("Tool structured data arrays must contain plain JSON values.");
        array.push(visit(descriptor.value, depth + 1));
      }
      copy = array;
    } else {
      const entries = Object.getOwnPropertyDescriptors(item);
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(entries)) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw new Error("Tool structured data cannot contain accessors.");
        textBytes += Buffer.byteLength(key, "utf8");
        if (textBytes > MAX_STRUCTURED_TOOL_RESULT_BYTES) throw new Error("Tool structured data exceeds 4 MiB.");
        record[key] = visit(descriptor.value, depth + 1);
      }
      copy = record;
    }
    ancestors.delete(item);
    return copy;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_STRUCTURED_TOOL_RESULT_BYTES) {
    throw new Error("Tool structured data exceeds 4 MiB.");
  }
  return result;
}
