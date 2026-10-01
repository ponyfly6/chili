export interface ReadingPreferences { expandWork: boolean }
export const defaultReadingPreferences: ReadingPreferences = { expandWork: false };
export function parseReadingPreferences(value: unknown): ReadingPreferences {
  if (!value || typeof value !== "object") return { ...defaultReadingPreferences };
  const input = value as Record<string, unknown>;
  return {
    expandWork: typeof input.expandWork === "boolean" ? input.expandWork : false,
  };
}
