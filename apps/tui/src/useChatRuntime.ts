import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatSessionView,
  type ChatSessionView,
  type HttpRuntimeClient,
} from "@chili/sdk";
import type { ApprovalId, RuntimeApprovalResolveResult, RuntimeModelConfig, RuntimeSkillMention, SessionId, ThreadId } from "@chili/protocol";
import { useTeamLiveRuntime, type TeamLiveRuntimeState, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "./model-state.js";

export type ChatRequestStatus = "idle" | "pending" | "success" | "error";

export interface ChatRuntimeFeedback {
  status: ChatRequestStatus;
  message: string;
}

export interface ChatRuntimeState extends TeamLiveRuntimeState {
  activeSessionId?: SessionId;
  activeThreadId?: ThreadId;
  chatView: ChatSessionView;
  chatFeedback?: ChatRuntimeFeedback;
  modelCandidates?: readonly ModelCandidate[];
  modelConfig?: RuntimeModelConfig;
  canSubmit: boolean;
  submitBlockedReason?: string;
  submitPrompt: (text: string, options?: ChatSubmitOptions) => Promise<boolean>;
  setRuntimeModel?: (selection: ModelSelection) => Promise<boolean>;
  setRuntimeReasoning?: (level: ReasoningLevel) => Promise<boolean>;
  refreshModelConfig?: () => Promise<void>;
  startNewSession: () => Promise<void>;
  interruptActiveSession: () => Promise<void>;
  approveApproval: (approvalId: ApprovalId) => Promise<void>;
  rejectApproval: (approvalId: ApprovalId) => Promise<void>;
}

export interface ChatSubmitOptions {
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  skillMentions?: readonly RuntimeSkillMention[] | undefined;
}

export interface UseChatRuntimeInput {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
}

export function useChatRuntime(input: UseChatRuntimeInput): ChatRuntimeState {
  const { client, options } = input;
  const teamRuntime = useTeamLiveRuntime(input);
  const [activeSessionId, setActiveSessionId] = useState<SessionId | undefined>(options.sessionId);
  const [activeThreadId, setActiveThreadId] = useState<ThreadId | undefined>(options.threadId);
  const [submitPending, setSubmitPending] = useState(false);
  const [chatFeedback, setChatFeedback] = useState<ChatRuntimeFeedback | undefined>();
  const [modelCandidates, setModelCandidates] = useState<readonly ModelCandidate[]>([]);
  const [modelConfig, setModelConfig] = useState<RuntimeModelConfig | undefined>();
  const requestAbortRefs = useRef(new Set<AbortController>());

  useEffect(() => {
    setActiveSessionId(options.sessionId);
    setActiveThreadId(options.threadId);
  }, [options.sessionId, options.threadId]);

  const chatView = useMemo(() => {
    const request: Parameters<typeof chatSessionView>[1] = { limit: 120, requireSession: true };
    if (activeSessionId) request.sessionId = activeSessionId;
    if (activeThreadId) request.threadId = activeThreadId;
    return chatSessionView(teamRuntime.runtimeView, request);
  }, [activeSessionId, activeThreadId, teamRuntime.revision, teamRuntime.runtimeView]);

  useEffect(() => {
    if (activeSessionId && chatView.sessionId && activeSessionId !== chatView.sessionId) setActiveSessionId(chatView.sessionId);
    if (!activeThreadId && chatView.threadId) setActiveThreadId(chatView.threadId);
  }, [activeSessionId, activeThreadId, chatView.sessionId, chatView.threadId]);

  const running = chatView.status === "running" || chatView.status === "waiting_for_approval";
  const resolvedThreadId = activeThreadId ?? chatView.threadId;
  const resumeThreadMissing = Boolean(activeSessionId && !resolvedThreadId);
  const submitBlockedReason = resumeThreadMissing
    ? "Session resume needs a thread. Pass --thread or wait for history to load."
    : undefined;
  const canSubmit = !submitPending && !running && chatView.pendingApprovals.length === 0 && !submitBlockedReason;

  const withAbort = useCallback(<T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    requestAbortRefs.current.add(controller);
    return run(controller.signal).finally(() => {
      requestAbortRefs.current.delete(controller);
    });
  }, []);

  const refreshModelConfigForSession = useCallback(async (sessionIdOverride?: SessionId): Promise<void> => {
    try {
      await withAbort(async (signal) => {
        const models = await client.listModels();
        if (signal.aborted) return;
        const sessionId = sessionIdOverride ?? activeSessionId ?? chatView.sessionId;
        if (!sessionId) {
          setModelConfig(undefined);
          setModelCandidates(models);
          return;
        }
        const config = await client.getModelConfig({ sessionId, signal });
        if (signal.aborted) return;
        setModelConfig(config);
        setModelCandidates(config.models.length > 0 ? config.models : models);
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
    }
  }, [activeSessionId, chatView.sessionId, client, options.baseUrl, withAbort]);

  const refreshModelConfig = useCallback(async (): Promise<void> => {
    await refreshModelConfigForSession();
  }, [refreshModelConfigForSession]);

  useEffect(() => {
    void refreshModelConfig();
  }, [refreshModelConfig]);

  const ensureSession = useCallback(async (signal: AbortSignal): Promise<{ sessionId: SessionId; threadId: ThreadId }> => {
    let sessionId = activeSessionId ?? chatView.sessionId;
    let threadId = activeThreadId ?? chatView.threadId;
    if (sessionId && !threadId) {
      throw new Error(submitBlockedReason ?? "Session resume needs a thread.");
    }
    if (!sessionId && !threadId) {
      const created = await client.createSession({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal,
      });
      sessionId = created.sessionId;
      threadId = created.threadId;
      setActiveSessionId(sessionId);
      setActiveThreadId(threadId);
    }
    if (!sessionId || !threadId) throw new Error("Unable to determine a session and thread.");
    return { sessionId, threadId };
  }, [activeSessionId, activeThreadId, chatView.sessionId, chatView.threadId, client, options.cwd, submitBlockedReason]);

  const submitPrompt = useCallback(async (text: string, submitOptions: ChatSubmitOptions = {}): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || submitPending || running || chatView.pendingApprovals.length > 0) return false;
    if (resumeThreadMissing) {
      setChatFeedback({ status: "error", message: submitBlockedReason ?? "Session resume needs a thread." });
      return false;
    }
    setSubmitPending(true);
    setChatFeedback({ status: "pending", message: "sending prompt" });
    try {
      await withAbort(async (signal) => {
        let sessionId = activeSessionId ?? chatView.sessionId;
        let threadId = activeThreadId ?? chatView.threadId;
        if (sessionId && !threadId) {
          throw new Error(submitBlockedReason ?? "Session resume needs a thread.");
        }
        if (!sessionId && !threadId) {
          const created = await client.createSession({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            signal,
          });
          sessionId = created.sessionId;
          threadId = created.threadId;
          setActiveSessionId(sessionId);
          setActiveThreadId(threadId);
        }
        if (!sessionId || !threadId) {
          throw new Error("Unable to determine a session and thread for this prompt.");
        }
        const request = {
          sessionId,
          threadId,
          text: trimmed,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(submitOptions.modelSelection ? { modelSelection: submitOptions.modelSelection } : {}),
          ...(submitOptions.reasoningLevel ? { reasoningLevel: submitOptions.reasoningLevel } : {}),
          ...(submitOptions.skillMentions && submitOptions.skillMentions.length > 0 ? { skillMentions: [...submitOptions.skillMentions] } : {}),
          signal,
        };
        await client.submitPromptAsync(request);
      });
      setChatFeedback({ status: "success", message: "prompt accepted" });
      return true;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return false;
    } finally {
      setSubmitPending(false);
    }
  }, [activeSessionId, activeThreadId, chatView.pendingApprovals.length, chatView.sessionId, chatView.threadId, client, options.baseUrl, options.cwd, resumeThreadMissing, running, submitBlockedReason, submitPending, withAbort]);

  const setRuntimeModel = useCallback(async (selection: ModelSelection): Promise<boolean> => {
    let updatedSessionId: SessionId | undefined;
    try {
      await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        updatedSessionId = session.sessionId;
        await client.setModel({
          ...session,
          modelSelection: selection,
          signal,
        });
      });
      setChatFeedback({ status: "success", message: "model selected" });
      await refreshModelConfigForSession(updatedSessionId);
      return true;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return false;
    }
  }, [client, ensureSession, options.baseUrl, refreshModelConfigForSession, withAbort]);

  const setRuntimeReasoning = useCallback(async (level: ReasoningLevel): Promise<boolean> => {
    let updatedSessionId: SessionId | undefined;
    try {
      await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        updatedSessionId = session.sessionId;
        await client.setReasoning({
          ...session,
          reasoningLevel: level,
          signal,
        });
      });
      setChatFeedback({ status: "success", message: "thinking level selected" });
      await refreshModelConfigForSession(updatedSessionId);
      return true;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return false;
    }
  }, [client, ensureSession, options.baseUrl, refreshModelConfigForSession, withAbort]);

  const interruptActiveSession = useCallback(async () => {
    if (!activeSessionId) return;
    setChatFeedback({ status: "pending", message: "interrupting session" });
    try {
      await withAbort((signal) => client.interruptSession({
        sessionId: activeSessionId,
        reason: "Interrupted from TUI",
        signal,
      }));
      setChatFeedback({ status: "success", message: "interrupt sent" });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: toError(error).message });
    }
  }, [activeSessionId, client, withAbort]);

  const startNewSession = useCallback(async () => {
    for (const controller of requestAbortRefs.current) controller.abort();
    requestAbortRefs.current.clear();
    setSubmitPending(false);
    setChatFeedback(undefined);
    setActiveSessionId(undefined);
    setActiveThreadId(undefined);
    try {
      const created = await withAbort((signal) => client.createSession({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal,
      }));
      setActiveSessionId(created.sessionId);
      setActiveThreadId(created.threadId);
      setChatFeedback(undefined);
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
    }
  }, [client, options.baseUrl, options.cwd, withAbort]);

  const approveApproval = useCallback(async (approvalId: ApprovalId) => {
    await resolveApproval("approve", approvalId, client, withAbort, setChatFeedback);
  }, [client, withAbort]);

  const rejectApproval = useCallback(async (approvalId: ApprovalId) => {
    await resolveApproval("reject", approvalId, client, withAbort, setChatFeedback);
  }, [client, withAbort]);

  useEffect(() => () => {
    for (const controller of requestAbortRefs.current) controller.abort();
    requestAbortRefs.current.clear();
  }, []);

  return useMemo(() => ({
    ...teamRuntime,
    ...(activeSessionId ? { activeSessionId } : {}),
    ...(activeThreadId ? { activeThreadId } : {}),
    chatView,
    ...(chatFeedback ? { chatFeedback } : {}),
    modelCandidates,
    ...(modelConfig ? { modelConfig } : {}),
    canSubmit,
    ...(submitBlockedReason ? { submitBlockedReason } : {}),
    submitPrompt,
    setRuntimeModel,
    setRuntimeReasoning,
    refreshModelConfig,
    startNewSession,
    interruptActiveSession,
    approveApproval,
    rejectApproval,
  }), [activeSessionId, activeThreadId, canSubmit, chatFeedback, chatView, interruptActiveSession, approveApproval, rejectApproval, modelCandidates, modelConfig, refreshModelConfig, setRuntimeModel, setRuntimeReasoning, startNewSession, submitBlockedReason, submitPrompt, teamRuntime]);
}

