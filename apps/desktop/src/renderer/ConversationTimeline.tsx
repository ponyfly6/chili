import { useEffect, useState, useRef } from "react";
import type { HistoryContent, HistoryMessage, HistoryPart, HistoryTool } from "@chili/protocol";
import type { ControlTransport } from "./transport.js";
import { MessageHistory, type MessageHistoryState } from "./message-history.js";
import { TimelineViewport } from "./TimelineViewport.js";
import { MarkdownText } from "./App.js";
import { DeliveryCard } from "./DeliveryCard.js";
import { localResultPath } from "./result-model.js";

interface HistoryProps { transport: ControlTransport; sessionId: string; targetSessionId?: string; revision?: unknown; workspace?: string | undefined; onOpenResult?: ((path: string) => void) | undefined; deliveryOwners?: ReadonlyMap<string, string>; }

/** The parent remounts this component on project/session changes. */
export function ConversationTimeline(props: HistoryProps) {
  const { transport, sessionId, targetSessionId, revision } = props;
  const [state, setState] = useState<MessageHistoryState>({ messages: [], loading: false });
  const readerRef = useRef(transport);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  readerRef.current = transport;
  const historyRef = useRef<MessageHistory | undefined>(undefined);
  useEffect(() => {
    const history = new MessageHistory((beforeMessageId) => readerRef.current.conversationPage!({ sessionId,
      ...(targetSessionId ? { targetSessionId } : {}), ...(beforeMessageId ? { beforeMessageId } : {}) }), setState);
    historyRef.current = history;
    void history.refresh();
    return () => { history.dispose(); clearTimeout(refreshTimer.current); refreshTimer.current = undefined; };
  }, [sessionId, targetSessionId]);
  useEffect(() => {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void historyRef.current?.refresh(); }, 250);
  }, [sessionId, targetSessionId, revision]);
  const seenTools = new Set<string>();
  const visibleMessages = state.messages.map((message) => ({ ...message, parts: message.parts.filter((part) => {
    if (!part.callId) return true;
    if (seenTools.has(part.callId)) return false;
    seenTools.add(part.callId); return true;
  }) })).filter((message) => message.parts.length > 0 || message.nextPartOffset !== undefined);
  const deliveryOwners = new Map<string, string>();
  for (const message of visibleMessages) for (const part of message.parts) {
    const delivery = partDelivery(part, props.workspace);
    if (delivery) deliveryOwners.set(delivery.path, part.id);
  }
  const content = <>
    {state.before ? <button className="secondary history-load" disabled={state.loading} onClick={() => void historyRef.current?.older()}>加载更早的消息</button> : null}
    {state.loading && !state.messages.length ? <p role="status">正在读取消息…</p> : null}
    {state.error ? <p role="alert">{state.error} <button onClick={() => void historyRef.current?.refresh()}>重试</button></p> : null}
    {visibleMessages.map((message) => <HistoryMessageView key={message.id} message={message} {...props} deliveryOwners={deliveryOwners} />)}
    {!state.loading && !state.error && state.messages.length === 0 ? <p className="empty-copy">暂无消息</p> : null}
  </>;
  return <TimelineViewport scopeKey={`${sessionId}:${targetSessionId ?? "root"}`} firstItemKey={state.messages[0]?.id} onReachTop={state.before && !state.loading && !state.error ? () => { void historyRef.current?.older(); } : undefined}>{content}</TimelineViewport>;
}

