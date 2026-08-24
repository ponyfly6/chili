import { ROOT_AGENT_PATH, type ChiliEvent, type SessionId, type TaskId, type ToolCallId } from "@chili/protocol";
import type { AgentMailboxQuery, AgentMailboxRow, EventPublisher } from "@chili/store";
import type { AgentTreeControlService, ConsumeAgentMailboxInput } from "./agent-tree.js";
import { normalizeRetryPolicy, retryDelay, type RetryPolicy } from "./retry.js";

const ALL_AGENT_MAILBOX_MESSAGES = 2_147_483_647;

export interface AgentMailboxDeliveryPumpOptions {
  agents: AgentMailboxDeliveryController;
  events?: EventPublisher;
  includeExisting?: boolean;
  maxInitialDrain?: number;
  retryPolicy?: RetryPolicy;
  onError?: (error: unknown, messageId?: string) => void | Promise<void>;
}

export interface AgentMailboxDeliveryController {
  mailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]>;
  consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow>;
  canDeliverMailbox?(messageId: string): Promise<boolean>;
  mailboxDeliveryRetryAfterMs?(messageId: string): Promise<number | undefined>;
  recoverMailboxDelivery?(input: { messageId: string; error?: string }): Promise<AgentMailboxRow>;
  notifyTaskCompletion?(
    event: Extract<ChiliEvent, { type: "agent.task_completed" }>,
  ): Promise<AgentMailboxRow | undefined>;
  notifyTaskCompletionsForSourceCall?(sourceCallId: ToolCallId): Promise<AgentMailboxRow[]>;
  notifyExistingTaskCompletions?(limit?: number): Promise<AgentMailboxRow[]>;
  mailboxReadyAfterTaskCompletion?(taskId: TaskId): Promise<AgentMailboxRow[]>;
}

