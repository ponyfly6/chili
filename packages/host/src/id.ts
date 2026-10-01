export function createIdFactory(): (prefix: string) => string {
  return (prefix) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
