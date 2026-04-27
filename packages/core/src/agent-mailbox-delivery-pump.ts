import type { ChiliEvent } from "@chili/protocol";
import type { AgentMailboxQuery, AgentMailboxRow, EventPublisher } from "@chili/store";
import type { AgentTreeControlService, ConsumeAgentMailboxInput } from "./agent-tree.js";

export interface AgentMailboxDeliveryPumpOptions {
  agents: AgentMailboxDeliveryController;
  events?: EventPublisher;
  includeExisting?: boolean;
  maxInitialDrain?: number;
  onError?: (error: unknown, messageId?: string) => void | Promise<void>;
}

export interface AgentMailboxDeliveryController {
  mailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]>;
  consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow>;
}

export class AgentMailboxDeliveryPump {
  private readonly queue = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private startup: Promise<void> | undefined;
  private draining = false;
  private running = false;
  private closed = false;

  constructor(private readonly options: AgentMailboxDeliveryPumpOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.closed = false;
    this.unsubscribe = this.options.events?.subscribe((event) => {
      if (isTriggerTurnMailboxEvent(event)) this.enqueue(event.id);
    });
    if (this.options.includeExisting ?? true) {
      this.startup = this.enqueueExisting();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue.clear();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.startup?.catch(() => undefined);
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private async enqueueExisting(): Promise<void> {
    try {
      const messages = await this.options.agents.mailbox({
        status: "queued",
        limit: this.options.maxInitialDrain ?? 1000,
      });
      for (const message of messages) {
        if (message.triggerTurn) this.enqueue(message.id);
      }
    } catch (error) {
      await this.reportError(error);
    }
  }

  private enqueue(messageId: string): void {
    if (this.closed) return;
    this.queue.add(messageId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.size > 0) {
        const messageId = firstItem(this.queue);
        if (!messageId) break;
        this.queue.delete(messageId);
        try {
          await this.options.agents.consumeMailbox({ messageId });
        } catch (error) {
          await this.reportError(error, messageId);
        }
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.queue.size > 0) {
        void this.drain();
      } else {
        this.resolveIdle();
      }
    }
  }

  private async reportError(error: unknown, messageId?: string): Promise<void> {
    try {
      await this.options.onError?.(error, messageId);
    } catch {
      // The pump should not crash the runtime because a diagnostics hook failed.
    }
  }

  private isIdle(): boolean {
    return !this.draining && this.queue.size === 0;
  }

  private resolveIdle(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

export function createAgentMailboxDeliveryPump(
  agents: AgentTreeControlService,
  options: Omit<AgentMailboxDeliveryPumpOptions, "agents"> = {},
): AgentMailboxDeliveryPump {
  return new AgentMailboxDeliveryPump({ ...options, agents });
}

function isTriggerTurnMailboxEvent(event: ChiliEvent): boolean {
  return event.type === "agent.message_queued" && event.payload.triggerTurn;
}

function firstItem<T>(set: Set<T>): T | undefined {
  for (const item of set) return item;
  return undefined;
}
