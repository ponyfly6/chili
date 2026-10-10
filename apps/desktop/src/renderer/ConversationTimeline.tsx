import { useEffect, useState, useRef, useSyncExternalStore } from "react";
import type { HistoryContent, HistoryMessage, HistoryPart, HistoryTool, RuntimeInputQueue, RuntimeSessionInput } from "@chili/protocol";
import type { ControlTransport } from "./transport.js";
import { MessageHistory, type MessageHistoryState } from "./message-history.js";
import { TimelineViewport } from "./TimelineViewport.js";
import { MarkdownText } from "./App.js";
import { DeliveryCard } from "./DeliveryCard.js";
import { localResultPath } from "./result-model.js";
import { mergeHistoryParts, conversationTasks, historyToolStatus, historyToolTitle, isProcessPart, partTool, processSummary, type ConversationTask } from "./conversation-timeline-model.js";
import "./conversation-timeline.css";
import { submissionOutbox } from "./submission-outbox.js";

interface HistoryProps { transport: ControlTransport; sessionId: string; targetSessionId?: string; revision?: unknown; workspace?: string | undefined; onOpenResult?: ((path: string) => void) | undefined; deliveryOwners?: ReadonlyMap<string, string>;
  inputQueue?: RuntimeInputQueue | undefined; statusNote?: string | undefined; onOpenAgents?: (() => void) | undefined; agentSummary?: string | undefined; projectId?: string | undefined; }

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
  const [expanded, setExpanded] = useState<Record<string, HistoryMessage>>({});
  const [partLoads, setPartLoads] = useState<Record<string, { loading?: boolean; error?: string }>>({});
  const messages = state.messages.map((message) => mergeHistoryParts(message, expanded[message.id]));
  async function loadParts(message: HistoryMessage) {
    if (message.nextPartOffset === undefined || partLoads[message.id]?.loading) return;
    setPartLoads((previous) => ({ ...previous, [message.id]: { loading: true } }));
    try {
      const page = await transport.historyMessage!({ sessionId, ...(targetSessionId ? { targetSessionId } : {}), messageId: message.id, partOffset: message.nextPartOffset });
      setExpanded((previous) => ({ ...previous, [message.id]: { ...page, parts: [...message.parts, ...page.parts] } }));
      setPartLoads((previous) => ({ ...previous, [message.id]: {} }));
    } catch (cause) {
      setPartLoads((previous) => ({ ...previous, [message.id]: { error: cause instanceof Error ? cause.message : "读取失败" } }));
    }
  }
  const tasks = conversationTasks(messages);
  const visibleMessages = tasks.flatMap((task) => task.messages);
  const deliveryOwners = new Map<string, string>();
  for (const message of visibleMessages) for (const part of message.parts) {
    const delivery = partDelivery(part, props.workspace);
    if (delivery) deliveryOwners.set(delivery.path, part.id);
  }
  const content = <>
    {state.before ? <button className="secondary history-load" disabled={state.loading} onClick={() => void historyRef.current?.older()}>加载更早的消息</button> : null}
    {state.loading && !state.messages.length ? <p role="status">正在读取消息…</p> : null}
    {state.error ? <p role="alert">{state.error} <button onClick={() => void historyRef.current?.refresh()}>重试</button></p> : null}
    {tasks.map((task) => <TaskHistory key={task.id} task={task} {...props} deliveryOwners={deliveryOwners} loadParts={loadParts} partLoads={partLoads} />)}
    {props.statusNote ? <p className="conversation-status-note" role="status">{props.statusNote}</p> : null}
    {props.agentSummary && props.onOpenAgents ? <button className="conversation-agent-link" onClick={props.onOpenAgents}>{props.agentSummary} <span aria-hidden="true">›</span></button> : null}
    {(props.inputQueue?.items ?? []).filter((input) => !input.readAt && input.state !== "settled" && !visibleMessages.some((message) => message.inputId === input.inputId))
      .sort((a, b) => a.sequence - b.sequence).map((input) => <PendingMessage key={input.inputId} input={input} {...props} onChange={() => { void historyRef.current?.refresh(); }} />)}
    {!targetSessionId ? <UnconfirmedMessages {...props} messages={state.messages} /> : null}
    {!state.loading && !state.error && state.messages.length === 0 && !props.inputQueue?.items.length ? <p className="empty-copy">暂无消息</p> : null}
  </>;
  return <TimelineViewport scopeKey={`${sessionId}:${targetSessionId ?? "root"}`} firstItemKey={state.messages[0]?.id} onReachTop={state.before && !state.loading && !state.error ? () => { void historyRef.current?.older(); } : undefined}>{content}</TimelineViewport>;
}

