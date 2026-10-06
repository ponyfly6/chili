import type { RuntimeStateSnapshot } from "@chili/protocol";
import { markRuntimeOutputGap, reduceRuntimeEvents, type ChiliRuntimeView } from "./projection.js";

/** Snapshot seed event IDs are projection identities, never resumable cursors. */
export function restoreRuntimeSnapshot(snapshot: RuntimeStateSnapshot): ChiliRuntimeView {
  const view = reduceRuntimeEvents(snapshot.events);
  if (snapshot.afterEventId === undefined) delete view.lastEventId;
  else view.lastEventId = snapshot.afterEventId;
  // Running tool output is ephemeral: a snapshot restores durable state only.
  markRuntimeOutputGap(view);
  return view;
}
