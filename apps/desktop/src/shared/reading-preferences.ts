export interface ReadingPreferences {
  expandWork: boolean;
  /** Legacy storage/IPC field. The desktop now opens supplementary views only on user request. */
  autoOpenResults: boolean;
}
export const defaultReadingPreferences: ReadingPreferences = { expandWork: false, autoOpenResults: true };
export function parseReadingPreferences(value: unknown): ReadingPreferences {
  if (!value || typeof value !== "object") return { ...defaultReadingPreferences };
  const input = value as Record<string, unknown>;
  return {
    expandWork: typeof input.expandWork === "boolean" ? input.expandWork : false,
    autoOpenResults: typeof input.autoOpenResults === "boolean" ? input.autoOpenResults : true,
  };
}
