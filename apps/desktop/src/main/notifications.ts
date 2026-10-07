import type { ChiliEvent } from "@chili/protocol";
import type { SidecarPhase } from "../shared/contracts.js";

export interface DesktopNotificationContent {
  title: string;
  body: string;
}

const MAX_SEEN_NOTIFICATION_EVENT_IDS = 4_096;

/**
 * Suppresses historical SSE replay across sidecar generations and duplicate
 * notification-worthy events within one desktop lifetime.
 */
export class DesktopNotificationGate {
  private activeGeneration: number | undefined;
  private notBefore = Number.POSITIVE_INFINITY;
  private readonly seenEventIds = new Set<string>();

  observeSidecarState(
    phase: SidecarPhase,
    generation: number,
    now = Date.now(),
  ): void {
    if (phase !== "healthy") {
      if (this.activeGeneration === generation) this.activeGeneration = undefined;
      return;
    }
    if (this.activeGeneration === generation) return;
    this.activeGeneration = generation;
    this.notBefore = now;
  }

  notificationForEvent(event: ChiliEvent, generation: number): DesktopNotificationContent | undefined {
    if (
      generation !== this.activeGeneration
      || !Number.isFinite(event.time)
      || event.time < this.notBefore
      || this.seenEventIds.has(event.id)
    ) return undefined;
    const content = desktopNotificationForEvent(event);
    if (!content) return undefined;
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > MAX_SEEN_NOTIFICATION_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
    return content;
  }
}

/** Keep untrusted runtime content out of the OS notification surface. */
export function desktopNotificationForEvent(event: ChiliEvent): DesktopNotificationContent | undefined {
  if (event.type === "user_input.requested") {
    return { title: "Chili needs your input", body: "A task is waiting for your answer." };
  }
  if (event.type === "turn.completed") {
    return event.payload.status === "completed"
      ? { title: "Chili finished a turn", body: "The current turn completed." }
      : { title: "Chili turn stopped", body: "The current turn stopped." };
  }
  return undefined;
}
