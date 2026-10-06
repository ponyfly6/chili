import type { ChiliEvent } from "@chili/protocol";

/** Execution ownership paths belong to the runtime, not the renderer transcript. */
export function projectRendererRuntimeEvent(event: ChiliEvent): ChiliEvent | undefined {
  if (event.type === "session.identity_bound") return undefined;
  if (event.type !== "session.created" || event.payload.identity === undefined) return event;
  const { identity: _, ...payload } = event.payload;
  return { ...event, payload };
}
