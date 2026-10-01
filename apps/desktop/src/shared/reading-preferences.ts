export interface ReadingPreferences { autoResult: boolean; expandWork: boolean }
export const defaultReadingPreferences: ReadingPreferences = { autoResult: true, expandWork: false };
export function parseReadingPreferences(value: unknown): ReadingPreferences {
  if (!value || typeof value !== "object") return { ...defaultReadingPreferences };
  const input = value as Record<string, unknown>;
  return {
    autoResult: typeof input.autoResult === "boolean" ? input.autoResult : true,
    expandWork: typeof input.expandWork === "boolean" ? input.expandWork : false,
  };
}
