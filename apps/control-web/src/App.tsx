import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BrowserControlClient } from "@chili/remote-control/browser";
import { INITIAL_CONTROL_FEEDBACK, promptPreview, reduceControlFeedback, type OrdinaryNotice, type UnknownMutationOutcome } from "./control-feedback.js";
import { OutcomeWarnings } from "./OutcomeWarnings.js";
import {
  MAX_PROMPT_BYTES,
  canSendPrompt,
  errorCode,
  errorMessage,
  promptByteLength,
  readSendReceipt,
  readStopReceipt,
  readTaskList,
  readTaskSnapshot,
  runStatusLabel,
  visibleMobilePanel,
  type RemoteSnapshot,
  type RemoteTask,
} from "./view-model.js";

type ConnectionState = "unpaired" | "connected" | "disconnected" | "reconnecting" | "expired" | "closed";
type PairingStatus = "creating_identity" | "waiting_for_desktop" | "approved";

const LIST_POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 2_500;

/** The complete authorization and replay stream lives in this page's memory. */
export function App() {
  const [client, setClient] = useState<BrowserControlClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("unpaired");
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("我的手机");
  const [feedback, dispatchFeedback] = useReducer(reduceControlFeedback, INITIAL_CONTROL_FEEDBACK);
  const notice = feedback.notice;
  const setNotice = useCallback((value: OrdinaryNotice | null) => dispatchFeedback({ type: "notice", notice: value }), []);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [tasksTruncated, setTasksTruncated] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [lastRead, setLastRead] = useState<Date | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<"queue" | "steer" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"list" | "task">("list");
  const [readRevision, setReadRevision] = useState(0);
  const pairAttempt = useRef<AbortController | null>(null);
  const sendPending = useRef(false);
  const stopPending = useRef(false);
  const listReadPending = useRef(false);
  const snapshotReadPending = useRef(false);
  const mutationCounter = useRef(0);
  const activeClientRef = useRef(client);
  activeClientRef.current = client;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => () => pairAttempt.current?.abort(), []);

  useEffect(() => {
    if (feedback.unknownOutcomes.length === 0) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [feedback.unknownOutcomes.length]);

  useEffect(() => {
    if (!client) return;
    setConnection(client.state);
    const unsubscribe = client.onState((state) => {
      setConnection(state);
      if (state === "expired") {
        setNotice({ kind: "error", text: "桌面授权已失效或被撤销，请重新配对。" });
        setClient(null);
        setTasks([]);
        setSnapshot(null);
        setSelectedId(null);
        setMobilePanel("list");
      }
    });
    return () => { unsubscribe(); client.dispose(); };
  }, [client, setNotice]);

  const connected = connection === "connected";

  // Each lane has at most one read in flight. Timer-after-settle polling avoids
  // backlogs. Neither reading lane owns either mutation lock, so a slow read
  // cannot disable Stop or delay its browser request until a result arrives.
  useEffect(() => {
    if (!client || !connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (listReadPending.current) { timer = setTimeout(() => void poll(), 500); return; }
      listReadPending.current = true;
      try {
        const result = readTaskList(await client.request("sessions.list", { status: "active" }));
        if (cancelled) return;
        setTasks(result.sessions);
        setTasksTruncated(result.truncated);
        setListLoaded(true);
        setListError(null);
        const selected = selectedIdRef.current;
        if (selected && !result.sessions.some((task) => task.id === selected)) {
          setSelectedId(null);
          setSnapshot(null);
          setMobilePanel("list");
          setNotice({ kind: "error", text: "此任务已不在当前工作区的可访问列表中，请回桌面查看。" });
        }
      } catch (error) {
        if (!cancelled) setListError(errorMessage(error));
      } finally {
        listReadPending.current = false;
        if (!cancelled) timer = setTimeout(() => void poll(), LIST_POLL_MS);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [client, connected, readRevision]);

  useEffect(() => {
    setSnapshot(null);
    setLastRead(null);
    setDraft("");
    setReadError(null);
  }, [selectedId]);

  useEffect(() => {
    if (!client || !connected || !selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (snapshotReadPending.current) { timer = setTimeout(() => void poll(), 500); return; }
      snapshotReadPending.current = true;
      try {
        const result = readTaskSnapshot(await client.request("session.snapshot", { sessionId: selectedId }));
        if (cancelled) return;
        if (result.session.id !== selectedId) throw Object.assign(new Error("Wrong session"), { code: "invalid_response" });
        setSnapshot(result);
        setLastRead(new Date());
        setReadError(null);
      } catch (error) {
        if (!cancelled) setReadError(errorMessage(error));
      } finally {
        snapshotReadPending.current = false;
        if (!cancelled) timer = setTimeout(() => void poll(), SNAPSHOT_POLL_MS);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [client, connected, selectedId, readRevision]);

  const pair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pairAttempt.current || !pairingCode.trim() || !deviceLabel.trim()) return;
    const attempt = new AbortController();
    pairAttempt.current = attempt;
    setPairingStatus("creating_identity");
    setNotice(null);
    try {
      const paired = await BrowserControlClient.pair({
        pairingCode: pairingCode.trim(),
        deviceLabel: deviceLabel.trim(),
        signal: attempt.signal,
        onPairingStatus: (status) => { if (!attempt.signal.aborted) setPairingStatus(status); },
      });
      if (attempt.signal.aborted) { paired.dispose(); return; }
      setClient(paired);
      setConnection(paired.state);
      setSelectedId(null);
      setSnapshot(null);
      setMobilePanel("list");
      setPairingCode("");
      setListLoaded(false);
      setListError(null);
      setReadError(null);
      setNotice({ kind: "success", text: "配对已通过桌面确认。现在可以控制当前工作区的既有任务。" });
    } catch (error) {
      if (!attempt.signal.aborted) setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      if (pairAttempt.current === attempt) {
        pairAttempt.current = null;
        setPairingStatus(null);
      }
    }
  };

  const reconnect = async () => {
    if (!client || connection === "reconnecting") return;
    setNotice(null);
    try {
      await client.reconnect();
      setReadRevision((value) => value + 1);
      setNotice({ kind: "success", text: "连接已恢复并同步请求序号。重连不会把旧请求作为新指令再次执行。" });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  };

  const forget = useCallback(() => {
    client?.dispose();
    setClient(null);
    setConnection("unpaired");
    setTasks([]);
    setSnapshot(null);
    setSelectedId(null);
    setDraft("");
    setReadError(null);
    setListError(null);
    setMobilePanel("list");
    setNotice({ kind: "success", text: "本页的授权已清除。如需再次连接，请回桌面生成新的配对码。设备也可在桌面撤销。" });
  }, [client, setNotice]);

  const task = snapshot?.session.id === selectedId ? snapshot.session : tasks.find((candidate) => candidate.id === selectedId);
  const taskControllable = task?.status === "active" && !task.readOnly;

  const send = async (mode: "queue" | "steer") => {
    if (!client || !connected || !selectedId || !taskControllable || !canSendPrompt(draft) || sendPending.current) return;
    sendPending.current = true;
    setSending(mode);
    setNotice(null);
    const sessionId = selectedId;
    const text = draft;
    const outcome: UnknownMutationOutcome = {
      id: String(++mutationCounter.current),
      sessionId,
      sessionTitle: (snapshot?.session.id === sessionId ? snapshot.session.title : tasks.find((task) => task.id === sessionId)?.title) ?? "未命名任务",
      command: mode === "queue" ? "Queue" : "Steer",
      startedAt: Date.now(),
      promptPreview: promptPreview(text),
    };
    try {
      const result = await client.request("session.send", { sessionId, text, mode });
      const queued = readSendReceipt(result) === "queued";
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      setDraft((current) => current === text ? "" : current);
      setNotice({ kind: "success", text: queued ? "Queue 已入队，等待任务处理。" : `${mode === "queue" ? "Queue" : "Steer"} 请求已由桌面接受。` });
      setReadRevision((value) => value + 1);
    } catch (error) {
      const unknown = errorCode(error) === "outcome_unknown";
      // Preserve an old task's outcome even after selection/connection changes.
      // Ordinary connection and action notices cannot replace this record.
      if (unknown) dispatchFeedback({ type: "mutation_unknown", outcome });
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      // An uncertain request is never presented as a safe retry. Remove its
      // unchanged draft so a second tap cannot accidentally enqueue it again.
      if (unknown) setDraft((current) => current === text ? "" : current);
      if (!unknown) setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      sendPending.current = false;
      setSending(null);
    }
  };

  const stop = async () => {
    if (!client || !connected || !selectedId || !taskControllable || stopPending.current) return;
    stopPending.current = true;
    setStopping(true);
    setNotice(null);
    const sessionId = selectedId;
    const outcome: UnknownMutationOutcome = {
      id: String(++mutationCounter.current),
      sessionId,
      sessionTitle: (snapshot?.session.id === sessionId ? snapshot.session.title : tasks.find((task) => task.id === sessionId)?.title) ?? "未命名任务",
      command: "Stop",
      startedAt: Date.now(),
    };
    try {
      const result = await client.request("session.stop", { sessionId });
      const interrupted = readStopReceipt(result);
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      setNotice({ kind: "success", text: interrupted ? "Stop 已由桌面接受，正在停止任务。" : "Stop 已处理，当前没有运行中的任务。" });
      setReadRevision((value) => value + 1);
    } catch (error) {
      const unknown = errorCode(error) === "outcome_unknown";
      if (unknown) dispatchFeedback({ type: "mutation_unknown", outcome });
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      if (!unknown) setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      stopPending.current = false;
      setStopping(false);
    }
  };

  const needsDesktop = snapshot?.session.needsDesktop.approval || snapshot?.session.needsDesktop.input;
  const sendDisabled = !connected || !selectedId || !!sending || !canSendPrompt(draft) || !!needsDesktop;
  const byteLength = promptByteLength(draft);

  return (
    <div className="control-app">
      <header className="site-header">
        <div className="brand" aria-label="Chili 私网控制">
          <span className="brand-mark" aria-hidden="true">c<span>·</span></span>
          <span>Chili <span className="brand-product">Control</span></span>
        </div>
        <span className="alpha-badge">私网 Alpha</span>
      </header>

      <main>
        <section className="connection-bar" aria-label="连接状态">
          <div className="connection-summary" role="status" data-testid="connection-status">
            <span className={`status-dot ${connected ? "is-connected" : ""}`} aria-hidden="true" />
            <strong>{connectionLabel(connection, pairingStatus)}</strong>
          </div>
          {client ? (
            <div className="connection-actions">
              <button type="button" className="text-button" data-testid="reconnect" onClick={() => void reconnect()} disabled={connection === "reconnecting"}>重新连接</button>
              {connected && <button type="button" className="text-button" data-testid="disconnect" onClick={() => client.disconnect()}>断开</button>}
              {!connected && <button type="button" className="text-button" data-testid="forget-device" onClick={forget}>重新配对</button>}
            </div>
          ) : <span className="connection-note">端到端加密 · 仅限当前工作区</span>}
        </section>

        {notice && (
          <div className={`notice notice-${notice.kind}`} role={notice.kind === "success" ? "status" : "alert"} data-testid="notice">
            <span>{notice.text}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
          </div>
        )}

        <OutcomeWarnings outcomes={feedback.unknownOutcomes} onConfirm={(id) => dispatchFeedback({ type: "confirm_unknown", id })} />

        {!client ? (
          <section className="pairing-layout">
            <div className="pairing-intro">
              <div className="eyebrow">YOUR DESKTOP, WITHIN REACH</div>
              <h1>离开桌面，<br />任务仍在掌握。</h1>
              <p>连接正在运行的 Chili 桌面，查看进展、补充指令，或停止当前任务。</p>
              <div className="scope-note"><span aria-hidden="true">↳</span><span>只控制当前工作区的既有任务。<br />审批、提问、权限与新建任务，请回桌面处理。</span></div>
            </div>
            <form className="pairing-card" onSubmit={(event) => void pair(event)}>
              <span className="step-label">01 / 配对你的手机</span>
              <h2>从桌面获取配对码</h2>
              <p className="muted">在 Chili 桌面开启私网控制，并生成一次性短期配对码。提交后仍需在桌面本地确认。</p>
              <label htmlFor="device-label">设备名称</label>
              <input id="device-label" name="device-label" data-testid="device-label" value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} maxLength={64} autoComplete="off" spellCheck={false} required disabled={!!pairingStatus} />
              <label htmlFor="pairing-code">一次性配对码</label>
              <input id="pairing-code" name="pairing-code" className="pairing-code" data-testid="pairing-code" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="输入桌面显示的配对码" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} required disabled={!!pairingStatus} />
              <button className="primary-button pair-submit" type="submit" data-testid="pair-submit" disabled={!!pairingStatus || !pairingCode.trim() || !deviceLabel.trim()}>
                {pairingStatus ? pairingLabel(pairingStatus) : "安全配对"}<span aria-hidden="true">↗</span>
              </button>
              {pairingStatus === "waiting_for_desktop" && <p className="pairing-wait" role="status" data-testid="pairing-wait">请回桌面核对设备名称，并确认本次配对。手机不能自行批准。</p>}
              <div className="session-warning" data-testid="refresh-warning"><strong>刷新后需要重新配对</strong><span>授权和请求序号仅保存在本页内存。刷新、关闭页面或桌面重启后，请重新生成配对码；不会恢复旧授权。</span></div>
            </form>
          </section>
        ) : (
          <>
            <div className="workspace-heading"><div><div className="eyebrow">CONNECTED WORKSPACE</div><h1>你的任务</h1></div><span className="read-only-note">既有任务 · 桌面与手机同步</span></div>
            {(listError || readError) && <div className="read-error global-read-error" role="alert">{readError ?? listError}</div>}
            <div className={`workspace mobile-${visibleMobilePanel(mobilePanel, selectedId)}`}>
              <aside className="task-sidebar" aria-label="任务列表" data-testid="task-list">
                <div className="panel-heading"><h2>任务列表</h2><span className="count">{tasks.length}</span></div>
                {!listLoaded && <div className="empty compact" role="status">正在读取桌面任务…</div>}
                {listLoaded && tasks.length === 0 && <div className="empty compact"><strong>暂时没有可访问的任务</strong><p>请先在当前桌面工作区创建任务。手机不能新建任务。</p></div>}
                <ul>
                  {tasks.map((item) => <li key={item.id}><button type="button" className={`task-item ${item.id === selectedId ? "selected" : ""}`} data-testid={`task-item-${item.id}`} aria-pressed={item.id === selectedId} onClick={() => { setSelectedId(item.id); setMobilePanel("task"); }}><span className="task-item-title">{item.title || "未命名任务"}</span><span className="task-item-meta"><span>{item.id === snapshot?.session.id ? runStatusLabel(snapshot.session.runStatus) : "既有任务"}</span><span aria-hidden="true">↗</span></span></button></li>)}
                </ul>
                {tasksTruncated && <p className="limit-note">仅显示部分任务，请在桌面查看完整列表。</p>}
                <p className="sidebar-footnote">不会显示子智能体内部任务。<br />切换工作区将使手机授权失效。</p>
              </aside>

              <section className="task-panel" aria-label="当前任务">
                {!selectedId ? <div className="empty choose-task"><span aria-hidden="true">↖</span><h2>选择一个既有任务</h2><p>查看最近消息，并向桌面发送 Queue、Steer 或 Stop。</p></div> : <>
                  <header className="task-heading">
                    <button type="button" className="back-button" aria-label="返回任务列表" onClick={() => setMobilePanel("list")}>← 任务</button>
                    <div className="task-title"><h2>{task?.title || "正在读取任务…"}</h2><div className="task-state"><span className={`run-badge ${snapshot?.session.runStatus === "running" ? "running" : ""}`} data-testid="task-run-status">{snapshot ? runStatusLabel(snapshot.session.runStatus) : "读取中"}</span>{snapshot && snapshot.session.queuedCount > 0 && <span data-testid="queued-count">{snapshot.session.queuedCount} 条排队中</span>}<span className="last-read">{lastRead ? `${connected ? "更新于" : "上次读取"} ${lastRead.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</span></div></div>
                    <button type="button" className="refresh-button" aria-label="刷新任务" onClick={() => setReadRevision((value) => value + 1)} disabled={!connected}>↻</button>
                  </header>
                  {needsDesktop && <div className="desktop-needed" role="status" data-testid="needs-desktop"><strong>请回桌面处理</strong><p>{snapshot?.session.needsDesktop.approval ? "任务正在等待审批。手机不能批准或修改权限。" : "任务正在等待你的回答。请在桌面完成提问流程。"}</p></div>}
                  {snapshot?.session.deliveryUnknown && <div className="desktop-needed" role="alert" data-testid="delivery-unknown"><strong>排队消息的执行结果未知</strong><p>可能已经执行，请先读取任务或回桌面核对，不要直接重发。Stop 仍可使用。</p></div>}
                  {!connected && <div className="stale-warning" role="status">当前显示上次读取的内容。连接恢复前无法发送指令。</div>}
                  <div className="transcript" data-testid="transcript" aria-label="最近消息" aria-busy={connected && !snapshot}>
                    {!snapshot && <div className="empty compact">正在读取最近消息…</div>}
                    {snapshot && snapshot.messages.length === 0 && <div className="empty compact">暂无可显示的用户或助手消息。工具输出和内部事件不会在手机显示。</div>}
                    {snapshot?.truncated && <p className="limit-note">已省略部分较早或较长的内容。完整记录请回桌面查看。</p>}
                    {snapshot?.messages.map((message) => <article className={`message message-${message.role}`} key={message.id}><div className="message-heading"><strong>{message.role === "user" ? "你" : "Chili"}</strong><span>{formatMessageTime(message.createdAt)}</span></div><p>{message.text}</p></article>)}
                  </div>
                  {!taskControllable ? <p className="limit-note">此会话仅供查看历史。</p> : <section className="composer" aria-label="任务控制">
                    <label htmlFor="message-input">补充一条指令</label>
                    <textarea id="message-input" data-testid="message-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={needsDesktop ? "请先回桌面处理待审批或提问" : "让 Chili 接下来做什么？"} rows={3} disabled={!connected || !!needsDesktop} aria-describedby="composer-help composer-bytes" />
                    <div className="composer-help"><span id="composer-help">Queue 排队执行 · Steer 引导当前任务</span><span id="composer-bytes" className={byteLength > MAX_PROMPT_BYTES ? "over-limit" : ""}>{byteLength.toLocaleString()} / {MAX_PROMPT_BYTES.toLocaleString()} B</span></div>
                    <div className="composer-actions"><button type="button" className="secondary-button" data-testid="queue-send" disabled={sendDisabled} onClick={() => void send("queue")}>{sending === "queue" ? "正在发送…" : "Queue"}</button><button type="button" className="primary-button" data-testid="steer-send" disabled={sendDisabled} onClick={() => void send("steer")}>{sending === "steer" ? "正在发送…" : "Steer"}<span aria-hidden="true">↗</span></button><button type="button" className="stop-button" data-testid="stop-task" disabled={!connected || stopping} onClick={() => void stop()}><span aria-hidden="true">■</span>{stopping ? "停止中…" : "Stop"}</button></div>
                  </section>}
                </>}
              </section>
            </div>
            <footer className="page-footer"><span data-testid="refresh-warning">刷新或关闭此页后需要重新配对。</span><button type="button" className="text-button" onClick={forget}>清除此页授权</button></footer>
          </>
        )}
      </main>
    </div>
  );
}

function pairingLabel(status: PairingStatus): string {
  return status === "waiting_for_desktop" ? "等待桌面确认…" : status === "approved" ? "正在建立加密连接…" : "正在准备加密配对…";
}

function connectionLabel(connection: ConnectionState, pairingStatus: PairingStatus | null): string {
  if (pairingStatus) return pairingLabel(pairingStatus);
  switch (connection) {
    case "connected": return "已安全连接";
    case "reconnecting": return "正在重新连接…";
    case "disconnected": return "连接已断开";
    case "expired": return "授权已失效";
    case "closed": return "连接已关闭";
    default: return "尚未配对";
  }
}

function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