export class AgentMailboxDeliveryPump {
  private readonly queue = new Map<string, QueuedMailboxDelivery>();
  private readonly deliveryOrder = new Map<string, number>();
  private readonly activeRecipients = new Set<string>();
  private readonly activeDeliveries = new Map<string, ActiveMailboxDelivery>();
  private readonly waiters = new Set<() => void>();
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryNotBefore = new Map<string, number>();
  // A process-local circuit break. Restarting the pump is an explicit recovery
  // boundary and gives queued messages a fresh retry budget.
  private readonly parkedMessages = new Set<string>();
  private readonly retryTimerByMessage = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | undefined;
  private startup: Promise<void> | undefined;
  private scheduling = false;
  private running = false;
  private closed = false;
  private pendingWork = 0;
  private nextDeliveryOrder = 0;
  private scheduleAgain = false;
  private delegationResumeGeneration = 0;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly options: AgentMailboxDeliveryPumpOptions) {
    this.retryPolicy = normalizeRetryPolicy({
      maxAttempts: options.retryPolicy?.maxAttempts ?? 3,
      initialDelayMs: options.retryPolicy?.initialDelayMs ?? 250,
      maxDelayMs: options.retryPolicy?.maxDelayMs ?? 30_000,
      factor: options.retryPolicy?.factor ?? 2,
      retryable: options.retryPolicy?.retryable ?? isMailboxTurnRetryable,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.closed = false;
    this.unsubscribe = this.options.events?.subscribe((event) => {
      if (isTriggerTurnMailboxEvent(event)) {
        this.enqueue(event.id, mailboxRecipientKey(event.payload));
        return;
      }
      if (event.type === "agent.message_requeued") {
        this.enqueue(event.payload.messageId);
        return;
      }
      if (event.type === "agent.message_consumed" || event.type === "agent.message_discarded") {
        this.forgetMessage(event.payload.messageId);
        return;
      }
      if (event.type === "agent.task_completed") {
        this.trackWork(() => this.notifyTaskCompletion(event), event.id);
        return;
      }
      if (event.type === "tool.call_finished") {
        this.trackWork(() => this.notifyTaskCompletionsForSourceCall(event.payload.callId), event.id);
        return;
      }
      if (isAvailableSessionEvent(event)) {
        this.scheduleIdleRetry(event.payload.sessionId);
        return;
      }
      if (event.type === "session.delegation_changed" && event.payload.policy !== "off") {
        this.delegationResumeGeneration += 1;
        this.trackWork(() => this.enqueueExisting(), event.id);
      }
    });
    if (this.options.includeExisting ?? true) {
      this.startup = this.recoverExisting();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryTimerByMessage.clear();
    this.retryAttempts.clear();
    this.retryNotBefore.clear();
    this.parkedMessages.clear();
    this.deliveryOrder.clear();
    this.nextDeliveryOrder = 0;
    this.scheduleAgain = false;
    this.queue.clear();
    for (const active of this.activeDeliveries.values()) {
      active.controller.abort(abortError("Mailbox delivery pump stopped"));
    }
    await Promise.allSettled([...this.activeDeliveries.values()].map((active) => active.promise));
    this.resolveIdleIfReady();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.startup?.catch(() => undefined);
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private async recoverExisting(): Promise<void> {
    await this.recoverInterruptedDeliveries();
    try {
      const messages = await this.options.agents.notifyExistingTaskCompletions?.(
        this.options.maxInitialDrain ?? 1000,
      );
      for (const message of messages ?? []) {
        if (message.triggerTurn && message.status === "queued") this.enqueueMessage(message);
      }
    } catch (error) {
      this.reportError(error);
    }
    await this.enqueueExisting();
  }

  private async recoverInterruptedDeliveries(): Promise<void> {
    if (!this.options.agents.recoverMailboxDelivery) return;
    try {
      const delivering = await this.options.agents.mailbox({
        status: "delivering",
        limit: ALL_AGENT_MAILBOX_MESSAGES,
      });
      const recovered: AgentMailboxRow[] = [];
      for (const message of delivering) {
        const row = await this.options.agents.recoverMailboxDelivery({
          messageId: message.id,
          error: "mailbox_delivery_recovered_after_restart",
        });
        if (row.triggerTurn && row.status === "queued") recovered.push(row);
      }
      for (const message of recovered) this.enqueueMessage(message);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async enqueueExisting(sessionId?: SessionId): Promise<void> {
    try {
      const messages = await this.options.agents.mailbox({
        status: "queued",
        triggerTurn: true,
        ...(sessionId ? { recipientSessionId: sessionId } : {}),
        limit: ALL_AGENT_MAILBOX_MESSAGES,
      });
      for (const message of messages) {
        if (!message.triggerTurn) continue;
        this.enqueueMessage(message);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private enqueueMessage(message: AgentMailboxRow): void {
    this.enqueue(message.id, mailboxRecipientKey(message), message);
  }

  private enqueue(messageId: string, recipientKey?: string, message?: AgentMailboxRow): void {
    if (this.closed || this.activeDeliveries.has(messageId) || this.parkedMessages.has(messageId)) return;
    let sequence = this.deliveryOrder.get(messageId);
    if (sequence === undefined) {
      sequence = this.nextDeliveryOrder++;
      this.deliveryOrder.set(messageId, sequence);
    }
    const current = this.queue.get(messageId);
    const queued: QueuedMailboxDelivery = {
      messageId,
      sequence,
    };
    const resolvedRecipientKey = recipientKey ?? current?.recipientKey;
    if (resolvedRecipientKey) queued.recipientKey = resolvedRecipientKey;
    const resolvedMessage = message ?? current?.message;
    if (resolvedMessage) queued.message = resolvedMessage;
    this.queue.set(messageId, queued);
    if (this.scheduling) this.scheduleAgain = true;
    void this.schedule();
  }

  private async schedule(): Promise<void> {
    if (this.scheduling || this.closed) return;
    this.scheduling = true;
    try {
      const entries = await this.resolveQueuedDeliveries();
      const laneHeads = new Map<string, QueuedMailboxDelivery>();
      for (const entry of entries) {
        const recipientKey = entry.recipientKey;
        if (!recipientKey || laneHeads.has(recipientKey)) continue;
        laneHeads.set(recipientKey, entry);
      }
      for (const [recipientKey, entry] of laneHeads) {
        if (this.closed || this.activeRecipients.has(recipientKey)) continue;
        const notBefore = this.retryNotBefore.get(entry.messageId);
        if (notBefore !== undefined && Date.now() < notBefore) continue;
        try {
          const durableHead = await this.durableRecipientHead(entry, recipientKey);
          if (
            !durableHead ||
            durableHead.id !== entry.messageId ||
            this.parkedMessages.has(durableHead.id)
          ) {
            this.deferRecipient(recipientKey);
            if (durableHead && !this.parkedMessages.has(durableHead.id)) {
              this.enqueueMessage(durableHead);
            }
            continue;
          }
          if (this.options.agents.canDeliverMailbox) {
            const deliverable = await this.options.agents.canDeliverMailbox(entry.messageId);
            if (!deliverable) {
              this.deferRecipient(recipientKey);
              const retryAfterMs = await this.options.agents.mailboxDeliveryRetryAfterMs?.(entry.messageId);
              if (retryAfterMs !== undefined) this.scheduleAvailabilityRetry(entry, retryAfterMs);
              continue;
            }
          }
        } catch (error) {
          this.deferRecipient(recipientKey);
          if (!isMailboxDelegationPausedError(error)) this.reportError(error, entry.messageId);
          continue;
        }
        if (this.closed) break;
        this.queue.delete(entry.messageId);
        this.startDelivery(entry, recipientKey);
      }
    } finally {
      this.scheduling = false;
      if (this.scheduleAgain && !this.closed) {
        this.scheduleAgain = false;
        void this.schedule();
      }
      this.resolveIdleIfReady();
    }
  }

  private async resolveQueuedDeliveries(): Promise<QueuedMailboxDelivery[]> {
    const entries = [...this.queue.values()].sort((left, right) => left.sequence - right.sequence);
    const resolved: QueuedMailboxDelivery[] = [];
    for (const entry of entries) {
      if (!this.queue.has(entry.messageId)) continue;
      let message = entry.message;
      if (!message || !entry.recipientKey) {
        message = (await this.options.agents.mailbox({ messageId: entry.messageId, limit: 1 }))[0];
      }
      if (!message || message.status !== "queued" || !message.triggerTurn) {
        this.queue.delete(entry.messageId);
        if (message?.status === "consumed" || message?.status === "discarded") {
          this.forgetMessage(entry.messageId);
        }
        continue;
      }
      entry.message = message;
      entry.recipientKey = entry.recipientKey ?? mailboxRecipientKey(message);
      resolved.push(entry);
    }
    return resolved;
  }

  private async durableRecipientHead(
    entry: QueuedMailboxDelivery,
    recipientKey: string,
  ): Promise<AgentMailboxRow | undefined> {
    const message = entry.message;
    if (!message) return undefined;
    const candidates = await this.options.agents.mailbox({
      status: "queued",
      triggerTurn: true,
      ...(message.recipientSessionId
        ? { recipientSessionId: message.recipientSessionId }
        : { path: message.path }),
      limit: ALL_AGENT_MAILBOX_MESSAGES,
    });
    return candidates.find(
      (candidate) => candidate.triggerTurn && mailboxRecipientKey(candidate) === recipientKey,
    );
  }

  private startDelivery(entry: QueuedMailboxDelivery, recipientKey: string): void {
    const controller = new AbortController();
    const delegationGeneration = this.delegationResumeGeneration;
    this.activeRecipients.add(recipientKey);
    const promise = this.runDelivery(entry, recipientKey, controller);
    this.activeDeliveries.set(entry.messageId, {
      messageId: entry.messageId,
      recipientKey,
      controller,
      promise,
    });
    void promise.finally(() => {
      this.activeDeliveries.delete(entry.messageId);
      this.activeRecipients.delete(recipientKey);
      if (!this.closed && delegationGeneration !== this.delegationResumeGeneration) {
        this.trackWork(() => this.enqueueExisting());
      }
      if (!this.closed) void this.schedule();
      this.resolveIdleIfReady();
    });
  }

  private async runDelivery(
    entry: QueuedMailboxDelivery,
    recipientKey: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const consumed = await this.options.agents.consumeMailbox({
        messageId: entry.messageId,
        signal: controller.signal,
      });
      if (consumed.status === "consumed" || consumed.status === "discarded") {
        this.forgetMessage(entry.messageId);
      }
    } catch (error) {
      this.deferRecipient(recipientKey);
      if (this.closed && isAbortError(error)) return;
      if (isMailboxTurnRetryError(error)) {
        this.scheduleTurnRetry(entry, error);
      }
      if (!isMailboxDelegationPausedError(error) && !isAbortError(error)) {
        this.reportError(error, entry.messageId);
      }
    }
  }

  private scheduleTurnRetry(entry: QueuedMailboxDelivery, error: unknown): void {
    if (this.closed) return;
    const attempt = (this.retryAttempts.get(entry.messageId) ?? 0) + 1;
    this.retryAttempts.set(entry.messageId, attempt);
    const retryError = error instanceof Error ? error : new Error(String(error));
    if (!this.retryPolicy.retryable(retryError) || attempt >= this.retryPolicy.maxAttempts) {
      this.parkedMessages.add(entry.messageId);
      return;
    }
    const delayMs = retryDelay(this.retryPolicy, attempt, error);
    this.retryNotBefore.set(entry.messageId, Date.now() + delayMs);
    const previous = this.retryTimerByMessage.get(entry.messageId);
    if (previous) {
      clearTimeout(previous);
      this.retryTimers.delete(previous);
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.retryTimerByMessage.delete(entry.messageId);
      this.retryNotBefore.delete(entry.messageId);
      if (this.closed) return;
      const message = entry.message;
      this.trackWork(() => this.enqueueExisting(message?.recipientSessionId));
      this.resolveIdleIfReady();
    }, delayMs);
    this.retryTimerByMessage.set(entry.messageId, timer);
    this.retryTimers.add(timer);
  }

  private scheduleAvailabilityRetry(entry: QueuedMailboxDelivery, delayMs: number): void {
    if (this.closed || this.retryTimerByMessage.has(entry.messageId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.retryTimerByMessage.delete(entry.messageId);
      if (this.closed) return;
      this.trackWork(() => this.enqueueExisting(entry.message?.recipientSessionId));
      this.resolveIdleIfReady();
    }, Math.max(1, delayMs));
    this.retryTimerByMessage.set(entry.messageId, timer);
    this.retryTimers.add(timer);
  }

  private deferRecipient(recipientKey: string): void {
    for (const [messageId, entry] of this.queue) {
      if (entry.recipientKey === recipientKey) this.queue.delete(messageId);
    }
  }

  private forgetMessage(messageId: string): void {
    this.queue.delete(messageId);
    this.deliveryOrder.delete(messageId);
    this.retryAttempts.delete(messageId);
    this.retryNotBefore.delete(messageId);
    this.parkedMessages.delete(messageId);
    const timer = this.retryTimerByMessage.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(timer);
      this.retryTimerByMessage.delete(messageId);
    }
  }

  private async notifyTaskCompletion(
    event: Extract<ChiliEvent, { type: "agent.task_completed" }>,
  ): Promise<void> {
    await this.options.agents.notifyTaskCompletion?.(event);
    const ready = await this.options.agents.mailboxReadyAfterTaskCompletion?.(event.payload.taskId);
    for (const message of ready ?? []) {
      if (message.triggerTurn && message.status === "queued") this.enqueueMessage(message);
    }
  }

  private async notifyTaskCompletionsForSourceCall(sourceCallId: ToolCallId): Promise<void> {
    await this.options.agents.notifyTaskCompletionsForSourceCall?.(sourceCallId);
  }

  private scheduleIdleRetry(sessionId: SessionId): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.trackWork(() => this.enqueueExisting(sessionId));
      this.resolveIdleIfReady();
    }, 0);
    this.retryTimers.add(timer);
  }

  private trackWork(work: () => Promise<void>, messageId?: string): void {
    if (this.closed) return;
    this.pendingWork += 1;
    void work()
      .catch((error: unknown) => this.reportError(error, messageId))
      .finally(() => {
        this.pendingWork -= 1;
        this.resolveIdleIfReady();
      });
  }

  private reportError(error: unknown, messageId?: string): void {
    void Promise.resolve(this.options.onError?.(error, messageId)).catch(() => {
      // The pump should not crash the runtime because a diagnostics hook failed.
    });
  }

  private isIdle(): boolean {
    return !this.scheduling &&
      this.queue.size === 0 &&
      this.activeDeliveries.size === 0 &&
      this.pendingWork === 0 &&
      this.retryTimers.size === 0;
  }

  private resolveIdleIfReady(): void {
    if (!this.isIdle()) return;
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

function isTriggerTurnMailboxEvent(
  event: ChiliEvent,
): event is Extract<ChiliEvent, { type: "agent.message_queued" }> {
  return event.type === "agent.message_queued" && event.payload.triggerTurn;
}

function isAvailableSessionEvent(
  event: ChiliEvent,
): event is Extract<ChiliEvent, { type: "session.status_changed" }> {
  return event.type === "session.status_changed" && event.payload.status === "idle";
}

interface QueuedMailboxDelivery {
  messageId: string;
  sequence: number;
  recipientKey?: string;
  message?: AgentMailboxRow;
}

interface ActiveMailboxDelivery {
  messageId: string;
  recipientKey: string;
  controller: AbortController;
  promise: Promise<void>;
}

function mailboxRecipientKey(input: {
  path: string;
  recipientSessionId?: SessionId;
}): string {
  const route = input.path === ROOT_AGENT_PATH ? "root" : "child";
  return input.recipientSessionId
    ? `${route}\u0000${input.recipientSessionId}`
    : `${route}\u0000path:${input.path}`;
}

function isMailboxTurnRetryError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentMailboxTurnRetryError";
}

function isMailboxDelegationPausedError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentMailboxDelegationPausedError";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isMailboxTurnRetryable(error: Error): boolean {
  return !hasExplicitNonRetryable(error, new Set<object>());
}

function hasExplicitNonRetryable(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.retryable === false) return true;
  if (hasExplicitNonRetryable(record.cause, seen)) return true;
  return Array.isArray(record.errors) && record.errors.some((item) => hasExplicitNonRetryable(item, seen));
}
