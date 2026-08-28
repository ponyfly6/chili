import { expect, test } from "bun:test";
import { boundPersistedJsonValue } from "./persisted-json.js";

const encoder = new TextEncoder();

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("expected a JSON value");
  return encoder.encode(serialized).byteLength;
}

test("enforces the exact byte cap at a two-byte record boundary", () => {
  const source = { value: "x".repeat(262_134) };
  expect(serializedBytes(source)).toBe(262_146);

  const options = {
    maxBytes: 262_144,
    maxStringBytes: 262_144,
    maxItems: 8,
    maxDepth: 4,
    maxNodes: 16,
    label: "boundary record",
  } as const;
  const first = boundPersistedJsonValue(source, options) as { value: string };
  const second = boundPersistedJsonValue(source, options);

  expect(serializedBytes(first)).toBe(262_144);
  expect(first.value.startsWith("x".repeat(1_024))).toBe(true);
  expect(first.value).toEndWith("[boundary record string truncated from 262134 bytes]");
  expect(second).toEqual(first);
});

test("bounds worst-escaped strings while retaining a deterministic useful prefix", () => {
  const unit = "\u0000\"\\\n";
  const source = unit.repeat(2 * 1024 * 1024);
  const options = {
    maxBytes: 16 * 1024,
    maxStringBytes: (16 * 1024) - 2,
    label: "escaped diagnostic",
  } as const;
  const first = boundPersistedJsonValue(source, options);
  const second = boundPersistedJsonValue(source, options);

  expect(typeof first).toBe("string");
  expect(serializedBytes(first)).toBeLessThanOrEqual(options.maxBytes);
  expect(first as string).toStartWith(unit.repeat(16));
  expect(first as string).toContain("[escaped diagnostic string truncated from");
  expect(second).toBe(first);
});

test("bounds arrays by aggregate bytes and item count with a stable omission marker", () => {
  const source = Array.from(
    { length: 300 },
    (_, index) => `item-${index}:${"\u0000\"\\".repeat(2_048)}`,
  );
  const options = {
    maxBytes: 32 * 1024,
    maxStringBytes: 1_024,
    maxItems: 12,
    maxDepth: 4,
    maxNodes: 64,
    label: "boundary array",
  } as const;
  const first = boundPersistedJsonValue(source, options);
  const second = boundPersistedJsonValue(source, options);

  expect(Array.isArray(first)).toBe(true);
  expect(serializedBytes(first)).toBeLessThanOrEqual(options.maxBytes);
  expect(typeof (first as unknown[])[0]).toBe("string");
  expect((first as string[])[0]).toStartWith("item-0:");
  expect((first as string[]).some((item) => item.includes("boundary array items omitted"))).toBe(true);
  expect(second).toEqual(first);
});

test("never returns a primitive or container larger than a small requested budget", () => {
  const recordWithPrototypeKey = Object.create(null) as Record<string, unknown>;
  recordWithPrototypeKey.__proto__ = "prototype value";
  recordWithPrototypeKey.value = "\u0000\"\\".repeat(128);
  const values: unknown[] = [
    null,
    true,
    false,
    0,
    -1,
    1e308,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "\u0000\"\\".repeat(128),
    recordWithPrototypeKey,
    [true, false, null, "\u0000\"\\".repeat(128)],
  ];

  for (let maxBytes = 1; maxBytes <= 64; maxBytes += 1) {
    for (const value of values) {
      const bounded = boundPersistedJsonValue(value, {
        maxBytes,
        maxStringBytes: 64,
        maxItems: 8,
        maxDepth: 4,
        maxNodes: 32,
        label: "small boundary",
      });
      expect(serializedBytes(bounded)).toBeLessThanOrEqual(maxBytes);
    }
  }

  expect(() => boundPersistedJsonValue("value", { maxBytes: 0 })).toThrow(RangeError);
});
