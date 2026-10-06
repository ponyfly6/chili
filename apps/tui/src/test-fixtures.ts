import type { RuntimeConnectionState } from "./useRuntimeEvents.js";

export interface RuntimeFixture { connection: RuntimeConnectionState }

export function runtimeFixture(status: RuntimeConnectionState["status"] = "streaming"): RuntimeFixture {
  return { connection: { status } };
}
