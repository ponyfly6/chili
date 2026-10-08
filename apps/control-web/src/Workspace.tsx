import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import chiliIcon from "../../../assets/brand/chili-icon.svg";
import { Icon } from "./Icon.js";
import { MessageText } from "./MessageText.js";
import { Sheet } from "./Sheet.js";
import { MAX_PROMPT_BYTES, promptByteLength, runStatusLabel } from "./view-model.js";
import type { RemoteSnapshot, RemoteTask } from "./view-model.js";
import "./workspace.css";

export interface WorkspaceProps {
  tasks: readonly RemoteTask[];
  tasksTruncated: boolean;
  listLoaded: boolean;
  selectedId: string | null;
  snapshot: RemoteSnapshot | null;
  lastRead: Date | null;
  connected: boolean;
  connectionLabel: string;
  computerLabel: string;
  listError: string | null;
  readError: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  sending: "queue" | "steer" | null;
  stopping: boolean;
  sendDisabled: boolean;
  stopDisabled: boolean;
  onSelectTask: (id: string) => void;
  onSend: (mode: "queue" | "steer") => void;
  onStop: () => void;
  onRefresh: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onForget: () => void;
  onOpenQuestion: (inputId: string) => void;
  alerts?: ReactNode;
  mobilePanel?: "list" | "task";
  onMobilePanelChange?: (panel: "list" | "task") => void;
  reconnectDisabled?: boolean;
  disconnectDisabled?: boolean;
  forgetDisabled?: boolean;
  answerDisabled?: boolean;
  deviceLabel?: string;
  remembersDevice?: boolean;
}

type WorkspaceSheet = "mode" | "menu" | "forget" | null;

