export interface DesktopBuildInfo {
  channel: "development" | "preview";
  revision: string;
  label: string;
}

declare const __CHILI_DESKTOP_BUILD_INFO__: unknown;

/** Bundled by Vite; safe to import directly in Bun tests and source tooling. */
export function getDesktopBuildInfo(): DesktopBuildInfo {
  const value = typeof __CHILI_DESKTOP_BUILD_INFO__ === "undefined" ? undefined : __CHILI_DESKTOP_BUILD_INFO__;
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    if ((input.channel === "development" || input.channel === "preview")
      && typeof input.revision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.revision)) {
      return {
        channel: input.channel,
        revision: input.revision,
        label: `${input.channel === "preview" ? "Preview" : "Development"} · ${input.revision.slice(0, 12)}`,
      };
    }
  }
  return { channel: "development", revision: "unknown", label: "Development" };
}
