import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatSessionView,
  type ChatSessionView,
  type HttpRuntimeClient,
} from "@chili/sdk";
import type {
  ApprovalId,
  RuntimeApprovalResolveResult,
  RuntimeMcpAddServerRequest,
  RuntimeMcpAuthRequest,
  RuntimeMcpAuthResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  RuntimeModelConfig,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimePromptCommandList,
  RuntimeSkillMention,
  SessionId,
  ThreadGoal,
  ThreadId,
} from "@chili/protocol";
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
  permissionConfig?: RuntimePermissionConfig;
  commandList?: RuntimePromptCommandList;
  mcpStatus?: RuntimeMcpStatusResponse;
  canSubmit: boolean;
  submitBlockedReason?: string;
  submitPrompt: (text: string, options?: ChatSubmitOptions) => Promise<boolean>;
  submitCommand: (name: string, args: string, options?: ChatCommandSubmitOptions) => Promise<boolean>;
  setRuntimeModel?: (selection: ModelSelection) => Promise<boolean>;
  setRuntimeReasoning?: (level: ReasoningLevel) => Promise<boolean>;
  refreshModelConfig?: () => Promise<void>;
  refreshPermissionConfig?: () => Promise<void>;
  reloadCommands?: () => Promise<RuntimePromptCommandList | undefined>;
  refreshMcpStatus?: () => Promise<RuntimeMcpStatusResponse | undefined>;
  getMcpServer?: (server: string) => Promise<RuntimeMcpServerDescriptor | undefined>;
  reloadMcp?: () => Promise<RuntimeMcpReloadResponse | undefined>;
  addMcpServer?: (input: RuntimeMcpAddServerRequest) => Promise<RuntimeMcpServerDescriptor | undefined>;
  removeMcpServer?: (server: string) => Promise<RuntimeMcpRemoveServerResponse | undefined>;
  listMcpTools?: (server: string) => Promise<RuntimeMcpToolsResponse | undefined>;
  authMcpServer?: (server: string, request?: RuntimeMcpAuthRequest) => Promise<RuntimeMcpAuthResponse | undefined>;
  logoutMcpServer?: (server: string) => Promise<RuntimeMcpLogoutResponse | undefined>;
  setRuntimePermissionProfile?: (profile: RuntimePermissionProfileId) => Promise<boolean>;
  setGoal: (input: { objective: string; tokenBudget?: number }) => Promise<ThreadGoal | undefined>;
  pauseGoal: () => Promise<ThreadGoal | undefined>;
  resumeGoal: () => Promise<ThreadGoal | undefined>;
  clearGoal: () => Promise<boolean>;
  startNewSession: () => Promise<void>;
  interruptActiveSession: () => Promise<void>;
  approveApproval: (approvalId: ApprovalId, options?: ChatApproveOptions) => Promise<void>;
  rejectApproval: (approvalId: ApprovalId) => Promise<void>;
}

export interface ChatSubmitOptions {
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  skillMentions?: readonly RuntimeSkillMention[] | undefined;
}

export interface ChatCommandSubmitOptions {
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
}

export type ChatApprovalGrantScope = "once" | "session" | "persistent";

export interface ChatApproveOptions {
  scope?: ChatApprovalGrantScope | undefined;
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
  const [permissionConfig, setPermissionConfig] = useState<RuntimePermissionConfig | undefined>();
  const [commandList, setCommandList] = useState<RuntimePromptCommandList | undefined>();
  const [mcpStatus, setMcpStatus] = useState<RuntimeMcpStatusResponse | undefined>();
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