export function Workspace(props: WorkspaceProps) {
  const {
    tasks, tasksTruncated, listLoaded, selectedId, lastRead, connected, connectionLabel, computerLabel,
    listError, readError, draft, onDraftChange, sending, stopping, sendDisabled, stopDisabled,
    onSelectTask, onSend, onStop, onRefresh, onReconnect, onDisconnect, onForget, onOpenQuestion,
  } = props;
  const [localPanel, setLocalPanel] = useState<"list" | "task">(selectedId ? "task" : "list");
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [sheet, setSheet] = useState<WorkspaceSheet>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollState = useRef({ taskId: selectedId, nearBottom: true, messageIds: "" });
  const snapshot = props.snapshot?.session.id === selectedId ? props.snapshot : null;
  const task = snapshot?.session ?? tasks.find((candidate) => candidate.id === selectedId);
  const panel = selectedId ? (props.mobilePanel ?? localPanel) : "list";
  const visiblePanel = deviceOpen ? "device" : panel;
  const inputRequests = snapshot?.inputRequests ?? [];
  const waitingForInput = inputRequests.length > 0;
  const needsDesktop = snapshot?.session.needsDesktop.approval || snapshot?.session.needsDesktop.input;
  const controllable = task?.status === "active";
  const byteLength = promptByteLength(draft);
  const inputDisabled = !connected || !snapshot || !controllable || !!needsDesktop || waitingForInput;
  const sendBlocked = sendDisabled || inputDisabled;
  const messageIds = snapshot?.messages.map((message) => `${message.id}:${message.text.length}`).join("|") ?? "";
  const visibleTasks = tasks.filter((item) => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  const setPanel = (next: "list" | "task") => {
    setLocalPanel(next);
    props.onMobilePanelChange?.(next);
    setDeviceOpen(false);
    setSheet(null);
  };
  const selectTask = (id: string) => {
    onSelectTask(id);
    setPanel("task");
  };
  const openDevice = () => { setDeviceOpen(true); setSheet(null); };
  const openQuestion = (id: string) => { setSheet(null); onOpenQuestion(id); };
  const scrollToLatest = () => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    scrollState.current.nearBottom = true;
    setHasNewMessages(false);
  };

  useEffect(() => {
    setSheet(null);
    setMode("queue");
    if (!props.mobilePanel && selectedId) setLocalPanel("task");
  }, [selectedId]);

  useLayoutEffect(() => {
    const previous = scrollState.current;
    const switchedTask = previous.taskId !== selectedId;
    const changedMessages = previous.messageIds !== messageIds;
    if (switchedTask || previous.nearBottom) scrollToLatest();
    else if (changedMessages) setHasNewMessages(true);
    scrollState.current.taskId = selectedId;
    scrollState.current.messageIds = messageIds;
  }, [selectedId, messageIds]);

  useLayoutEffect(() => {
    if (visiblePanel === "task" && scrollState.current.nearBottom) scrollToLatest();
  }, [visiblePanel]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || typeof ResizeObserver === "undefined") return;
    // A keyboard resize changes the viewport without adding a message. Keep
    // following only if the reader was already at the end before the resize.
    const observer = new ResizeObserver(() => {
      if (transcript.clientHeight === 0 || !scrollState.current.nearBottom) return;
      transcript.scrollTop = transcript.scrollHeight;
      setHasNewMessages(false);
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [selectedId, visiblePanel]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [draft, selectedId, visiblePanel]);

  const taskState = snapshot ? runStatusLabel(snapshot.session.runStatus) : connected ? "正在读取任务" : "尚未读取任务";
  const placeholder = !connected ? "连接恢复后可发送" : needsDesktop ? "请先在电脑完成确认" : waitingForInput ? "先回答待处理的问题" : !snapshot ? "正在读取任务…" : "告诉 Chili，接下来做什么…";

  return (
    <div className="chili-workspace" data-panel={visiblePanel}>
      <span className="chili-visually-hidden" data-testid="connection-status" role="status">{connectionLabel}</span>
      {props.alerts && <div className="chili-alerts" role="region" aria-label="连接与指令提醒" tabIndex={0}>{props.alerts}</div>}
      <div className="chili-workspace-body">
        <aside className="chili-task-list" aria-label="任务列表" data-testid="task-list">
          <div className="chili-list-scroll">
            <header className="chili-list-heading"><h1>你的任务</h1><img src={chiliIcon} alt="Chili" width="35" height="35" /></header>
            <button type="button" className="chili-computer-chip" onClick={openDevice} aria-label={`查看电脑连接：${computerLabel}，${connectionLabel}`}>
              <Icon name="laptop" size={17} /><span className="chili-chip-computer">{computerLabel}</span><i className={`chili-status-dot ${connected ? "is-connected" : "is-offline"}`} /><span>{connectionLabel}</span><Icon name="chevron-right" size={14} />
            </button>
            <label className="chili-search"><Icon name="search" size={18} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" autoComplete="off" /></label>
            <div className="chili-section-label"><span>{search.trim() ? "搜索结果" : "最近任务"}</span>{listLoaded && <span>{visibleTasks.length}{tasksTruncated ? "+" : ""}</span>}</div>
            {listError && <div className="chili-state-note is-warning" role="alert"><strong>暂时无法更新任务列表</strong><p>{listError}</p><button type="button" onClick={onRefresh} disabled={!connected}>重新读取</button></div>}
            {!listLoaded && !listError && <div className="chili-empty compact" role="status"><Icon name="refresh" size={24} /><p>{connected ? "正在读取电脑上的任务…" : "连接恢复后会读取任务"}</p></div>}
            {listLoaded && tasks.length === 0 && <div className="chili-empty compact"><Icon name="chat" size={28} /><h2>还没有可访问的任务</h2><p>在电脑的当前工作区创建任务后，<br />就可以从这里接着看、接着聊。</p></div>}
            {listLoaded && tasks.length > 0 && visibleTasks.length === 0 && <div className="chili-empty compact"><p>没有找到匹配的任务</p><button type="button" className="chili-text-action" onClick={() => setSearch("")}>清除搜索</button></div>}
            <ul className="chili-task-rows">
              {visibleTasks.map((item) => <li key={item.id}>
                <button type="button" className={`chili-task-row ${item.id === selectedId ? "is-selected" : ""}`} data-testid={`task-item-${item.id}`} aria-pressed={item.id === selectedId} onClick={() => selectTask(item.id)}>
                  <span className="chili-task-icon"><Icon name="chat" size={18} /></span>
                  <span className="chili-task-info"><strong>{item.title || "未命名任务"}</strong><span>{item.id === snapshot?.session.id ? runStatusLabel(snapshot.session.runStatus) : item.status === "archived" ? "已归档" : "最近更新"}</span></span>
                  <span className="chili-task-time" title={fullTime(item.updatedAt)}>{shortTime(item.updatedAt)}<Icon name="chevron-right" size={13} /></span>
                </button>
              </li>)}
            </ul>
            {tasksTruncated && <p className="chili-list-note">这里只显示部分任务。完整列表请在电脑查看。</p>}
          </div>
          <footer className="chili-list-footer"><button type="button" onClick={openDevice}><Icon name="laptop" size={19} /><span>电脑与连接</span><Icon name="chevron-right" size={15} /></button><button type="button" className="chili-icon-button" onClick={onRefresh} disabled={!connected} aria-label="刷新任务列表"><Icon name="refresh" size={18} /></button></footer>
        </aside>

        <section className="chili-detail" aria-label={deviceOpen ? "电脑与连接" : "当前任务"}>
          {deviceOpen ? <>
            <header className="chili-nav"><button type="button" className="chili-icon-button" aria-label="返回" onClick={() => setDeviceOpen(false)}><Icon name="chevron-left" /></button><div className="chili-nav-title"><h2>电脑与连接</h2><span>当前授权与连接</span></div><span className="chili-nav-spacer" /></header>
            <div className="chili-device-scroll">
              <div className="chili-device-hero"><div className="chili-device-icon"><Icon name="laptop" size={39} /></div><h1>{computerLabel}</h1><p><i className={`chili-status-dot ${connected ? "is-connected" : "is-offline"}`} />{connectionLabel}</p></div>
              <dl className="chili-connection-group"><div><dt>电脑地址</dt><dd>{computerLabel}</dd></div><div><dt>连接状态</dt><dd className={connected ? "chili-connected-text" : ""}>{connectionLabel}</dd></div>{props.deviceLabel && <div><dt>设备名称</dt><dd>{props.deviceLabel}</dd></div>}<div><dt>最近读取</dt><dd>{lastRead ? fullTime(lastRead.toISOString()) : "尚未读取任务"}</dd></div></dl>
              <p className="chili-device-note">保持电脑上的 Chili 运行，并确认手机可以访问这台电脑。{props.remembersDevice ? "授权有效时，重新打开 App 会自动连接。" : "当前浏览器的连接授权只在本次会话中有效。"}</p>
              {selectedId && <button type="button" className="chili-primary-button" onClick={() => setPanel("task")}>回到当前任务<Icon name="chevron-right" size={18} /></button>}
              <button type="button" className="chili-secondary-button" data-testid="reconnect" onClick={onReconnect} disabled={props.reconnectDisabled}>重新连接<Icon name="refresh" size={18} /></button>
              <details className="chili-device-help"><summary>哪些情况需要重新配对？</summary><p>电脑上的 Chili 重启、切换工作区、关闭手机控制，或授权过期、被撤销后，需要重新配对。请在电脑获取新的配对码并确认请求。</p></details>
              {connected && <button type="button" className="chili-text-action" data-testid="disconnect" onClick={onDisconnect} disabled={props.disconnectDisabled}>断开连接</button>}
              <button type="button" className="chili-text-action is-danger" data-testid="forget-device" onClick={() => setSheet("forget")} disabled={props.forgetDisabled}>忘记这台电脑</button>
            </div>
          </> : !selectedId ? <div className="chili-empty chili-choose-task"><img src={chiliIcon} alt="" width="48" height="48" /><h2>接着做你的工作</h2><p>选择一个任务，查看进展、<br />回答问题，或补充新的想法。</p></div> : <>
            <header className="chili-nav"><button type="button" className="chili-icon-button chili-show-tasks" aria-label="打开任务列表" onClick={() => setPanel("list")}><Icon name="menu" /></button><button type="button" className="chili-nav-title" onClick={openDevice} aria-label={`查看电脑连接：${computerLabel}`}><h2>{task?.title || "正在读取任务…"}</h2><span><i className={`chili-status-dot ${connected ? "is-connected" : "is-offline"}`} />{computerLabel} · {connectionLabel}</span></button><button type="button" className="chili-icon-button" aria-label="更多任务操作" onClick={() => setSheet("menu")}><Icon name="more" /></button></header>
            <div className="chili-transcript-wrap">
              <div className="chili-transcript" ref={transcriptRef} data-testid="transcript" aria-label="最近消息" aria-busy={connected && !snapshot && !readError} onScroll={() => {
                const transcript = transcriptRef.current;
                if (!transcript) return;
                const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
                scrollState.current.nearBottom = nearBottom;
                if (nearBottom) setHasNewMessages(false);
              }}>
                {!connected && <div className="chili-state-note is-warning" role="status"><strong>暂时连不上电脑</strong><p>显示的是上次读取的内容。电脑上的任务可能仍在继续。</p><button type="button" onClick={openDevice}>查看连接</button></div>}
                {readError && <div className="chili-state-note is-warning" role="alert"><strong>暂时无法更新这项任务</strong><p>{readError}</p><button type="button" onClick={onRefresh} disabled={!connected}>重新读取</button></div>}
                {snapshot?.session.deliveryUnknown && <div className="chili-state-note is-warning" role="alert" data-testid="delivery-unknown"><strong>排队指令的执行结果待核对</strong><p>这条指令可能已经执行。请查看最新回复或回电脑核对后，再决定下一步。</p></div>}
                {needsDesktop && <div className="chili-state-note" role="status" data-testid="needs-desktop"><Icon name="lock" size={20} /><strong>请在电脑上处理</strong><p>{snapshot?.session.needsDesktop.approval ? "这项任务正在等待权限审批。请在电脑上的同一任务完成确认。" : "这项任务正在等待回答。请在电脑完成这个提问流程。"}</p></div>}
                {!snapshot && !readError && <div className="chili-empty compact" role="status"><p>{connected ? "正在读取最近消息…" : "连接恢复后可读取消息"}</p></div>}
                {snapshot?.truncated && <p className="chili-transcript-note">已省略部分较早或较长的内容。完整记录请在电脑查看。</p>}
                {snapshot && snapshot.messages.length === 0 && <div className="chili-empty compact"><p>这里还没有可显示的消息。</p><span>手机显示用户和 Chili 的回复。<br />详细工具记录请在电脑查看。</span></div>}
                {snapshot?.messages.map((message) => <article className={`chili-message is-${message.role}`} key={message.id} aria-label={`${message.role === "assistant" ? "Chili" : "你"}，${fullTime(message.createdAt)}`}>
                  {message.role === "assistant" ? <><div className="chili-agent-line"><img src={chiliIcon} alt="" width="22" height="22" /><strong>Chili</strong></div><MessageText text={message.text} /></> : <div className="chili-user-bubble">{message.text}</div>}
                </article>)}
                {inputRequests.map((request) => <section className="chili-question-entry" key={request.id} data-testid={`input-request-${request.id}`}><div className="chili-question-eyebrow"><span><Icon name="reply" size={16} />需要你回答</span><span>{request.questions.length} 个问题</span></div><h3>{request.questions[0]?.question}</h3><button type="button" onClick={() => openQuestion(request.id)}>查看问题<Icon name="chevron-right" size={16} /></button></section>)}
                {lastRead && <p className="chili-read-time">{connected && !readError ? "最近读取" : "上次读取"} {fullTime(lastRead.toISOString())}</p>}
              </div>
              {hasNewMessages && <button type="button" className="chili-latest" onClick={scrollToLatest}>查看最新消息<Icon name="chevron-down" size={16} /></button>}
            </div>
            {controllable ? <footer className="chili-composer" aria-label="任务控制">
              {snapshot && snapshot.session.queuedCount > 0 && <div className="chili-queue-note" data-testid="queued-count"><Icon name="queue" size={16} /><span>{snapshot.session.queuedCount} 条指令已排队</span></div>}
              <div className="chili-composer-context"><span><Icon name={needsDesktop ? "lock" : waitingForInput ? "reply" : "laptop"} size={15} /><span data-testid="task-run-status">{taskState}</span></span><div>{waitingForInput && <button type="button" className="chili-answer-action" onClick={() => inputRequests[0] && openQuestion(inputRequests[0].id)} disabled={props.answerDisabled ?? !connected}>回答</button>}<button type="button" data-testid="stop-task" onClick={onStop} disabled={stopDisabled}>{stopping ? "正在停止…" : "停止"}</button></div></div>
              <div className="chili-composer-shell"><label className="chili-visually-hidden" htmlFor="message-input">补充一条指令</label><textarea ref={textareaRef} id="message-input" data-testid="message-input" value={draft} onChange={(event) => onDraftChange(event.target.value)} rows={1} placeholder={placeholder} disabled={inputDisabled} aria-describedby="chili-composer-caption" />
                <div className="chili-composer-actions"><button type="button" className="chili-mode-button" onClick={() => setSheet("mode")} aria-label={`选择发送方式，当前${mode === "queue" ? "排队发送" : "补充当前任务"}`} disabled={!!sending}><Icon name={mode === "queue" ? "queue" : "reply"} size={16} /><span>{mode === "queue" ? "排队发送" : "补充当前任务"}</span><Icon name="chevron-down" size={13} /></button><button type="button" className="chili-send-button" data-testid={mode === "queue" ? "queue-send" : "steer-send"} aria-label={sending ? "正在发送指令" : mode === "queue" ? "排队发送指令" : "发送补充指令"} onClick={() => onSend(mode)} disabled={sendBlocked}>{sending ? <Icon name="refresh" size={20} /> : <Icon name="arrow-up" size={21} />}</button></div>
              </div>
              <p className={`chili-composer-caption ${byteLength > MAX_PROMPT_BYTES ? "is-error" : ""}`} id="chili-composer-caption">{byteLength > MAX_PROMPT_BYTES ? "内容太长，请缩短后发送" : !connected ? "连接恢复后可发送 · 草稿已保留" : sending ? "正在等待电脑确认收到" : "由你的电脑执行"}</p>
            </footer> : <footer className="chili-history-footer"><span data-testid="task-run-status">{task?.status === "archived" ? "此任务已归档，仅供查看" : taskState}</span></footer>}
          </>}
        </section>
      </div>

      <Sheet open={sheet === "mode"} onClose={() => setSheet(null)} title="这条指令如何处理">
        <p className="chili-sheet-intro">选择这条指令如何加入当前工作。</p>
        {(["queue", "steer"] as const).map((choice) => <button type="button" className="chili-sheet-option" key={choice} aria-pressed={mode === choice} onClick={() => { setMode(choice); setSheet(null); }}><Icon name={choice === "queue" ? "queue" : "reply"} /><span><strong>{choice === "queue" ? "排队发送" : "补充当前任务"}</strong><small>{choice === "queue" ? "交给电脑安排后续轮次处理。" : "把新的要求补充给当前任务。"}</small></span>{mode === choice && <Icon name="check" size={18} />}</button>)}
        <p className="chili-sheet-footer">发送后先确认电脑是否收到，再查看执行进展。</p>
      </Sheet>
      <Sheet open={sheet === "menu"} onClose={() => setSheet(null)} title="当前任务">
        <p className="chili-sheet-intro">{task?.title || "未命名任务"}</p>
        <button type="button" className="chili-sheet-option" onClick={openDevice}><Icon name="laptop" /><span><strong>查看电脑连接</strong><small>{computerLabel} · {connectionLabel}</small></span><Icon name="chevron-right" size={17} /></button>
        <button type="button" className="chili-sheet-option" onClick={onRefresh} disabled={!connected}><Icon name="refresh" /><span><strong>刷新任务</strong><small>重新读取电脑上的最新内容</small></span></button>
        {inputRequests.map((request) => <button type="button" className="chili-sheet-option" key={request.id} onClick={() => openQuestion(request.id)}><Icon name="reply" /><span><strong>查看待回答问题</strong><small>{request.questions[0]?.question}</small></span><Icon name="chevron-right" size={17} /></button>)}
        {controllable && <button type="button" className="chili-sheet-option is-danger" onClick={() => { setSheet(null); onStop(); }} disabled={stopDisabled}><Icon name="stop" /><span><strong>{stopping ? "正在停止…" : "停止当前工作"}</strong><small>向电脑请求停止这项任务</small></span></button>}
      </Sheet>
      <Sheet open={sheet === "forget"} onClose={() => setSheet(null)} title="忘记这台电脑？">
        <p className="chili-sheet-intro">移除这台设备上的连接记录。下次使用需要重新配对；待核对的指令提醒会继续保留。</p>
        <div className="chili-sheet-actions"><button type="button" className="chili-primary-button is-danger" data-testid="forget-device-confirm" disabled={props.forgetDisabled} onClick={() => { setSheet(null); onForget(); }}>忘记并重新配对</button><button type="button" className="chili-secondary-button" onClick={() => setSheet(null)}>取消</button></div>
      </Sheet>
    </div>
  );
}

function shortTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const now = new Date();
  const today = date.toDateString() === now.toDateString();
  return date.toLocaleString("zh-CN", today ? { hour: "2-digit", minute: "2-digit" } : { ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), month: "numeric", day: "numeric" });
}

function fullTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间未知";
}