function HistoryMessageView({ message, ...props }: HistoryProps & { message: HistoryMessage }) {
  const [extra, setExtra] = useState<HistoryMessage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const parts = [...message.parts, ...(extra?.parts ?? []).filter((part) => !message.parts.some((item) => item.id === part.id))];
  const next = extra ? extra.nextPartOffset : message.nextPartOffset;
  async function moreParts() {
    if (next === undefined || loading) return;
    setLoading(true); setError(undefined);
    try {
      const page = await props.transport.historyMessage!({ sessionId: props.sessionId, ...(props.targetSessionId ? { targetSessionId: props.targetSessionId } : {}), messageId: message.id, partOffset: next });
      setExtra((previous) => ({ ...page, parts: [...(previous?.parts ?? []), ...page.parts] }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setLoading(false); }
  }
  return <article className={`timeline-item message message-${message.role}`} data-message-id={message.id}>
    <div className="message-content">
      {message.role === "assistant" ? <div className="message-author">Chili</div> : null}
      <div className="message-body">{parts.map((part) => <HistoryPartView key={part.id} part={part} {...props} />)}</div>
      {next !== undefined ? <button className="secondary" disabled={loading} onClick={() => void moreParts()}>加载消息中的更多内容</button> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </article>;
}

function HistoryPartView({ part, ...props }: HistoryProps & { part: HistoryPart }) {
  if (part.callId) {
    const delivery = partDelivery(part, props.workspace);
    const ownsDelivery = delivery && (!props.deliveryOwners?.has(delivery.path) || props.deliveryOwners.get(delivery.path) === part.id);
    return <>{delivery && ownsDelivery && props.onOpenResult ? <DeliveryCard result={{ id: delivery.path, path: delivery.path, label: delivery.title ?? delivery.path,
      ...(delivery.description ? { description: delivery.description } : {}), source: "tool", messageId: part.callId, updatedAt: 0 }} onOpen={props.onOpenResult} /> : null}
      <ToolHistory {...props} tool={{ id: part.callId, name: part.toolName ?? "tool", status: part.status ?? "completed", startedAt: 0, updatedAt: 0 }} /></>;
  }
  const body = <>{part.text ? <MarkdownText text={part.text} compact={part.type === "reasoning"} /> : part.type === "image" ? <p className="attachment">图片附件 · {part.filename ?? part.mimeType}</p> : null}
    {part.completion === "cancelled" || part.completion === "failed" ? <p className="work-history-note">{part.completion === "cancelled" ? "已停止，内容未完成" : "生成失败，内容未完成"}</p> : null}
    {part.hasMore ? <details className="tool-details"><summary>查看完整内容</summary><ContentOnOpen {...props} revision={part.completion} kind="part" id={part.id} field="text" /></details> : null}</>;
  return part.type === "reasoning" ? <details className="work-reasoning"><summary>思考过程</summary>{body}</details> : body;
}

function partDelivery(part: HistoryPart, workspace?: string): { path: string; title?: string; description?: string } | undefined {
  if (part.toolName !== "present_file" || part.status !== "completed" || !workspace) return undefined;
  try {
    const value = JSON.parse(part.text) as Record<string, unknown>;
    const path = typeof value.path === "string" && value.type === "presented_file" ? localResultPath(value.path, workspace) : undefined;
    if (path) return { path, ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.description === "string" ? { description: value.description } : {}) };
  } catch { /* A delivery requires a complete explicit result. */ }
  return undefined;
}

function ToolHistory({ tool, ...props }: HistoryProps & { tool: HistoryTool }) {
  const [open, setOpen] = useState(false);
  return <details className="tool-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tool.name} · {tool.status} · 查看详情</summary>
    {open ? <>
      {(["input", "output", "error"] as const).map((field) => <details key={field}><summary>{{ input: "调用参数", output: "执行结果", error: "错误详情" }[field]}</summary><ContentOnOpen {...props} revision={tool.status} kind="tool" id={tool.id} field={field} /></details>)}
      <ToolChildren {...props} parentCallId={tool.id} />
    </> : null}
  </details>;
}

/** Only the enclosing disclosure opening starts I/O; collapsed rows fetch nothing. */
function ContentOnOpen(props: HistoryProps & { kind: "part" | "tool"; id: string; field: HistoryContent["field"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.parentElement as HTMLDetailsElement | null;
    if (!details) return;
    const update = () => setOpen(details.open);
    details.addEventListener("toggle", update); update();
    return () => details.removeEventListener("toggle", update);
  }, []);
  return <div ref={ref}>{open ? <ContentChunks {...props} /> : null}</div>;
}

function ContentChunks({ transport, sessionId, targetSessionId, kind, id, field, revision }: HistoryProps & { kind: "part" | "tool"; id: string; field: HistoryContent["field"] }) {
  const [page, setPage] = useState<HistoryContent>();
  const [cursors, setCursors] = useState([0]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const offset = cursors.at(-1)!;
  useEffect(() => {
    let current = true;
    setLoading(true); setError(undefined);
    transport.historyContent!({ sessionId, ...(targetSessionId ? { targetSessionId } : {}), kind, id, field, offset }).then((result) => {
      if (current) setPage(result);
    }, (cause) => { if (current) setError(cause instanceof Error ? cause.message : "读取失败"); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [sessionId, targetSessionId, kind, id, field, offset, retry, revision]);
  return <div className="history-content">
    {loading ? <p role="status">正在读取详情…</p> : null}
    {error ? <p role="alert">{error} <button onClick={() => setRetry((value) => value + 1)}>重试</button></p> : null}
    {page ? <pre>{page.text || "（无内容）"}</pre> : null}
    <nav aria-label="详情分页">
      {cursors.length > 1 ? <button disabled={loading} onClick={() => setCursors((values) => values.slice(0, -1))}>上一段</button> : null}
      {page?.nextOffset !== undefined ? <button disabled={loading || Boolean(error)} onClick={() => setCursors((values) => [...values, page.nextOffset!])}>下一段</button> : null}
    </nav>
  </div>;
}

function ToolChildren({ transport, sessionId, targetSessionId, parentCallId, ...props }: HistoryProps & { parentCallId: string }) {
  const [tools, setTools] = useState<HistoryTool[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  async function load(afterToolId?: string) {
    if (loading) return;
    setLoading(true); setError(undefined);
    try {
      const page = await transport.historyTools!({ sessionId, ...(targetSessionId ? { targetSessionId } : {}), parentCallId, ...(afterToolId ? { afterToolId } : {}) });
      if (alive.current) { setTools((previous) => afterToolId ? [...previous, ...page.tools] : page.tools); setCursor(page.nextAfterToolId); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [parentCallId]);
  return <div>{tools.map((tool) => <ToolHistory key={tool.id} tool={tool} transport={transport} sessionId={sessionId} {...(targetSessionId ? { targetSessionId } : {})} {...props} />)}
    {error ? <p role="alert">{error} <button onClick={() => void load(cursor)}>重试</button></p> : null}
    {cursor ? <button disabled={loading} onClick={() => void load(cursor)}>更多子调用</button> : null}</div>;
}