  const refreshPermissionConfig = useCallback(async (): Promise<void> => {
    try {
      await withAbort(async (signal) => {
        const config = await client.getPermissionConfig({ signal });
        if (!signal.aborted) setPermissionConfig(config);
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
    }
  }, [client, options.baseUrl, withAbort]);

  useEffect(() => {
    void refreshPermissionConfig();
  }, [refreshPermissionConfig]);

  const refreshCommands = useCallback(async (): Promise<RuntimePromptCommandList | undefined> => {
    try {
      return await withAbort(async (signal) => {
        const commands = await client.listCommands({ signal });
        if (!signal.aborted) setCommandList(commands);
        return commands;
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  useEffect(() => {
    void refreshCommands();
  }, [refreshCommands]);

  const reloadCommands = useCallback(async (): Promise<RuntimePromptCommandList | undefined> => {
    try {
      return await withAbort(async (signal) => {
        const commands = await client.reloadCommands({ signal });
        if (!signal.aborted) setCommandList(commands);
        return commands;
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const refreshMcpStatus = useCallback(async (): Promise<RuntimeMcpStatusResponse | undefined> => {
    try {
      return await withAbort(async (signal) => {
        const status = await client.mcpStatus({ signal });
        if (!signal.aborted) setMcpStatus(status);
        return status;
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const getMcpServer = useCallback(async (server: string): Promise<RuntimeMcpServerDescriptor | undefined> => {
    try {
      return await withAbort(async (signal) => {
        const descriptor = await client.mcpServer({ server, signal });
        if (!signal.aborted) setMcpStatus((current) => upsertMcpServer(current, descriptor));
        return descriptor;
      });
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const reloadMcp = useCallback(async (): Promise<RuntimeMcpReloadResponse | undefined> => {
    setChatFeedback({ status: "pending", message: "reloading MCP" });
    try {
      const result = await withAbort(async (signal) => client.reloadMcp({ signal }));
      setMcpStatus(statusFromMcpServers(result.servers));
      setChatFeedback({ status: "success", message: "MCP reloaded" });
      return result;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const addMcpServer = useCallback(async (server: RuntimeMcpAddServerRequest): Promise<RuntimeMcpServerDescriptor | undefined> => {
    setChatFeedback({ status: "pending", message: "adding MCP server" });
    try {
      const descriptor = await withAbort(async (signal) => client.addMcpServer({ ...server, signal }));
      setMcpStatus((current) => upsertMcpServer(current, descriptor));
      setChatFeedback({ status: "success", message: "MCP server added" });
      return descriptor;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const removeMcpServer = useCallback(async (server: string): Promise<RuntimeMcpRemoveServerResponse | undefined> => {
    setChatFeedback({ status: "pending", message: "removing MCP server" });
    try {
      const result = await withAbort(async (signal) => client.removeMcpServer({ server, signal }));
      if (result.removed) {
        setMcpStatus((current) => removeMcpServerFromStatus(current, server));
      }
      setChatFeedback({ status: "success", message: result.removed ? "MCP server removed" : "MCP server was not found" });
      return result;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const listMcpTools = useCallback(async (server: string): Promise<RuntimeMcpToolsResponse | undefined> => {
    try {
      return await withAbort(async (signal) => client.listMcpTools({ server, signal }));
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, withAbort]);

  const authMcpServer = useCallback(async (server: string, request: RuntimeMcpAuthRequest = {}): Promise<RuntimeMcpAuthResponse | undefined> => {
    setChatFeedback({ status: "pending", message: "authenticating MCP server" });
    try {
      const result = await withAbort(async (signal) => client.authMcpServer({ server, ...request, signal }));
      setChatFeedback({ status: "success", message: result.status === "pending" ? "MCP auth pending" : `MCP auth ${result.status}` });
      void refreshMcpStatus();
      return result;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, refreshMcpStatus, withAbort]);

  const logoutMcpServer = useCallback(async (server: string): Promise<RuntimeMcpLogoutResponse | undefined> => {
    setChatFeedback({ status: "pending", message: "logging out MCP server" });
    try {
      const result = await withAbort(async (signal) => client.logoutMcpServer({ server, signal }));
      setChatFeedback({ status: "success", message: result.loggedOut ? "MCP server logged out" : "MCP server had no auth session" });
      void refreshMcpStatus();
      return result;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, options.baseUrl, refreshMcpStatus, withAbort]);

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

  const submitCommand = useCallback(async (
    name: string,
    args: string,
    submitOptions: ChatCommandSubmitOptions = {},
  ): Promise<boolean> => {
    const commandName = name.trim();
    if (!commandName || submitPending || running || chatView.pendingApprovals.length > 0) return false;
    if (resumeThreadMissing) {
      setChatFeedback({ status: "error", message: submitBlockedReason ?? "Session resume needs a thread." });
      return false;
    }
    setSubmitPending(true);
    setChatFeedback({ status: "pending", message: "sending command" });
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
          throw new Error("Unable to determine a session and thread for this command.");
        }
        await client.submitCommandAsync({
          sessionId,
          threadId,
          name: commandName,
          ...(args.trim().length > 0 ? { args: args.trim() } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(submitOptions.modelSelection ? { modelSelection: submitOptions.modelSelection } : {}),
          ...(submitOptions.reasoningLevel ? { reasoningLevel: submitOptions.reasoningLevel } : {}),
          signal,
        });
      });
      setChatFeedback({ status: "success", message: "command accepted" });
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

  const setRuntimePermissionProfile = useCallback(async (profile: RuntimePermissionProfileId): Promise<boolean> => {
    try {
      await withAbort(async (signal) => {
        const config = await client.setPermissionProfile({ profile, signal });
        if (!signal.aborted) setPermissionConfig(config);
      });
      setChatFeedback({ status: "success", message: "permissions updated" });
      return true;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return false;
    }
  }, [client, options.baseUrl, withAbort]);

  const setGoal = useCallback(async (goalInput: { objective: string; tokenBudget?: number }): Promise<ThreadGoal | undefined> => {
    try {
      const goal = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        return client.setGoal({
          ...session,
          objective: goalInput.objective,
          ...(goalInput.tokenBudget !== undefined ? { tokenBudget: goalInput.tokenBudget } : {}),
          replace: true,
          signal,
        });
      });
      setChatFeedback({ status: "success", message: "goal set" });
      return goal;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, ensureSession, options.baseUrl, withAbort]);

  const pauseGoal = useCallback(async (): Promise<ThreadGoal | undefined> => {
    try {
      const goal = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        return client.updateGoal({ ...session, status: "paused", signal });
      });
      setChatFeedback({ status: "success", message: "goal paused" });
      return goal;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, ensureSession, options.baseUrl, withAbort]);

  const resumeGoal = useCallback(async (): Promise<ThreadGoal | undefined> => {
    try {
      const goal = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        return client.updateGoal({ ...session, status: "active", signal });
      });
      setChatFeedback({ status: "success", message: "goal resumed" });
      return goal;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, ensureSession, options.baseUrl, withAbort]);

  const clearGoal = useCallback(async (): Promise<boolean> => {
    try {
      const result = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        return client.clearGoal({ ...session, signal });
      });
      setChatFeedback({ status: "success", message: result.cleared ? "goal cleared" : "no goal to clear" });
      return result.cleared;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return false;
    }
  }, [client, ensureSession, options.baseUrl, withAbort]);

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

  const approveApproval = useCallback(async (approvalId: ApprovalId, approveOptions: ChatApproveOptions = {}) => {
    await resolveApproval("approve", approvalId, client, withAbort, setChatFeedback, approveOptions);
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
    ...(permissionConfig ? { permissionConfig } : {}),
    ...(commandList ? { commandList } : {}),
    ...(mcpStatus ? { mcpStatus } : {}),
    canSubmit,
    ...(submitBlockedReason ? { submitBlockedReason } : {}),
    submitPrompt,
    submitCommand,
    setRuntimeModel,
    setRuntimeReasoning,
    refreshModelConfig,
    refreshPermissionConfig,
    reloadCommands,
    refreshMcpStatus,
    getMcpServer,
    reloadMcp,
    addMcpServer,
    removeMcpServer,
    listMcpTools,
    authMcpServer,
    logoutMcpServer,
    setRuntimePermissionProfile,
    setGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    startNewSession,
    interruptActiveSession,
    approveApproval,
    rejectApproval,
  }), [activeSessionId, activeThreadId, canSubmit, chatFeedback, chatView, interruptActiveSession, approveApproval, rejectApproval, modelCandidates, modelConfig, permissionConfig, commandList, mcpStatus, refreshModelConfig, refreshPermissionConfig, reloadCommands, refreshMcpStatus, getMcpServer, reloadMcp, addMcpServer, removeMcpServer, listMcpTools, authMcpServer, logoutMcpServer, setRuntimeModel, setRuntimePermissionProfile, setRuntimeReasoning, setGoal, pauseGoal, resumeGoal, clearGoal, startNewSession, submitBlockedReason, submitCommand, submitPrompt, teamRuntime]);
}

function upsertMcpServer(current: RuntimeMcpStatusResponse | undefined, server: RuntimeMcpServerDescriptor): RuntimeMcpStatusResponse {
  const servers = current?.servers.filter((item) => item.name !== server.name) ?? [];
  servers.push(server);
  servers.sort((left, right) => left.name.localeCompare(right.name));
  return statusFromMcpServers(servers);
}

function removeMcpServerFromStatus(current: RuntimeMcpStatusResponse | undefined, server: string): RuntimeMcpStatusResponse | undefined {
  if (!current) return undefined;
  return statusFromMcpServers(current.servers.filter((item) => item.name !== server));
}

function statusFromMcpServers(servers: readonly RuntimeMcpServerDescriptor[]): RuntimeMcpStatusResponse {
  return {
    servers: [...servers],
    summary: {
      total: servers.length,
      running: servers.filter((server) => server.status === "running").length,
      disabled: servers.filter((server) => !server.enabled || server.status === "disabled").length,
      authRequired: servers.filter((server) => server.status === "auth_required" || server.auth?.required && !server.auth.authenticated).length,
      errored: servers.filter((server) => server.status === "error").length,
    },
  };
}

async function resolveApproval(
  action: "approve" | "reject",
  approvalId: ApprovalId,
  client: HttpRuntimeClient,
  withAbort: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  setFeedback: (feedback: ChatRuntimeFeedback | undefined) => void,
  approveOptions: ChatApproveOptions = {},
): Promise<void> {
  setFeedback({ status: "pending", message: action === "approve" ? pendingApprovalMessage(approveOptions.scope) : "rejecting request" });
  try {
    const result = await withAbort((signal) => {
      if (action === "approve") {
        return client.approveApproval({
          approvalId,
          signal,
          scope: approveOptions.scope ?? "once",
        });
      }
      return client.rejectApproval({ approvalId, feedback: "Rejected from TUI", signal });
    });
    requireResolvedApproval(result);
    setFeedback({ status: "success", message: action === "approve" ? resolvedApprovalMessage(approveOptions.scope) : "approval rejected" });
  } catch (error) {
    if (!isAbortError(error)) setFeedback({ status: "error", message: toError(error).message });
  }
}

function pendingApprovalMessage(scope: ChatApprovalGrantScope | undefined): string {
  if (scope === "persistent") return "approving request permanently";
  if (scope === "session") return "approving request for session";
  return "approving request once";
}

function resolvedApprovalMessage(scope: ChatApprovalGrantScope | undefined): string {
  if (scope === "persistent") return "approval allowed always";
  if (scope === "session") return "approval allowed for session";
  return "approval allowed once";
}

function requireResolvedApproval(result: RuntimeApprovalResolveResult): void {
  if (!result.resolved) {
    throw new Error("Approval is no longer pending after recheck. Nothing was approved; reconnect or start a fresh prompt.");
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
