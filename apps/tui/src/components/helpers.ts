export function shorten(value: unknown, max = 80): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}~`;
}