async function resolveApproval(
  action: "approve" | "reject",
  approvalId: ApprovalId,
  client: HttpRuntimeClient,
  withAbort: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  setFeedback: (feedback: ChatRuntimeFeedback | undefined) => void,
): Promise<void> {
  setFeedback({ status: "pending", message: action === "approve" ? "approving request" : "rejecting request" });
  try {
    const result = await withAbort((signal) => action === "approve"
      ? client.approveApproval({ approvalId, signal })
      : client.rejectApproval({ approvalId, feedback: "Rejected from TUI", signal }));
    requireResolvedApproval(result);
    setFeedback({ status: "success", message: action === "approve" ? "approval allowed" : "approval rejected" });
  } catch (error) {
    if (!isAbortError(error)) setFeedback({ status: "error", message: toError(error).message });
  }
}

function requireResolvedApproval(result: RuntimeApprovalResolveResult): void {
  if (!result.resolved) {
    throw new Error("Approval is no longer pending in this runtime. Reconnect or start a fresh prompt.");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function runtimeErrorMessage(error: unknown, baseUrl: string): string {
  const message = toError(error).message;
  if (/unable to connect|fetch failed|econnrefused|connection refused/i.test(message)) {
    return `Runtime offline at ${baseUrl}. Start serve or check --url.`;
  }
  return message;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