function UnconfirmedMessages({ messages, ...props }: HistoryProps & { messages: readonly HistoryMessage[] }) {
  const outbox = submissionOutbox();
  const entries = useSyncExternalStore(outbox.subscribe, outbox.snapshot, outbox.snapshot);
  const [error, setError] = useState<string>();
  const known = new Set([...messages.flatMap((message) => message.submissionId ? [message.submissionId] : []), ...(props.inputQueue?.items.map((input) => input.submissionId) ?? [])]);
  useEffect(() => {
    for (const entry of entries) if (entry.state !== "confirmed" && entry.projectId === props.projectId && entry.sessionId === props.sessionId && known.has(entry.submissionId)) outbox.confirm(entry.submissionId);
  }, [entries, props.projectId, props.sessionId, props.inputQueue, messages, outbox]);
  return <>{entries.filter((entry) => entry.state !== "confirmed" && entry.projectId === props.projectId && entry.sessionId === props.sessionId && !known.has(entry.submissionId)).map((entry) =>
    <article key={entry.submissionId} className="timeline-item message message-user pending-message"><div className="message-content">
      <div className="message-body"><MarkdownText text={entry.text} /></div>
      <div className="message-receipt">{entry.state === "sending" ? "正在发送…" : <>送达尚未确认 <button onClick={() => {
        setError(undefined); void props.transport.send(props.sessionId, entry.text, entry.mode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "发送未成功"));
      }}>重试</button></>}</div>
    </div></article>)}{error ? <p role="alert">{error}</p> : null}</>;
}

function TaskHistory({ task, loadParts, partLoads, ...props }: HistoryProps & { task: ConversationTask;
  loadParts: (message: HistoryMessage) => Promise<void>; partLoads: Record<string, { loading?: boolean; error?: string }> }) {
  const process = task.messages.flatMap((message) => message.parts.filter(isProcessPart));
  const firstProcess = task.messages.find((message) => message.parts.some(isProcessPart))?.id;
  return <section className="conversation-task" data-work-id={task.id}>
    {task.messages.flatMap((message) => {
      const publicParts = message.parts.filter((part) => !isProcessPart(part));
      return [
        publicParts.length || (!message.parts.length && message.nextPartOffset !== undefined) ? <HistoryMessageView key={`public:${message.id}`} message={{ ...message, parts: publicParts }} {...props} /> : null,
        message.id === firstProcess ? <details key="process" className="conversation-process">
          <summary>{processSummary(process)}</summary>
          <div>{task.messages.filter((item) => item.parts.some(isProcessPart)).map((item) => <HistoryMessageView key={item.id}
            message={{ ...item, parts: item.parts.filter(isProcessPart) }}
            processOnly={item.parts.some((part) => !isProcessPart(part))} {...props} />)}</div>
        </details> : null,
        message.nextPartOffset !== undefined ? <button key={`more:${message.id}`} className="secondary history-load" disabled={partLoads[message.id]?.loading} onClick={() => void loadParts(message)}>加载消息中的更多内容</button> : null,
        partLoads[message.id]?.error ? <p key={`error:${message.id}`} role="alert">{partLoads[message.id]?.error}</p> : null,
        ...message.parts.flatMap((part) => {
          const delivery = partDelivery(part, props.workspace);
          return delivery && props.onOpenResult && props.deliveryOwners?.get(delivery.path) === part.id ? [<DeliveryCard key={part.id} result={{ id: delivery.path, path: delivery.path, label: delivery.title ?? delivery.path,
            ...(delivery.description ? { description: delivery.description } : {}), source: "tool", messageId: part.callId!, updatedAt: 0 }} onOpen={props.onOpenResult} />] : [];
        }),
      ];
    })}
  </section>;
}

function PendingMessage({ input, onChange, ...props }: HistoryProps & { input: RuntimeSessionInput; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [withdrawn, setWithdrawn] = useState(false);
  async function withdraw() {
    if (busy || !props.transport.cancelInput) return;
    setBusy(true); setError(undefined);
    try { await props.transport.cancelInput(props.sessionId, input.inputId, input.revision); setWithdrawn(true); onChange(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "撤回未成功"); }
    finally { setBusy(false); }
  }
  if (withdrawn) return null;
  return <article className="timeline-item message message-user pending-message" data-input-id={input.inputId}>
    <div className="message-content"><div className="message-body"><MarkdownText text={input.text} /></div>
      <div className="message-receipt"><span>已保存 · {props.inputQueue?.paused ? "继续后读取" : "下一步读取"}</span>
        {input.state === "pending" && props.transport.cancelInput ? <details className="message-menu"><summary aria-label="消息操作">···</summary><button disabled={busy} onClick={() => void withdraw()}>撤回</button></details> : null}
      </div>{error ? <p role="alert">{error}</p> : null}
    </div>
  </article>;
}

function HistoryMessageView({ message, processOnly, ...props }: HistoryProps & { message: HistoryMessage; processOnly?: boolean }) {
  return <article className={`timeline-item message message-${message.role}`} data-message-id={processOnly ? undefined : message.id}>
    <div className="message-content">
      <div className="message-body">{message.parts.map((part) => <HistoryPartView key={part.id} part={part} {...props} />)}</div>
      {message.role === "user" && message.inputId && !message.readAt ? <p className="message-receipt">已保存 · 下一步读取</p> : null}
    </div>
  </article>;
}

function HistoryPartView({ part, ...props }: HistoryProps & { part: HistoryPart }) {
  if (part.callId) {
    return <ToolHistory {...props} tool={partTool(part)} />;
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
    <summary><span>{historyToolTitle(tool.name)}</span>{tool.subject ? <span className="history-tool-subject">{tool.subject}</span> : null}<small>{historyToolStatus(tool.status)}</small></summary>
    {tool.errorSummary ? <p className="history-tool-error">{tool.errorSummary}</p> : null}
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
