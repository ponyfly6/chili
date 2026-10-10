import type { RuntimeSnapshot } from "../shared/contracts.js";

export interface HistoryNavigationState {
  scope?: string | undefined;
  page?: RuntimeSnapshot;
  loading: boolean;
  error?: string | undefined;
  canGoNewer: boolean;
}

type HistoryReader = (sessionId: string, beforeEventId?: string) => Promise<RuntimeSnapshot>;

/** Keep one bounded page; cursors never become a second execution state. */
export class HistoryNavigation {
  state: HistoryNavigationState = { loading: false, canGoNewer: false };
  private generation = 0;
  private sessionId: string | undefined;
  private reader: HistoryReader | undefined;
  private cursors: Array<string | undefined> = [];

  constructor(private readonly changed: (state: HistoryNavigationState) => void) {}

  configure(scope: string, sessionId: string | undefined, reader?: HistoryReader): void {
    this.sessionId = sessionId;
    this.reader = reader;
    if (scope === this.state.scope) return;
    this.generation += 1;
    this.cursors = [];
    this.publish({ scope, loading: false, canGoNewer: false });
  }

  open(): Promise<void> { return this.load([undefined]); }

  older(): Promise<void> {
    const cursor = this.state.page?.nextBeforeEventId;
    if (!cursor || this.cursors.includes(cursor)) return Promise.resolve();
    return this.load([...this.cursors, cursor]);
  }

  newer(): Promise<void> {
    return this.cursors.length > 1 ? this.load(this.cursors.slice(0, -1)) : Promise.resolve();
  }

  live(): void {
    this.generation += 1;
    this.cursors = [];
    this.publish({ scope: this.state.scope, loading: false, canGoNewer: false });
  }

  private async load(cursors: Array<string | undefined>): Promise<void> {
    const sessionId = this.sessionId;
    const reader = this.reader;
    if (!sessionId || !reader || this.state.loading) return;
    const generation = ++this.generation;
    this.publish({ ...this.state, loading: true, error: undefined });
    try {
      const page = await reader(sessionId, cursors.at(-1));
      if (generation !== this.generation) return;
      if (page.sessionId !== sessionId) throw new Error("History belongs to a different session");
      this.cursors = cursors;
      this.publish({ scope: this.state.scope, page, loading: false, canGoNewer: cursors.length > 1 });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({ ...this.state, loading: false,
        error: error instanceof Error ? error.message : "读取历史记录失败，请重试。" });
    }
  }

  private publish(state: HistoryNavigationState): void {
    this.state = state;
    this.changed(state);
  }
}
