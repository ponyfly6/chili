import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BrowserControlClient, parseDeviceRecoveryRecord, type DeviceRecoveryRecord } from "@chili/remote-control/browser";
import { INITIAL_CONTROL_FEEDBACK, promptPreview, reduceControlFeedback, type OrdinaryNotice, type UnknownMutationOutcome } from "./control-feedback.js";
import { OutcomeWarnings } from "./OutcomeWarnings.js";
import { Workspace } from "./Workspace.js";
import { PairingView } from "./PairingView.js";
import { QuestionSheets } from "./QuestionSheets.js";
import { useAppViewport } from "./use-app-viewport.js";
import { clearSubmittedDraft, forgetRememberedTask, readRememberedTask, rememberTask } from "./conversation-state.js";
import { browserOutcomeStore, journaledMutation, OutcomeJournal } from "./outcome-journal.js";
import type { ControlAppPlatform } from "./platform.js";
import {
  canSendPrompt,
  errorCode,
  errorMessage,
  readSendReceipt,
  readStopReceipt,
  readAnswerReceipt,
  recoveryNeedsPairing,
  readTaskList,
  readTaskSnapshot,
  type RemoteSnapshot,
  type RemoteTask,
} from "./view-model.js";

type ConnectionState = "unpaired" | "connected" | "disconnected" | "reconnecting" | "expired" | "closed" | "restoring";
type PairingStatus = "creating_identity" | "waiting_for_desktop" | "approved";

const LIST_POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 2_500;

