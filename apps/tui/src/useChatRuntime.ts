import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatSessionView,
  type ChatSessionView,
  type HttpRuntimeClient,
  type RuntimeSessionSummary,
} from "@chili/sdk";
import type {
  ApprovalId,
  DelegationPolicy,
  MessageImageContent,
  RuntimeApprovalResolveResult,
  RuntimeDelegationConfig,
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
  RuntimeCommandCatalog,
  RuntimeSkillMention,
  ServiceTier,
  SessionId,
  SessionGoal,
} from "@chili/protocol";
import { useTeamLiveRuntime, type TeamLiveRuntimeState, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "./model-state.js";

export type ChatRequestStatus = "idle" | "pending" | "accepted" | "success" | "error";

export interface ChatRuntimeFeedback {
  status: ChatRequestStatus;
  message: string;
  acceptedSessionId?: SessionId;
  acceptedAgainstStatusEventId?: string | null;
}

export function acceptedFeedbackMatchesStatus(
  feedback: ChatRuntimeFeedback | undefined,
  chatView: Pick<ChatSessionView, "sessionId" | "statusEventId">,
): boolean {
  if (feedback?.status !== "accepted" || feedback.acceptedAgainstStatusEventId === undefined) return false;
  if (feedback.acceptedSessionId && chatView.sessionId && feedback.acceptedSessionId !== chatView.sessionId) return false;
  return (chatView.statusEventId ?? null) === feedback.acceptedAgainstStatusEventId;
}

export interface ChatRuntimeState extends TeamLiveRuntimeState {
  activeSessionId?: SessionId;
  chatView: ChatSessionView;
  chatFeedback?: ChatRuntimeFeedback;
  modelCandidates?: readonly ModelCandidate[];
  modelConfig?: RuntimeModelConfig;
  delegationConfig?: RuntimeDelegationConfig;
  permissionConfig?: RuntimePermissionConfig;
  commandList?: RuntimeCommandCatalog;
  mcpStatus?: RuntimeMcpStatusResponse;
  canSubmit: boolean;
  submitBlockedReason?: string;
  submitPrompt: (text: string, options?: ChatSubmitOptions) => Promise<boolean>;
  submitCommand: (commandId: string, args: string, options?: ChatCommandSubmitOptions) => Promise<boolean>;
  setRuntimeModel?: (selection: ModelSelection) => Promise<boolean>;
  setRuntimeReasoning?: (level: ReasoningLevel) => Promise<boolean>;
  setRuntimeServiceTier?: (serviceTier: ServiceTier) => Promise<boolean>;
  setRuntimeDelegationPolicy?: (policy: DelegationPolicy) => Promise<RuntimeDelegationConfig | undefined>;
  refreshModelConfig?: () => Promise<void>;
  refreshDelegationConfig?: () => Promise<RuntimeDelegationConfig | undefined>;
  refreshPermissionConfig?: () => Promise<void>;
  reloadCommands?: () => Promise<RuntimeCommandCatalog | undefined>;
  refreshMcpStatus?: () => Promise<RuntimeMcpStatusResponse | undefined>;
  getMcpServer?: (server: string) => Promise<RuntimeMcpServerDescriptor | undefined>;
  reloadMcp?: () => Promise<RuntimeMcpReloadResponse | undefined>;
  addMcpServer?: (input: RuntimeMcpAddServerRequest) => Promise<RuntimeMcpServerDescriptor | undefined>;
  removeMcpServer?: (server: string) => Promise<RuntimeMcpRemoveServerResponse | undefined>;
  listMcpTools?: (server: string) => Promise<RuntimeMcpToolsResponse | undefined>;
  authMcpServer?: (server: string, request?: RuntimeMcpAuthRequest) => Promise<RuntimeMcpAuthResponse | undefined>;
  logoutMcpServer?: (server: string) => Promise<RuntimeMcpLogoutResponse | undefined>;
  setRuntimePermissionProfile?: (profile: RuntimePermissionProfileId) => Promise<boolean>;
  setGoal: (input: { objective: string; tokenBudget?: number }) => Promise<SessionGoal | undefined>;
  pauseGoal: () => Promise<SessionGoal | undefined>;
  resumeGoal: () => Promise<SessionGoal | undefined>;
  clearGoal: () => Promise<boolean>;
  startNewSession: () => Promise<void>;
  listSessions: () => Promise<RuntimeSessionSummary[]>;
  resumeSession: (session: Pick<RuntimeSessionSummary, "id">) => Promise<boolean>;
  renameSession: (title: string) => Promise<RuntimeSessionSummary | undefined>;
  interruptActiveSession: () => Promise<void>;
  approveApproval: (approvalId: ApprovalId, options?: ChatApproveOptions) => Promise<void>;
  rejectApproval: (approvalId: ApprovalId) => Promise<void>;
}

export interface ChatSubmitOptions {
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: ServiceTier | undefined;
  displayText?: string | undefined;
  images?: readonly MessageImageContent[] | undefined;
  skillMentions?: readonly RuntimeSkillMention[] | undefined;
}

export interface ChatCommandSubmitOptions {
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: ServiceTier | undefined;
}

export type ChatApprovalGrantScope = "once" | "session" | "persistent";

export interface ChatApproveOptions {
  scope?: ChatApprovalGrantScope | undefined;
}

export interface UseChatRuntimeInput {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
}

interface McpSessionScope {
  epoch: number;
  sessionId: SessionId | undefined;
}

interface SelectedSessionScope {
  epoch: number;
  sessionId: SessionId | undefined;
  cwd?: string;
}

interface SessionRequestScope {
  epoch: number;
  sessionId: SessionId | undefined;
}

export function useChatRuntime(input: UseChatRuntimeInput): ChatRuntimeState {
  const { client, options } = input;
  const [activeSessionId, setActiveSessionId] = useState<SessionId | undefined>();
  const [sessionSelectionPending, setSessionSelectionPending] = useState(options.sessionId !== undefined);
  const sessionSelectionEpochRef = useRef(0);
  const selectedSessionScopeRef = useRef<SelectedSessionScope>({
    epoch: 0,
    sessionId: options.sessionId,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const resolveTeamActionAuthority = useCallback(() => {
    const scope = selectedSessionScopeRef.current;
    return {
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope.cwd ? { cwd: scope.cwd } : {}),
    };
  }, []);
  const teamRuntime = useTeamLiveRuntime({
    ...input,
    resolveActionAuthority: resolveTeamActionAuthority,
  });
  const [submitPending, setSubmitPending] = useState(false);
  const [chatFeedback, setChatFeedback] = useState<ChatRuntimeFeedback | undefined>();
  const [modelCandidates, setModelCandidates] = useState<readonly ModelCandidate[]>([]);
  const [modelConfig, setModelConfig] = useState<RuntimeModelConfig | undefined>();
  const modelConfigEpochRef = useRef(0);
  const [delegationConfig, setDelegationConfig] = useState<RuntimeDelegationConfig | undefined>();
  const delegationConfigEpochRef = useRef(0);
  const [permissionConfig, setPermissionConfig] = useState<RuntimePermissionConfig | undefined>();
  const [commandList, setCommandList] = useState<RuntimeCommandCatalog | undefined>();
  const commandCatalogEpochRef = useRef(0);
  const [mcpStatus, setMcpStatus] = useState<RuntimeMcpStatusResponse | undefined>();
  const mcpScopeRef = useRef<McpSessionScope>({ epoch: 0, sessionId: undefined });
  const mcpStatusEpochRef = useRef(0);
  const requestAbortRefs = useRef(new Set<AbortController>());
  const refreshedForStreamingRef = useRef(false);

  const selectActiveSession = useCallback((sessionId: SessionId | undefined, cwd?: string): void => {
    selectedSessionScopeRef.current = {
      epoch: selectedSessionScopeRef.current.epoch + 1,
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
    modelConfigEpochRef.current += 1;
    commandCatalogEpochRef.current += 1;
    mcpScopeRef.current = {
      epoch: mcpScopeRef.current.epoch + 1,
      sessionId,
    };
    mcpStatusEpochRef.current += 1;
    setModelConfig(undefined);
    setModelCandidates([]);
    setCommandList(undefined);
    setMcpStatus(undefined);
    setActiveSessionId(sessionId);
  }, []);

  const invalidateSelectedSession = useCallback((sessionId?: SessionId): void => {
    selectedSessionScopeRef.current = {
      epoch: selectedSessionScopeRef.current.epoch + 1,
      sessionId,
    };
    modelConfigEpochRef.current += 1;
    delegationConfigEpochRef.current += 1;
    commandCatalogEpochRef.current += 1;
    mcpScopeRef.current = {
      epoch: mcpScopeRef.current.epoch + 1,
      sessionId,
    };
    mcpStatusEpochRef.current += 1;
  }, []);

  const captureSessionRequestScope = useCallback((
    sessionId: SessionId | undefined = selectedSessionScopeRef.current.sessionId,
  ): SessionRequestScope => ({
    epoch: selectedSessionScopeRef.current.epoch,
    sessionId,
  }), []);

  const isSessionRequestScopeCurrent = useCallback((scope: SessionRequestScope): boolean => (
    selectedSessionScopeRef.current.epoch === scope.epoch
    && selectedSessionScopeRef.current.sessionId === scope.sessionId
  ), []);

  const abortPendingRequests = useCallback((): void => {
    for (const controller of requestAbortRefs.current) controller.abort();
    requestAbortRefs.current.clear();
  }, []);

  useEffect(() => {
    const sessionId = options.sessionId;
    const epoch = ++sessionSelectionEpochRef.current;
    selectActiveSession(undefined);
    delegationConfigEpochRef.current += 1;
    setDelegationConfig(undefined);
    if (!sessionId) {
      setSessionSelectionPending(false);
      return;
    }

    const controller = new AbortController();
    requestAbortRefs.current.add(controller);
    setSessionSelectionPending(true);
    setChatFeedback({ status: "pending", message: "loading saved chat" });
    void (async () => {
      try {
        const session = requireResumableSession(await client.listSessions(), sessionId);
        if (controller.signal.aborted || sessionSelectionEpochRef.current !== epoch) return;
        const events = await client.sessionEvents({ sessionId, limit: 5_000, signal: controller.signal });
        if (controller.signal.aborted || sessionSelectionEpochRef.current !== epoch) return;
        teamRuntime.hydrateEvents(events);
        selectActiveSession(sessionId, session.cwd);
        setChatFeedback(undefined);
      } catch (error) {
        if (
          !controller.signal.aborted
          && sessionSelectionEpochRef.current === epoch
          && !isAbortError(error)
        ) {
          setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
        }
      } finally {
        requestAbortRefs.current.delete(controller);
        if (sessionSelectionEpochRef.current === epoch) setSessionSelectionPending(false);
      }
    })();
    return () => {
      controller.abort();
      requestAbortRefs.current.delete(controller);
    };
  }, [client, options.baseUrl, options.sessionId, selectActiveSession, teamRuntime.hydrateEvents]);

  const chatView = useMemo(() => {
    const request: Parameters<typeof chatSessionView>[1] = { limit: 120, requireSession: true };
    if (activeSessionId) request.sessionId = activeSessionId;
    return chatSessionView(teamRuntime.runtimeView, request);
  }, [activeSessionId, teamRuntime.revision, teamRuntime.runtimeView]);

  const visibleSessionId = activeSessionId ?? chatView.sessionId;
  if (
    visibleSessionId
    && chatView.sessionId === visibleSessionId
    && chatView.cwd
    && selectedSessionScopeRef.current.sessionId === visibleSessionId
    && selectedSessionScopeRef.current.cwd !== chatView.cwd
  ) {
    selectedSessionScopeRef.current = {
      ...selectedSessionScopeRef.current,
      cwd: chatView.cwd,
    };
  }

  useEffect(() => {
    setChatFeedback((current) => {
      if (current?.status !== "accepted" || current.acceptedAgainstStatusEventId === undefined) return current;
      if (current.acceptedSessionId && !chatView.sessionId) return current;
      return acceptedFeedbackMatchesStatus(current, chatView)
        ? current
        : undefined;
    });
  }, [chatView.sessionId, chatView.statusEventId]);

  useEffect(() => {
    if (sessionSelectionPending || !chatView.sessionId || activeSessionId === chatView.sessionId) return;
    selectActiveSession(chatView.sessionId, chatView.cwd);
  }, [activeSessionId, chatView.cwd, chatView.sessionId, selectActiveSession, sessionSelectionPending]);

  useEffect(() => {
    if (activeSessionId !== undefined || sessionSelectionPending) return;
    const sessionId = chatView.sessionId;
    if (mcpScopeRef.current.sessionId === sessionId) return;
    mcpScopeRef.current = {
      epoch: mcpScopeRef.current.epoch + 1,
      sessionId,
    };
    mcpStatusEpochRef.current += 1;
    setMcpStatus(undefined);
  }, [activeSessionId, chatView.sessionId, sessionSelectionPending]);

  const running = chatView.status === "running" || chatView.status === "waiting_for_approval" || chatView.status === "cancelling";
  const canSubmit = !sessionSelectionPending && !submitPending && !running && chatView.pendingApprovals.length === 0;

  const withAbort = useCallback(<T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    requestAbortRefs.current.add(controller);
    return run(controller.signal).finally(() => {
      requestAbortRefs.current.delete(controller);
    });
  }, []);

  const captureMcpScope = useCallback((): McpSessionScope => mcpScopeRef.current, []);
  const isMcpScopeCurrent = useCallback((scope: McpSessionScope): boolean => (
    mcpScopeRef.current.epoch === scope.epoch
    && mcpScopeRef.current.sessionId === scope.sessionId
  ), []);

  const refreshModelConfigForSession = useCallback(async (sessionIdOverride?: SessionId): Promise<void> => {
    const sessionId = sessionIdOverride ?? activeSessionId ?? chatView.sessionId;
    const sessionScope = sessionId ? captureSessionRequestScope(sessionId) : undefined;
    if (sessionScope && !isSessionRequestScopeCurrent(sessionScope)) return;
    const epoch = ++modelConfigEpochRef.current;
    try {
      await withAbort(async (signal) => {
        const models = await client.listModels();
        if (
          signal.aborted
          || modelConfigEpochRef.current !== epoch
          || (sessionScope !== undefined && !isSessionRequestScopeCurrent(sessionScope))
        ) return;
        if (!sessionId) {
          setModelConfig(undefined);
          setModelCandidates(models);
          return;
        }
        const config = await client.getModelConfig({ sessionId, signal });
        if (
          signal.aborted
          || modelConfigEpochRef.current !== epoch
          || !sessionScope
          || !isSessionRequestScopeCurrent(sessionScope)
        ) return;
        setModelConfig(config);
        setModelCandidates(config.models.length > 0 ? config.models : models);
      });
    } catch (error) {
      if (
        !isAbortError(error)
        && modelConfigEpochRef.current === epoch
        && (sessionScope === undefined || isSessionRequestScopeCurrent(sessionScope))
      ) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
    }
  }, [activeSessionId, captureSessionRequestScope, chatView.sessionId, client, isSessionRequestScopeCurrent, options.baseUrl, withAbort]);

  const refreshModelConfig = useCallback(async (): Promise<void> => {
    await refreshModelConfigForSession();
  }, [refreshModelConfigForSession]);

  useEffect(() => {
    void refreshModelConfig();
  }, [refreshModelConfig]);

  const refreshDelegationConfigForSession = useCallback(async (
    sessionIdOverride?: SessionId,
  ): Promise<RuntimeDelegationConfig | undefined> => {
    const sessionId = sessionIdOverride ?? activeSessionId ?? chatView.sessionId;
    if (!sessionId) {
      delegationConfigEpochRef.current += 1;
      setDelegationConfig(undefined);
      return undefined;
    }
    const sessionScope = captureSessionRequestScope(sessionId);
    if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
    const epoch = ++delegationConfigEpochRef.current;
    try {
      const config = await withAbort((signal) => client.getDelegationConfig({ sessionId, signal }));
      if (
        delegationConfigEpochRef.current === epoch
        && isSessionRequestScopeCurrent(sessionScope)
      ) {
        setDelegationConfig(config);
        return config;
      }
      return undefined;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(sessionScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [activeSessionId, captureSessionRequestScope, chatView.sessionId, client, isSessionRequestScopeCurrent, options.baseUrl, withAbort]);

  const refreshDelegationConfig = useCallback(async (): Promise<RuntimeDelegationConfig | undefined> => {
    return refreshDelegationConfigForSession();
  }, [refreshDelegationConfigForSession]);

  useEffect(() => {
    void refreshDelegationConfig();
  }, [refreshDelegationConfig]);

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

  const refreshCommands = useCallback(async (): Promise<RuntimeCommandCatalog | undefined> => {
    const epoch = ++commandCatalogEpochRef.current;
    const sessionId = activeSessionId ?? chatView.sessionId;
    try {
      return await withAbort(async (signal) => {
        const commands = await client.listCommands({ ...(sessionId ? { sessionId } : {}), signal });
        if (!signal.aborted && commandCatalogEpochRef.current === epoch) setCommandList(commands);
        return commands;
      });
    } catch (error) {
      if (!isAbortError(error) && commandCatalogEpochRef.current === epoch) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [activeSessionId, chatView.sessionId, client, options.baseUrl, withAbort]);

  useEffect(() => {
    void refreshCommands();
  }, [refreshCommands]);

  const reloadCommands = useCallback(async (): Promise<RuntimeCommandCatalog | undefined> => {
    const epoch = ++commandCatalogEpochRef.current;
    const sessionId = activeSessionId ?? chatView.sessionId;
    try {
      return await withAbort(async (signal) => {
        const commands = await client.reloadCommands({ ...(sessionId ? { sessionId } : {}), signal });
        if (!signal.aborted && commandCatalogEpochRef.current === epoch) setCommandList(commands);
        return commands;
      });
    } catch (error) {
      if (!isAbortError(error) && commandCatalogEpochRef.current === epoch) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [activeSessionId, chatView.sessionId, client, options.baseUrl, withAbort]);

  const refreshMcpStatusForScope = useCallback(async (
    scope: McpSessionScope,
  ): Promise<RuntimeMcpStatusResponse | undefined> => {
    if (!isMcpScopeCurrent(scope)) return undefined;
    const statusEpoch = ++mcpStatusEpochRef.current;
    try {
      return await withAbort(async (signal) => {
        const status = await client.mcpStatus({
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          signal,
        });
        if (signal.aborted || !isMcpScopeCurrent(scope)) return undefined;
        if (mcpStatusEpochRef.current === statusEpoch) {
          setMcpStatus(status);
        }
        return status;
      });
    } catch (error) {
      if (
        !isAbortError(error)
        && isMcpScopeCurrent(scope)
        && mcpStatusEpochRef.current === statusEpoch
      ) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [client, isMcpScopeCurrent, options.baseUrl, withAbort]);

  const refreshMcpStatus = useCallback(async (): Promise<RuntimeMcpStatusResponse | undefined> => {
    return refreshMcpStatusForScope(captureMcpScope());
  }, [captureMcpScope, refreshMcpStatusForScope]);

  useEffect(() => {
    void refreshMcpStatus();
  }, [activeSessionId, chatView.sessionId, refreshMcpStatus]);

  useEffect(() => {
    if (teamRuntime.connection.status !== "streaming") {
      refreshedForStreamingRef.current = false;
      return;
    }
    if (refreshedForStreamingRef.current) return;
    refreshedForStreamingRef.current = true;
    setChatFeedback((current) => current?.status === "error" ? undefined : current);
    void refreshModelConfig();
    void refreshDelegationConfig();
    void refreshPermissionConfig();
    void refreshCommands();
    void refreshMcpStatus();
  }, [refreshCommands, refreshDelegationConfig, refreshMcpStatus, refreshModelConfig, refreshPermissionConfig, teamRuntime.connection.status]);

  const getMcpServer = useCallback(async (server: string): Promise<RuntimeMcpServerDescriptor | undefined> => {
    const scope = captureMcpScope();
    const statusEpoch = ++mcpStatusEpochRef.current;
    try {
      return await withAbort(async (signal) => {
        const descriptor = await client.mcpServer({
          server,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          signal,
        });
        if (signal.aborted || !isMcpScopeCurrent(scope)) return undefined;
        if (mcpStatusEpochRef.current === statusEpoch) {
          setMcpStatus((current) => upsertMcpServer(current, descriptor));
        }
        return descriptor;
      });
    } catch (error) {
      if (
        !isAbortError(error)
        && isMcpScopeCurrent(scope)
        && mcpStatusEpochRef.current === statusEpoch
      ) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, withAbort]);

  const reloadMcp = useCallback(async (): Promise<RuntimeMcpReloadResponse | undefined> => {
    const scope = captureMcpScope();
    const statusEpoch = ++mcpStatusEpochRef.current;
    setChatFeedback({ status: "pending", message: "reloading MCP" });
    try {
      const result = await withAbort(async (signal) => client.reloadMcp({
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        signal,
      }));
      if (!isMcpScopeCurrent(scope)) return undefined;
      if (mcpStatusEpochRef.current === statusEpoch) {
        setMcpStatus(statusFromMcpServers(result.servers));
        setChatFeedback({ status: "success", message: "MCP reloaded" });
      }
      return result;
    } catch (error) {
      if (
        !isAbortError(error)
        && isMcpScopeCurrent(scope)
        && mcpStatusEpochRef.current === statusEpoch
      ) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, withAbort]);

  const addMcpServer = useCallback(async (server: RuntimeMcpAddServerRequest): Promise<RuntimeMcpServerDescriptor | undefined> => {
    const scope = captureMcpScope();
    mcpStatusEpochRef.current += 1;
    setChatFeedback({ status: "pending", message: "adding MCP server" });
    try {
      const descriptor = await withAbort(async (signal) => client.addMcpServer({ ...server, signal }));
      if (!isMcpScopeCurrent(scope)) return undefined;
      await refreshMcpStatusForScope(scope);
      if (!isMcpScopeCurrent(scope)) return undefined;
      setChatFeedback({ status: "success", message: "MCP server added" });
      return descriptor;
    } catch (error) {
      if (!isAbortError(error) && isMcpScopeCurrent(scope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, refreshMcpStatusForScope, withAbort]);

  const removeMcpServer = useCallback(async (server: string): Promise<RuntimeMcpRemoveServerResponse | undefined> => {
    const scope = captureMcpScope();
    mcpStatusEpochRef.current += 1;
    setChatFeedback({ status: "pending", message: "removing MCP server" });
    try {
      const result = await withAbort(async (signal) => client.removeMcpServer({ server, signal }));
      if (!isMcpScopeCurrent(scope)) return undefined;
      if (result.removed) {
        await refreshMcpStatusForScope(scope);
      }
      if (!isMcpScopeCurrent(scope)) return undefined;
      setChatFeedback({ status: "success", message: result.removed ? "MCP server removed" : "MCP server was not found" });
      return result;
    } catch (error) {
      if (!isAbortError(error) && isMcpScopeCurrent(scope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, refreshMcpStatusForScope, withAbort]);

  const listMcpTools = useCallback(async (server: string): Promise<RuntimeMcpToolsResponse | undefined> => {
    const scope = captureMcpScope();
    try {
      const result = await withAbort(async (signal) => client.listMcpTools({
        server,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        signal,
      }));
      return isMcpScopeCurrent(scope) ? result : undefined;
    } catch (error) {
      if (!isAbortError(error) && isMcpScopeCurrent(scope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, withAbort]);

  const authMcpServer = useCallback(async (server: string, request: RuntimeMcpAuthRequest = {}): Promise<RuntimeMcpAuthResponse | undefined> => {
    const scope = captureMcpScope();
    mcpStatusEpochRef.current += 1;
    setChatFeedback({ status: "pending", message: "authenticating MCP server" });
    try {
      const result = await withAbort(async (signal) => client.authMcpServer({ server, ...request, signal }));
      if (!isMcpScopeCurrent(scope)) return undefined;
      setChatFeedback({ status: "success", message: result.status === "pending" ? "MCP auth pending" : `MCP auth ${result.status}` });
      void refreshMcpStatusForScope(scope);
      return result;
    } catch (error) {
      if (!isAbortError(error) && isMcpScopeCurrent(scope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, refreshMcpStatusForScope, withAbort]);

  const logoutMcpServer = useCallback(async (server: string): Promise<RuntimeMcpLogoutResponse | undefined> => {
    const scope = captureMcpScope();
    mcpStatusEpochRef.current += 1;
    setChatFeedback({ status: "pending", message: "logging out MCP server" });
    try {
      const result = await withAbort(async (signal) => client.logoutMcpServer({ server, signal }));
      if (!isMcpScopeCurrent(scope)) return undefined;
      setChatFeedback({ status: "success", message: result.loggedOut ? "MCP server logged out" : "MCP server had no auth session" });
      void refreshMcpStatusForScope(scope);
      return result;
    } catch (error) {
      if (!isAbortError(error) && isMcpScopeCurrent(scope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return undefined;
    }
  }, [captureMcpScope, client, isMcpScopeCurrent, options.baseUrl, refreshMcpStatusForScope, withAbort]);

  const ensureSession = useCallback(async (signal: AbortSignal): Promise<{ sessionId: SessionId }> => {
    if (sessionSelectionPending) throw new Error("Wait for the requested session to finish loading.");
    let sessionId = activeSessionId ?? chatView.sessionId;
    if (!sessionId) {
      const created = await client.createSession({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal,
      });
      sessionId = created.sessionId;
      selectActiveSession(sessionId, options.cwd);
    }
    if (!sessionId) throw new Error("Unable to determine a session.");
    return { sessionId };
  }, [activeSessionId, chatView.sessionId, client, options.cwd, selectActiveSession, sessionSelectionPending]);

  const setRuntimeDelegationPolicy = useCallback(async (
    policy: DelegationPolicy,
  ): Promise<RuntimeDelegationConfig | undefined> => {
    if (sessionSelectionPending) {
      setChatFeedback({ status: "error", message: "Wait for the requested session to finish loading." });
      return undefined;
    }
    try {
      const updated = await withAbort(async (signal) => {
        let sessionId = activeSessionId ?? chatView.sessionId;
        if (!sessionId) {
          const created = await client.createSession({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            signal,
          });
          sessionId = created.sessionId;
          selectActiveSession(sessionId, options.cwd);
        }
        if (!sessionId) throw new Error("Unable to determine a session.");
        const sessionScope = captureSessionRequestScope(sessionId);
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        const epoch = ++delegationConfigEpochRef.current;
        const config = await client.setDelegationPolicy({
          sessionId,
          policy,
          signal,
        });
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { config, epoch, sessionScope };
      });
      if (!updated || !isSessionRequestScopeCurrent(updated.sessionScope)) return undefined;
      if (delegationConfigEpochRef.current === updated.epoch) setDelegationConfig(updated.config);
      setChatFeedback({ status: "success", message: `agent delegation ${policy}` });
      return updated.config;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [activeSessionId, captureSessionRequestScope, chatView.sessionId, client, isSessionRequestScopeCurrent, options.baseUrl, options.cwd, selectActiveSession, sessionSelectionPending, withAbort]);

  const submitPrompt = useCallback(async (text: string, submitOptions: ChatSubmitOptions = {}): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || sessionSelectionPending || submitPending || running || chatView.pendingApprovals.length > 0) return false;
    const acceptedAgainstStatusEventId = chatView.statusEventId ?? null;
    let requestScope = captureSessionRequestScope();
    setSubmitPending(true);
    setChatFeedback({ status: "pending", message: "sending prompt" });
    try {
      const accepted = await withAbort(async (signal) => {
        let sessionId = activeSessionId ?? chatView.sessionId;
        const executionCwd = chatView.cwd
          ?? (sessionId === undefined ? options.cwd : undefined);
        if (!sessionId) {
          const created = await client.createSession({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            signal,
          });
          sessionId = created.sessionId;
          selectActiveSession(sessionId, options.cwd);
        }
        if (!sessionId) {
          throw new Error("Unable to determine a session for this prompt.");
        }
        const sessionScope = captureSessionRequestScope(sessionId);
        requestScope = sessionScope;
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        const request = {
          sessionId,
          text: trimmed,
          ...(submitOptions.displayText ? { displayText: submitOptions.displayText } : {}),
          ...(executionCwd ? { cwd: executionCwd } : {}),
          ...(submitOptions.modelSelection ? { modelSelection: submitOptions.modelSelection } : {}),
          ...(submitOptions.reasoningLevel ? { reasoningLevel: submitOptions.reasoningLevel } : {}),
          ...(submitOptions.serviceTier ? { serviceTier: submitOptions.serviceTier } : {}),
          ...(submitOptions.images && submitOptions.images.length > 0 ? { images: [...submitOptions.images] } : {}),
          ...(submitOptions.skillMentions && submitOptions.skillMentions.length > 0 ? { skillMentions: [...submitOptions.skillMentions] } : {}),
          signal,
        };
        await client.submitPromptAsync(request);
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { sessionId, sessionScope };
      });
      if (!accepted || !isSessionRequestScopeCurrent(accepted.sessionScope)) return false;
      setChatFeedback({
        status: "accepted",
        message: "prompt queued",
        acceptedSessionId: accepted.sessionId,
        acceptedAgainstStatusEventId,
      });
      return true;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(requestScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    } finally {
      setSubmitPending(false);
    }
  }, [activeSessionId, captureSessionRequestScope, chatView.cwd, chatView.pendingApprovals.length, chatView.sessionId, chatView.statusEventId, client, isSessionRequestScopeCurrent, options.baseUrl, options.cwd, running, selectActiveSession, sessionSelectionPending, submitPending, withAbort]);

  const submitCommand = useCallback(async (
    commandId: string,
    args: string,
    submitOptions: ChatCommandSubmitOptions = {},
  ): Promise<boolean> => {
    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId || sessionSelectionPending || submitPending || running || chatView.pendingApprovals.length > 0) return false;
    const acceptedAgainstStatusEventId = chatView.statusEventId ?? null;
    let requestScope = captureSessionRequestScope();
    setSubmitPending(true);
    setChatFeedback({ status: "pending", message: "sending command" });
    try {
      const accepted = await withAbort(async (signal) => {
        let sessionId = activeSessionId ?? chatView.sessionId;
        const executionCwd = chatView.cwd
          ?? (sessionId === undefined ? options.cwd : undefined);
        if (!sessionId) {
          const created = await client.createSession({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            signal,
          });
          sessionId = created.sessionId;
          selectActiveSession(sessionId, options.cwd);
        }
        if (!sessionId) {
          throw new Error("Unable to determine a session for this command.");
        }
        const sessionScope = captureSessionRequestScope(sessionId);
        requestScope = sessionScope;
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        await client.submitCommandAsync({
          sessionId,
          commandId: normalizedCommandId,
          ...(args.trim().length > 0 ? { args: args.trim() } : {}),
          ...(executionCwd ? { cwd: executionCwd } : {}),
          ...(submitOptions.modelSelection ? { modelSelection: submitOptions.modelSelection } : {}),
          ...(submitOptions.reasoningLevel ? { reasoningLevel: submitOptions.reasoningLevel } : {}),
          ...(submitOptions.serviceTier ? { serviceTier: submitOptions.serviceTier } : {}),
          signal,
        });
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { sessionId, sessionScope };
      });
      if (!accepted || !isSessionRequestScopeCurrent(accepted.sessionScope)) return false;
      setChatFeedback({
        status: "accepted",
        message: "command queued",
        acceptedSessionId: accepted.sessionId,
        acceptedAgainstStatusEventId,
      });
      return true;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(requestScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    } finally {
      setSubmitPending(false);
    }
  }, [activeSessionId, captureSessionRequestScope, chatView.cwd, chatView.pendingApprovals.length, chatView.sessionId, chatView.statusEventId, client, isSessionRequestScopeCurrent, options.baseUrl, options.cwd, running, selectActiveSession, sessionSelectionPending, submitPending, withAbort]);

  const setRuntimeModel = useCallback(async (selection: ModelSelection): Promise<boolean> => {
    let mutationScope = captureSessionRequestScope();
    try {
      const updated = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        const sessionScope = captureSessionRequestScope(session.sessionId);
        mutationScope = sessionScope;
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        await client.setModel({
          ...session,
          modelSelection: selection,
          signal,
        });
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { sessionId: session.sessionId, sessionScope };
      });
      if (!updated || !isSessionRequestScopeCurrent(updated.sessionScope)) return false;
      setChatFeedback({ status: "success", message: "model selected" });
      await refreshModelConfigForSession(updated.sessionId);
      return true;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(mutationScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    }
  }, [captureSessionRequestScope, client, ensureSession, isSessionRequestScopeCurrent, options.baseUrl, refreshModelConfigForSession, withAbort]);

  const setRuntimeReasoning = useCallback(async (level: ReasoningLevel): Promise<boolean> => {
    let mutationScope = captureSessionRequestScope();
    try {
      const updated = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        const sessionScope = captureSessionRequestScope(session.sessionId);
        mutationScope = sessionScope;
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        await client.setReasoning({
          ...session,
          reasoningLevel: level,
          signal,
        });
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { sessionId: session.sessionId, sessionScope };
      });
      if (!updated || !isSessionRequestScopeCurrent(updated.sessionScope)) return false;
      setChatFeedback({ status: "success", message: "thinking level selected" });
      await refreshModelConfigForSession(updated.sessionId);
      return true;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(mutationScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    }
  }, [captureSessionRequestScope, client, ensureSession, isSessionRequestScopeCurrent, options.baseUrl, refreshModelConfigForSession, withAbort]);

  const setRuntimeServiceTier = useCallback(async (serviceTier: ServiceTier): Promise<boolean> => {
    let mutationScope = captureSessionRequestScope();
    try {
      const updated = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        const sessionScope = captureSessionRequestScope(session.sessionId);
        mutationScope = sessionScope;
        if (!isSessionRequestScopeCurrent(sessionScope)) return undefined;
        await client.setServiceTier({
          ...session,
          serviceTier,
          signal,
        });
        if (signal.aborted || !isSessionRequestScopeCurrent(sessionScope)) return undefined;
        return { sessionId: session.sessionId, sessionScope };
      });
      if (!updated || !isSessionRequestScopeCurrent(updated.sessionScope)) return false;
      setChatFeedback({ status: "success", message: serviceTier === "fast" ? "fast mode enabled" : "standard mode selected" });
      await refreshModelConfigForSession(updated.sessionId);
      return true;
    } catch (error) {
      if (!isAbortError(error) && isSessionRequestScopeCurrent(mutationScope)) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    }
  }, [captureSessionRequestScope, client, ensureSession, isSessionRequestScopeCurrent, options.baseUrl, refreshModelConfigForSession, withAbort]);

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

  const setGoal = useCallback(async (goalInput: { objective: string; tokenBudget?: number }): Promise<SessionGoal | undefined> => {
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

  const pauseGoal = useCallback(async (): Promise<SessionGoal | undefined> => {
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

  const resumeGoal = useCallback(async (): Promise<SessionGoal | undefined> => {
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
    const sessionSelectionEpoch = ++sessionSelectionEpochRef.current;
    abortPendingRequests();
    setSessionSelectionPending(true);
    setSubmitPending(false);
    setChatFeedback(undefined);
    selectActiveSession(undefined);
    delegationConfigEpochRef.current += 1;
    setDelegationConfig(undefined);
    try {
      const created = await withAbort((signal) => client.createSession({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal,
      }));
      if (sessionSelectionEpochRef.current !== sessionSelectionEpoch) return;
      selectActiveSession(created.sessionId, options.cwd);
      await refreshDelegationConfigForSession(created.sessionId);
      if (sessionSelectionEpochRef.current === sessionSelectionEpoch) setChatFeedback(undefined);
    } catch (error) {
      if (
        sessionSelectionEpochRef.current === sessionSelectionEpoch
        && !isAbortError(error)
      ) {
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
    } finally {
      if (sessionSelectionEpochRef.current === sessionSelectionEpoch) setSessionSelectionPending(false);
    }
  }, [abortPendingRequests, client, options.baseUrl, options.cwd, refreshDelegationConfigForSession, selectActiveSession, withAbort]);

  const listSessions = useCallback(async (): Promise<RuntimeSessionSummary[]> => {
    try {
      return await client.listSessions();
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      throw error;
    }
  }, [client, options.baseUrl]);

  const resumeSession = useCallback(async (
    session: Pick<RuntimeSessionSummary, "id">,
  ): Promise<boolean> => {
    if (running) {
      setChatFeedback({ status: "error", message: "Cannot resume another session while the current session is running." });
      return false;
    }
    const previousScope = {
      sessionId: activeSessionId ?? chatView.sessionId,
      cwd: chatView.cwd,
    };
    const sessionSelectionEpoch = ++sessionSelectionEpochRef.current;
    abortPendingRequests();
    invalidateSelectedSession(session.id);
    setSessionSelectionPending(true);
    setSubmitPending(false);
    setChatFeedback({ status: "pending", message: "loading saved chat" });
    try {
      const resumable = requireResumableSession(await client.listSessions(), session.id);
      if (sessionSelectionEpochRef.current !== sessionSelectionEpoch) return false;
      const events = await withAbort((signal) => client.sessionEvents({
        sessionId: session.id,
        limit: 5_000,
        signal,
      }));
      if (sessionSelectionEpochRef.current !== sessionSelectionEpoch) return false;
      teamRuntime.hydrateEvents(events);
      selectActiveSession(session.id, resumable.cwd);
      await refreshDelegationConfigForSession(session.id);
      if (sessionSelectionEpochRef.current !== sessionSelectionEpoch) return false;
      setChatFeedback({ status: "success", message: "saved chat resumed" });
      return true;
    } catch (error) {
      if (
        sessionSelectionEpochRef.current === sessionSelectionEpoch
        && !isAbortError(error)
      ) {
        invalidateSelectedSession(previousScope.sessionId);
        selectedSessionScopeRef.current = {
          ...selectedSessionScopeRef.current,
          sessionId: previousScope.sessionId,
          ...(previousScope.cwd ? { cwd: previousScope.cwd } : {}),
        };
        setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      }
      return false;
    } finally {
      if (sessionSelectionEpochRef.current === sessionSelectionEpoch) setSessionSelectionPending(false);
    }
  }, [abortPendingRequests, activeSessionId, chatView.cwd, chatView.sessionId, client, invalidateSelectedSession, options.baseUrl, refreshDelegationConfigForSession, running, selectActiveSession, teamRuntime.hydrateEvents, withAbort]);

  const renameSession = useCallback(async (title: string): Promise<RuntimeSessionSummary | undefined> => {
    setChatFeedback({ status: "pending", message: "renaming saved chat" });
    try {
      const renamed = await withAbort(async (signal) => {
        const session = await ensureSession(signal);
        return client.renameSession({ ...session, title, signal });
      });
      setChatFeedback({ status: "success", message: `renamed to ${renamed.title ?? title}` });
      return renamed;
    } catch (error) {
      if (!isAbortError(error)) setChatFeedback({ status: "error", message: runtimeErrorMessage(error, options.baseUrl) });
      return undefined;
    }
  }, [client, ensureSession, options.baseUrl, withAbort]);

  const approveApproval = useCallback(async (approvalId: ApprovalId, approveOptions: ChatApproveOptions = {}) => {
    await resolveApproval("approve", approvalId, client, withAbort, setChatFeedback, approveOptions);
  }, [client, withAbort]);

  const rejectApproval = useCallback(async (approvalId: ApprovalId) => {
    await resolveApproval("reject", approvalId, client, withAbort, setChatFeedback);
  }, [client, withAbort]);

  useEffect(() => () => {
    sessionSelectionEpochRef.current += 1;
    selectedSessionScopeRef.current = {
      epoch: selectedSessionScopeRef.current.epoch + 1,
      sessionId: undefined,
    };
    modelConfigEpochRef.current += 1;
    mcpScopeRef.current = {
      epoch: mcpScopeRef.current.epoch + 1,
      sessionId: mcpScopeRef.current.sessionId,
    };
    mcpStatusEpochRef.current += 1;
    for (const controller of requestAbortRefs.current) controller.abort();
    requestAbortRefs.current.clear();
  }, []);

  return useMemo(() => ({
    ...teamRuntime,
    ...(activeSessionId ? { activeSessionId } : {}),
    chatView,
    ...(chatFeedback ? { chatFeedback } : {}),
    modelCandidates,
    ...(modelConfig ? { modelConfig } : {}),
    ...(delegationConfig ? { delegationConfig } : {}),
    ...(permissionConfig ? { permissionConfig } : {}),
    ...(commandList ? { commandList } : {}),
    ...(mcpStatus ? { mcpStatus } : {}),
    canSubmit,
    submitPrompt,
    submitCommand,
    setRuntimeModel,
    setRuntimeReasoning,
    setRuntimeServiceTier,
    setRuntimeDelegationPolicy,
    refreshModelConfig,
    refreshDelegationConfig,
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
    listSessions,
    resumeSession,
    renameSession,
    interruptActiveSession,
    approveApproval,
    rejectApproval,
  }), [activeSessionId, canSubmit, chatFeedback, chatView, interruptActiveSession, approveApproval, rejectApproval, modelCandidates, modelConfig, delegationConfig, permissionConfig, commandList, mcpStatus, refreshModelConfig, refreshDelegationConfig, refreshPermissionConfig, reloadCommands, refreshMcpStatus, getMcpServer, reloadMcp, addMcpServer, removeMcpServer, listMcpTools, authMcpServer, logoutMcpServer, setRuntimeModel, setRuntimePermissionProfile, setRuntimeReasoning, setRuntimeServiceTier, setRuntimeDelegationPolicy, setGoal, pauseGoal, resumeGoal, clearGoal, startNewSession, listSessions, resumeSession, renameSession, submitCommand, submitPrompt, teamRuntime]);
}

function upsertMcpServer(current: RuntimeMcpStatusResponse | undefined, server: RuntimeMcpServerDescriptor): RuntimeMcpStatusResponse {
  const servers = current?.servers.filter((item) => item.name !== server.name) ?? [];
  servers.push(server);
  servers.sort((left, right) => left.name.localeCompare(right.name));
  return statusFromMcpServers(servers);
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

function requireResumableSession(
  sessions: readonly RuntimeSessionSummary[],
  sessionId: SessionId,
): RuntimeSessionSummary {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Saved chat not found: ${sessionId}`);
  if (session.status !== "active") {
    throw new Error(`Session ${sessionId} is archived and cannot be resumed.`);
  }
  if (session.source === "subagent") {
    throw new Error(`Session ${sessionId} belongs to a subagent and cannot be resumed directly.`);
  }
  return session;
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
