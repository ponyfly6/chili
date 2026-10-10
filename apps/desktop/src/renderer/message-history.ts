import type { ConversationPage, HistoryMessage } from "@chili/protocol";

export interface MessageHistoryState { messages: HistoryMessage[]; before?: string | undefined; loading: boolean; error?: string | undefined; }
/** Durable page order wins over timestamps. Refreshes bridge new pages before publishing. */
export class MessageHistory {
  state: MessageHistoryState = { messages: [], loading: false };
  private disposed = false;
  private refreshRequested = false;
  constructor(private readonly read: (before?: string) => Promise<ConversationPage>, private readonly changed: (state: MessageHistoryState) => void) {}
  dispose(): void { this.disposed = true; }
  async refresh(): Promise<void> {
    this.refreshRequested = true;
    if (this.state.loading || this.disposed) return;
    do {
      this.refreshRequested = false;
      this.publish({ ...this.state, loading: true, error: undefined });
      try {
        let page = await this.read();
        let recent = page.messages;
        const existing = this.state.messages;
        const known = new Set(existing.map((message) => message.id));
        const cursors = new Set<string>();
        while (existing.length && !recent.some((message) => known.has(message.id)) && page.nextBeforeMessageId) {
          if (this.disposed) return;
          if (cursors.has(page.nextBeforeMessageId)) throw new Error("历史分页游标没有前进");
          cursors.add(page.nextBeforeMessageId);
          page = await this.read(page.nextBeforeMessageId);
          recent = [...page.messages, ...recent];
        }
        const overlap = existing.findIndex((message) => recent.some((item) => item.id === message.id));
        const prefix = overlap >= 0 ? existing.slice(0, overlap) : [];
        this.publish({ messages: unique([...prefix, ...recent]), before: overlap >= 0 ? this.state.before : page.nextBeforeMessageId, loading: false });
      } catch (error) { this.fail(error); }
    } while (this.refreshRequested && !this.disposed);
  }
  async older(): Promise<void> {
    const before = this.state.before;
    if (!before || this.state.loading || this.disposed) return;
    this.publish({ ...this.state, loading: true, error: undefined });
    try {
      const page = await this.read(before);
      if (page.nextBeforeMessageId === before) throw new Error("历史分页游标没有前进");
      this.publish({ messages: unique([...page.messages, ...this.state.messages]), before: page.nextBeforeMessageId, loading: false });
    } catch (error) { this.fail(error); }
    if (this.refreshRequested) await this.refresh();
  }
  private fail(error: unknown): void { this.publish({ ...this.state, loading: false, error: error instanceof Error ? error.message : "历史读取失败，请重试。" }); }
  private publish(state: MessageHistoryState): void { if (!this.disposed) { this.state = state; this.changed(state); } }
}
function unique(messages: HistoryMessage[]): HistoryMessage[] {
  const rows = new Map<string, HistoryMessage>();
  for (const message of messages) rows.set(message.id, message);
  return [...rows.values()];
}