/** Web credentials stay in memory; the native shell supplies secure device storage. */
export function App({ platform }: { platform?: ControlAppPlatform } = {}) {
  const [client, setClient] = useState<BrowserControlClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("unpaired");
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("我的手机");
  const [computerAddress, setComputerAddress] = useState("");
  const [recoverableDevice, setRecoverableDevice] = useState<DeviceRecoveryRecord | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [booting, setBooting] = useState(true);
  const [journal] = useState(() => new OutcomeJournal(platform?.outcomeStore ?? browserOutcomeStore()));
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
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const draft = selectedId ? drafts.get(selectedId) ?? "" : "";
  const setDraft = useCallback((text: string) => {
    if (!selectedId) return;
    setDrafts((previous) => { const next = new Map(previous); next.set(selectedId, text); return next; });
  }, [selectedId]);
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);
  const pendingRecentTask = useRef<string | null>(null);
  const [sending, setSending] = useState<"queue" | "steer" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"list" | "task">("list");
  const [readRevision, setReadRevision] = useState(0);
  const pairAttempt = useRef<AbortController | null>(null);
  const recoveryAttempt = useRef<AbortController | null>(null);
  const connectionGeneration = useRef(0);
  const retryAttempt = useRef(0);
  const recoveryWrites = useRef<Promise<void>>(Promise.resolve());
  const sendPending = useRef(false);
  const stopPending = useRef(false);
  const answerPending = useRef(false);
  const listReadPending = useRef(false);
  const snapshotReadPending = useRef(false);
  const manualDisconnect = useRef(false);
  const restorePending = useRef(false);
  const activeClientRef = useRef(client);
  activeClientRef.current = client;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => () => {
    connectionGeneration.current += 1;
    pairAttempt.current?.abort();
    recoveryAttempt.current?.abort();
  }, []);

  // Forget must finish after an already-started keychain write, never before it.
  const updateRecoveryStore = useCallback((action: () => Promise<void>) => {
    const operation = recoveryWrites.current.then(action);
    recoveryWrites.current = operation.catch(() => undefined);
    return operation;
  }, []);

  const expireRecovery = useCallback(async () => {
    pendingRecentTask.current = null;
    try { forgetRememberedTask(window.localStorage); } catch { /* Optional navigation storage. */ }
    setConnection("expired");
    setRecoverableDevice(null);
    setNotice({ kind: "error", text: "此设备的授权已失效。请回电脑生成新配对码，再连接一次。" });
    if (platform) {
      setBooting(true);
      try { await updateRecoveryStore(() => platform.recoveryStore.clear()); }
      catch { setNotice({ kind: "error", text: "授权已失效，但本机记录未能清除。请在电脑撤销此设备后重新配对。" }); }
      finally { setBooting(false); }
    }
  }, [platform, setNotice, updateRecoveryStore]);

  useEffect(() => {
    let cancelled = false;
    const generation = connectionGeneration.current;
    void (async () => {
      try {
        const outcomes = await journal.load();
        if (cancelled) return;
        for (const outcome of outcomes) dispatchFeedback({ type: "mutation_unknown", outcome });
        setStorageReady(true);
      } catch {
        if (!cancelled) {
          setStorageReady(false);
          setNotice({ kind: "error", text: "无法读取本机保存的指令提醒。请检查手机存储后重新打开；当前不会发送指令。" });
          setBooting(false);
        }
        return;
      }
      try {
        if (platform) {
          const saved = await platform.recoveryStore.load();
          let record: DeviceRecoveryRecord | null = null;
          try { record = saved ? parseDeviceRecoveryRecord(saved) : null; }
          catch { throw Object.assign(new Error("Invalid saved device"), { code: "recovery_record_invalid" }); }
          if (cancelled) return;
          if (record) {
            setComputerAddress(record.baseUrl);
            setRecoverableDevice(record);
            try { pendingRecentTask.current = readRememberedTask(window.localStorage, record); } catch { /* Fall back to list. */ }
            setConnection("restoring");
            restorePending.current = true;
            const attempt = new AbortController();
            recoveryAttempt.current = attempt;
            try {
              const restored = await BrowserControlClient.resume({ record, platform: platform.createClientPlatform(record.baseUrl), signal: attempt.signal });
              if (cancelled || generation !== connectionGeneration.current || attempt.signal.aborted) { restored.dispose(); return; }
              setClient(restored);
              setConnection(restored.state);
              setNotice({ kind: "success", text: "已重新连接你的电脑。此前未确认的指令仍需核对。" });
            } catch (error) {
              if (!cancelled && generation === connectionGeneration.current && !attempt.signal.aborted) {
                if (recoveryNeedsPairing(error)) await expireRecovery();
                else {
                  setConnection("disconnected");
                  setNotice({ kind: "error", text: errorMessage(error) });
                }
              }
            } finally { if (recoveryAttempt.current === attempt) { recoveryAttempt.current = null; restorePending.current = false; } }
          }
        }
      } catch (error) {
        if (!cancelled && generation === connectionGeneration.current) {
          if (error instanceof SyntaxError || recoveryNeedsPairing(error)) await expireRecovery();
          else setNotice({ kind: "error", text: "未能读取已保存的电脑连接。可以重新配对；待核对的指令提醒仍会保留。" });
        }
      } finally { if (!cancelled) setBooting(false); }
    })();
    return () => { cancelled = true; };
  }, [journal, platform, setNotice, expireRecovery]);

  useEffect(() => {
    if (feedback.unknownOutcomes.length === 0 && !sending && !stopping && !answeringId) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [feedback.unknownOutcomes.length, sending, stopping, answeringId]);

  useEffect(() => {
    if (!client) return;
    setConnection(client.state);
    const unsubscribe = client.onState((state) => {
      setConnection(state);
      if (state === "connected") retryAttempt.current = 0;
      if (state === "expired") {
        setNotice({ kind: "error", text: "桌面授权已失效或被撤销，请重新配对。" });
        setClient(null);
        setTasks([]);
        setSnapshot(null);
        setSelectedId(null);
        setMobilePanel("list");
        setRecoverableDevice(null);
        if (platform) void expireRecovery();
      }
    });
    return () => { unsubscribe(); client.dispose(); };
  }, [client, platform, setNotice, expireRecovery]);

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
        // A remembered id never grants access: validate against the fresh,
        // authorized task list before restoring the conversation.
        if (!selected && pendingRecentTask.current) {
          const recent = pendingRecentTask.current;
          pendingRecentTask.current = null;
          if (result.sessions.some((item) => item.id === recent)) {
            setSelectedId(recent);
            setMobilePanel("task");
          }
        }
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
    setOpenRequestId(null);
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
    if (pairAttempt.current || booting || !storageReady || !pairingCode.trim() || !deviceLabel.trim()) return;
    const attempt = new AbortController();
    connectionGeneration.current += 1;
    const generation = connectionGeneration.current;
    recoveryAttempt.current?.abort();
    pairAttempt.current = attempt;
    setPairingStatus("creating_identity");
    setNotice(null);
    try {
      const paired = await BrowserControlClient.pair({
        ...(platform ? {
          baseUrl: computerAddress.trim(),
          platform: platform.createClientPlatform(computerAddress.trim()),
          rememberDevice: true,
          recoveryStore: { save: async (record: DeviceRecoveryRecord) => {
            if (attempt.signal.aborted || generation !== connectionGeneration.current) throw new Error("Pairing cancelled");
            await updateRecoveryStore(() => platform.recoveryStore.save(record));
            if (attempt.signal.aborted || generation !== connectionGeneration.current) throw new Error("Pairing cancelled");
            setRecoverableDevice(record);
          } },
        } : {}),
        pairingCode: pairingCode.trim(),
        deviceLabel: deviceLabel.trim(),
        signal: attempt.signal,
        onPairingStatus: (status) => { if (!attempt.signal.aborted) setPairingStatus(status); },
      });
      if (attempt.signal.aborted || generation !== connectionGeneration.current) { paired.dispose(); return; }
      setDrafts(new Map());
      pendingRecentTask.current = null;
      try { forgetRememberedTask(window.localStorage); } catch { /* Optional navigation storage. */ }
      setClient(paired);
      manualDisconnect.current = false;
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

  const reconnect = useCallback(async (interactive = true) => {
    if (pairAttempt.current || restorePending.current || client?.state === "reconnecting" || booting) return;
    if (!client && (!platform || !recoverableDevice)) return;
    if (interactive) { setNotice(null); manualDisconnect.current = false; }
    const generation = connectionGeneration.current;
    const attempt = new AbortController();
    recoveryAttempt.current = attempt;
    try {
      if (client) {
        if (client.state !== "connected") await client.reconnect();
      } else if (platform && recoverableDevice) {
        restorePending.current = true;
        setConnection("restoring");
        const restored = await BrowserControlClient.resume({ record: recoverableDevice, platform: platform.createClientPlatform(recoverableDevice.baseUrl), signal: attempt.signal });
        if (generation !== connectionGeneration.current || attempt.signal.aborted) { restored.dispose(); return; }
        setClient(restored);
        setConnection(restored.state);
      }
      if (generation !== connectionGeneration.current || attempt.signal.aborted) return;
      retryAttempt.current = 0;
      setReadRevision((value) => value + 1);
      if (interactive) setNotice({ kind: "success", text: "连接已恢复。此前未确认的指令仍需核对，不会作为新指令重复提交。" });
    } catch (error) {
      if (generation !== connectionGeneration.current || attempt.signal.aborted) return;
      if (!client && recoveryNeedsPairing(error)) await expireRecovery();
      else {
        if (!client) setConnection("disconnected");
        if (interactive) setNotice({ kind: "error", text: errorMessage(error) });
      }
    } finally { if (recoveryAttempt.current === attempt) { recoveryAttempt.current = null; restorePending.current = false; } }
  }, [client, platform, recoverableDevice, booting, setNotice, expireRecovery]);

  useEffect(() => {
    const resume = () => {
      if (!manualDisconnect.current && document.visibilityState !== "hidden") void reconnect(false);
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    const unsubscribe = platform?.onResume?.(resume);
    return () => {
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      unsubscribe?.();
    };
  }, [platform, reconnect]);

  useEffect(() => {
    if (connection !== "disconnected" || manualDisconnect.current || booting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = async () => {
      if (cancelled || manualDisconnect.current) return;
      if (document.visibilityState !== "hidden" && navigator.onLine) await reconnect(false);
      if (!cancelled) timer = setTimeout(() => void retry(), Math.min(30_000, 1_000 * 2 ** Math.min(5, retryAttempt.current++)));
    };
    timer = setTimeout(() => void retry(), Math.min(30_000, 1_000 * 2 ** Math.min(5, retryAttempt.current++)));
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [connection, booting, reconnect]);

  const forget = useCallback(async () => {
    setBooting(true);
    connectionGeneration.current += 1;
    recoveryAttempt.current?.abort();
    pairAttempt.current?.abort();
    manualDisconnect.current = true;
    client?.dispose();
    setClient(null);
    setConnection("unpaired");
    setTasks([]);
    setSnapshot(null);
    setSelectedId(null);
    setDrafts(new Map());
    setOpenRequestId(null);
    pendingRecentTask.current = null;
    try { forgetRememberedTask(window.localStorage); } catch { /* Optional navigation storage. */ }
    setReadError(null);
    setListError(null);
    setMobilePanel("list");
    try {
      if (platform) await updateRecoveryStore(() => platform.recoveryStore.clear());
      setRecoverableDevice(null);
      setNotice({ kind: "success", text: "此设备的连接已清除。重新连接需在电脑确认；待核对的指令提醒仍会保留。" });
    } catch {
      setNotice({ kind: "error", text: "已断开连接，但未能清除本机保存的设备信息。请在电脑撤销此设备后重试。" });
    } finally { setBooting(false); }
  }, [client, platform, setNotice, updateRecoveryStore]);

  const confirmOutcome = async (id: string) => {
    try { await journal.confirm(id); dispatchFeedback({ type: "confirm_unknown", id }); }
    catch { setNotice({ kind: "error", text: "暂时无法清除这条提醒。核对结果仍会保留，请稍后重试。" }); }
  };

  const task = snapshot?.session.id === selectedId ? snapshot.session : tasks.find((candidate) => candidate.id === selectedId);
  const taskControllable = task?.status === "active";

  const send = async (mode: "queue" | "steer") => {
    if (!client || !connected || !storageReady || !selectedId || !taskControllable || !canSendPrompt(draft) || sendPending.current
      || snapshot?.session.id !== selectedId || snapshot.session.needsDesktop.input
      || snapshot.inputRequests.length > 0 || readError) return;
    sendPending.current = true;
    setSending(mode);
    setNotice(null);
    const sessionId = selectedId;
    const text = draft;
    const outcome: UnknownMutationOutcome = {
      id: crypto.randomUUID(),
      sessionId,
      sessionTitle: (snapshot?.session.id === sessionId ? snapshot.session.title : tasks.find((task) => task.id === sessionId)?.title) ?? "未命名任务",
      command: mode === "queue" ? "Queue" : "Steer",
      startedAt: Date.now(),
      promptPreview: promptPreview(text),
    };
    try {
      const queued = await journaledMutation(journal, outcome, () => client.request("session.send", { sessionId, text, mode }), readSendReceipt) === "queued";
      if (activeClientRef.current !== client) return;
      setDrafts((current) => clearSubmittedDraft(current, sessionId, text));
      if (selectedIdRef.current !== sessionId) return;
      setNotice({ kind: "success", text: queued ? "指令已排队，等待任务处理。" : "电脑已收到你的指令。" });
      setReadRevision((value) => value + 1);
    } catch (error) {
      const unknown = errorCode(error) === "outcome_unknown";
      // Preserve an old task's outcome even after selection/connection changes.
      // Ordinary connection and action notices cannot replace this record.
      if (unknown) dispatchFeedback({ type: "mutation_unknown", outcome });
      if (activeClientRef.current !== client) return;
      // An uncertain request is never presented as a safe retry. Remove its
      // unchanged draft so a second tap cannot accidentally enqueue it again.
      if (unknown) setDrafts((current) => clearSubmittedDraft(current, sessionId, text));
      if (selectedIdRef.current !== sessionId) return;
      if (!unknown) setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      sendPending.current = false;
      setSending(null);
    }
  };

  const stop = async () => {
    if (!client || !connected || !storageReady || !selectedId || !taskControllable || stopPending.current) return;
    stopPending.current = true;
    setStopping(true);
    setNotice(null);
    const sessionId = selectedId;
    const outcome: UnknownMutationOutcome = {
      id: crypto.randomUUID(),
      sessionId,
      sessionTitle: (snapshot?.session.id === sessionId ? snapshot.session.title : tasks.find((task) => task.id === sessionId)?.title) ?? "未命名任务",
      command: "Stop",
      startedAt: Date.now(),
    };
    try {
      const interrupted = await journaledMutation(journal, outcome, () => client.request("session.stop", { sessionId }), readStopReceipt);
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      setNotice({ kind: "success", text: interrupted ? "正在停止任务。" : "当前没有运行中的任务。" });
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

  const answerInput = async (inputId: string, answers: Record<string, string[]>) => {
    if (!client || !connected || !storageReady || !selectedId || !taskControllable || answerPending.current || readError
      || snapshot?.session.id !== selectedId || snapshot.session.needsDesktop.input
      || !snapshot.inputRequests.some((request) => request.id === inputId)
      || feedback.unknownOutcomes.some((outcome) => outcome.inputId === inputId && outcome.sessionId === selectedId)) return;
    answerPending.current = true;
    setAnsweringId(inputId);
    setNotice(null);
    const sessionId = selectedId;
    const outcome: UnknownMutationOutcome = {
      id: crypto.randomUUID(), sessionId, sessionTitle: task?.title ?? "未命名任务", command: "Answer", inputId, startedAt: Date.now(),
    };
    try {
      const resolved = await journaledMutation(journal, outcome,
        () => client.request("session.answerInput", { sessionId, inputId, answers }), readAnswerReceipt);
      if (activeClientRef.current !== client || selectedIdRef.current !== sessionId) return;
      setSnapshot((current) => current?.session.id === sessionId
        ? { ...current, inputRequests: current.inputRequests.filter((request) => request.id !== inputId) } : current);
      setOpenRequestId(null);
      setNotice({ kind: "success", text: resolved ? "回答已送达，正在更新任务进展。" : "这条问题已不再等待回答，正在更新任务。" });
      setReadRevision((value) => value + 1);
    } catch (error) {
      if (errorCode(error) === "outcome_unknown") dispatchFeedback({ type: "mutation_unknown", outcome });
      else if (activeClientRef.current === client && selectedIdRef.current === sessionId) setNotice({ kind: "error", text: errorMessage(error) });
    } finally { answerPending.current = false; setAnsweringId(null); }
  };

  const needsDesktop = snapshot?.session.needsDesktop.input;
  const waitingForInput = (snapshot?.inputRequests.length ?? 0) > 0;
  const sendDisabled = !connected || !storageReady || !taskControllable || !snapshot || !!readError || !!sending || !canSendPrompt(draft) || !!needsDesktop || waitingForInput;
  const computerLabel = computerName(recoverableDevice?.baseUrl ?? (platform ? computerAddress : typeof window === "undefined" ? "" : window.location.origin));
  const selectTask = (id: string) => {
    if (!tasks.some((item) => item.id === id)) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setMobilePanel("task");
    setOpenRequestId(null);
    if (platform && recoverableDevice) {
      try { rememberTask(window.localStorage, recoverableDevice, id); } catch { /* Navigation remains available without storage. */ }
    }
  };
  const alerts = notice || feedback.unknownOutcomes.length > 0 ? <>
    {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === "success" ? "status" : "alert"} data-testid="notice">
      <span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
    </div>}
    <OutcomeWarnings outcomes={feedback.unknownOutcomes} onConfirm={(id) => void confirmOutcome(id)} />
  </> : undefined;

  useAppViewport();

  return (
    <div className={`control-app${platform ? " control-app-native" : ""}`}>
      {!client ? <PairingView native={!!platform} booting={booting} storageReady={storageReady}
        pairingStatus={pairingStatus} connection={connection} connectionLabel={connectionLabel(connection, pairingStatus)}
        computerAddress={computerAddress} onComputerAddressChange={setComputerAddress}
        deviceLabel={deviceLabel} onDeviceLabelChange={setDeviceLabel} pairingCode={pairingCode} onPairingCodeChange={setPairingCode}
        recoverableAddress={recoverableDevice?.baseUrl ?? null} onPair={(event) => void pair(event)}
        onReconnect={() => void reconnect()} onForget={() => void forget()} alerts={alerts} /> : <>
        <Workspace tasks={tasks} tasksTruncated={tasksTruncated} listLoaded={listLoaded} selectedId={selectedId}
          snapshot={snapshot?.session.id === selectedId ? snapshot : null} lastRead={lastRead}
          connected={connected} connectionLabel={connectionLabel(connection, pairingStatus)} computerLabel={computerLabel}
          deviceLabel={deviceLabel} remembersDevice={!!platform} listError={listError} readError={readError}
          draft={draft} onDraftChange={setDraft} sending={sending} stopping={stopping}
          sendDisabled={sendDisabled} stopDisabled={!connected || !storageReady || !taskControllable || stopping}
          answerDisabled={!connected || !storageReady || !!readError || !!needsDesktop || !!answeringId}
          onSelectTask={selectTask} onSend={(mode) => void send(mode)} onStop={() => void stop()}
          onRefresh={() => setReadRevision((value) => value + 1)} onReconnect={() => void reconnect()}
          onDisconnect={() => { manualDisconnect.current = true; client.disconnect(); }} onForget={() => void forget()}
          reconnectDisabled={booting || connection === "reconnecting" || connection === "restoring"}
          disconnectDisabled={!connected} forgetDisabled={booting} onOpenQuestion={setOpenRequestId}
          mobilePanel={mobilePanel} onMobilePanelChange={setMobilePanel} alerts={alerts} />
        <QuestionSheets sessionId={selectedId} requests={snapshot?.session.id === selectedId ? snapshot.inputRequests : []}
          openRequestId={openRequestId} onOpenChange={setOpenRequestId}
          disabled={!connected || !storageReady || !taskControllable || !!readError || !!needsDesktop || !!answeringId}
          pendingId={answeringId} unknownInputIds={feedback.unknownOutcomes.filter((outcome) => outcome.sessionId === selectedId && outcome.inputId).map((outcome) => outcome.inputId!)}
          onAnswer={answerInput} />
      </>}
    </div>
  );
}

function computerName(address: string): string {
  try { return new URL(address).hostname || "已连接的电脑"; } catch { return "你的电脑"; }
}

function pairingLabel(status: PairingStatus): string {
  return status === "waiting_for_desktop" ? "等待桌面确认…" : status === "approved" ? "正在建立加密连接…" : "正在准备加密配对…";
}

function connectionLabel(connection: ConnectionState, pairingStatus: PairingStatus | null): string {
  if (pairingStatus) return pairingLabel(pairingStatus);
  switch (connection) {
    case "restoring": return "正在恢复电脑连接…";
    case "connected": return "已安全连接";
    case "reconnecting": return "正在重新连接…";
    case "disconnected": return "连接已断开";
    case "expired": return "授权已失效";
    case "closed": return "连接已关闭";
    default: return "尚未配对";
  }
}
