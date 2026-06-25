import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useAppContext, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, MouseEvent, ScrollBoxRenderable, Selection } from "@opentui/core";
import type { ChatSessionView, ChatTranscriptItem, HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type {
  ApprovalId,
  MessageImageContent,
  RuntimeMcpAuthResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolDescriptor,
  RuntimeMcpToolsResponse,
  RuntimePermissionProfileDescriptor,
  RuntimePermissionProfileId,
  RuntimeSkillMention,
  ServiceTier,
  SessionId,
  TeamId,
  ThreadId,
} from "@chili/protocol";
import { FileAuthStorage, loginOpenAICodex, OPENAI_CODEX_PROVIDER_ID } from "@chili/providers";
import { discoverSkills, updateSkillDisabledSetting, type SkillSettingsScope, type SkillSummary } from "@chili/skills";
import { runProcess, type RunProcessResult } from "@chili/tools";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanClipboardText, systemClipboard, type ClipboardAccess, type ClipboardImage } from "./clipboard.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import { teamLiveModel, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import { useChatRuntime, type ChatApprovalGrantScope, type ChatRuntimeState } from "./useChatRuntime.js";
import { findAction, shorten } from "./components/helpers.js";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  defaultOpenAICodexSelection,
  filterModelCandidates,
  isValidModelSelection,
  type ModelCandidate,
  modelDescriptorSelection,
  modelSelectionLabel,
  modelSupportsImages,
  modelSupportsReasoning,
  sameModelSelection,
  type ModelSelection,
  type ReasoningLevel,
} from "./model-state.js";
import { ApprovalDock, approvalDockHeight } from "./chat/ApprovalDock.js";
import { BrandMark } from "./chat/BrandMark.js";
import { charDisplayWidth } from "./chat/markdown.js";
import { zedPathWithPosition, type FileLinkTarget } from "./chat/file-links.js";
import { MessageList } from "./chat/MessageList.js";
import {
  McpManager,
  initialMcpManagerState,
  mcpServerMenuItems,
  normalizeMcpManagerState,
  selectedMcpServer,
  type McpManagerMessage,
  type McpManagerState,
  type McpServerMenuAction,
} from "./chat/McpManager.js";
import { PROMPT_INPUT_HEIGHT, PROMPT_PLACEHOLDER, PromptComposer, promptComposerHeight } from "./chat/PromptComposer.js";
import { StatusFooter, statusFooterHeight, type StatusFooterOptions } from "./chat/StatusFooter.js";
import { buildTranscriptLines, buildTranscriptText } from "./chat/transcript.js";
import { TranscriptView } from "./chat/TranscriptView.js";
import type { LocalTranscriptItem, PromptPart } from "./chat/types.js";
import { usePromptHistory } from "./chat/usePromptHistory.js";
import { customSlashCommandsFromRuntime } from "./slash/custom.js";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./slash/registry.js";
import type { SlashCommand, SlashCommandContext, SlashCommandResult, SlashCompletion } from "./slash/types.js";
import {
  DEFAULT_TUI_THEME_ID,
  initialTuiThemeId,
  resolveTuiTheme,
  selectableTuiThemeOptions,
  SYSTEM_TUI_THEME_ID,
  useLiveSystemTheme,
  type SystemThemePaletteRenderer,
  type TuiTheme,
  type TuiThemeOption,
} from "./theme/index.js";

type ShellView = "chat" | "team" | "help" | "agents" | "status" | "mcp" | "transcript";
type AppendLocalItem = (level: "info" | "error", text: string, options?: { persistent?: boolean | undefined }) => void;
type LocalShellItem = Extract<LocalTranscriptItem, { kind: "shell" }>;
type AppendShellItem = (item: Omit<LocalShellItem, "id" | "kind">) => string;
type UpdateShellItem = (id: string, update: Partial<Omit<LocalShellItem, "id" | "kind">>) => void;

interface PastedPromptImage extends MessageImageContent {
  id: number;
  absolutePath?: string | undefined;
}

interface SlashActions {
  cwd: string;
  setView: (view: ShellView) => void;
  appendLocalItem: AppendLocalItem;
  appendShellItem: AppendShellItem;
  updateShellItem: UpdateShellItem;
  startNewChatSession: () => Promise<void>;
  setPrompt: (value: string | ((current: string) => string)) => void;
  openThemePicker: () => void;
  openMcpManager: () => void;
  setAuthManualPrompt: (value: AuthManualPrompt | undefined) => void;
  openModelPicker: (query?: string) => void;
  setModelSelection: (selection: ModelSelection, reasoningLevel?: ReasoningLevel) => Promise<void>;
  openReasoningPicker: () => void;
  openPermissionsPicker: () => void;
  setReasoningLevel: (level: ReasoningLevel) => Promise<void>;
  setServiceTier: (serviceTier: ServiceTier) => Promise<void>;
  setPermissionProfile: (profile: RuntimePermissionProfileId) => Promise<void>;
  setHideThinking: (hidden: boolean) => void;
  ensureOpenAICodexDefaultModel: () => Promise<void>;
  reloadSkills: () => Promise<void>;
  reloadCommands: () => Promise<void>;
}

interface SkillSummariesState {
  skills: readonly SkillSummary[];
  allSkills: readonly SkillSummary[];
  reload: () => Promise<void>;
}

export interface ChatShellOptions extends TeamLiveTuiOptions {
  modelName?: string;
  providerName?: string;
  modeName?: string;
  gitBranch?: string;
  themeId?: string;
  systemTheme?: TuiTheme;
  liveSystemTheme?: boolean;
  systemThemeRefreshMs?: number;
}

export interface ChatShellExitInfo {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

interface AuthManualPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

const execFileAsync = promisify(execFile);
const PROMPT_MENU_MAX_ITEMS = 8;
const LOCAL_ITEM_TTL_MS = 4_000;
const USER_SHELL_TIMEOUT_MS = 60 * 60 * 1_000;
const USER_SHELL_OUTPUT_LIMIT_BYTES = 256_000;
const MAX_PASTED_IMAGE_BASE64_CHARS = 20 * 1024 * 1024;
const PROMPT_TEXT_PASTE_LINE_THRESHOLD = 8;
const PROMPT_TEXT_PASTE_CHAR_THRESHOLD = 1_000;
const SLASH_COMPLETION_LIMIT = 64;
export const CTRL_C_EXIT_CONFIRM_MS = 2_000;

export function ChatShellApp(props: {
  client: HttpRuntimeClient;
  options: ChatShellOptions;
  onExit: (info?: ChatShellExitInfo) => void;
}) {
  const shellOptions = useMemo<ChatShellOptions>(
    () => ({
      ...props.options,
      liveSystemTheme: props.options.liveSystemTheme ?? true,
    }),
    [props.options],
  );
  const chatOptions = useMemo(
    () => ({
      ...shellOptions,
      streamScope: shellOptions.sessionId ? "session" as const : "all" as const,
    }),
    [shellOptions],
  );
  const runtime = useChatRuntime({ client: props.client, options: chatOptions });
  const allTeams = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    sessionId: shellOptions.sessionId,
    limit: 48,
  });
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | undefined>(shellOptions.teamId ?? allTeams.selectedTeamId);
  const resolvedSelectedTeamId = shellOptions.teamId ?? validSelectedTeamId(allTeams, selectedTeamId);
  const model = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    selectedTeamId: resolvedSelectedTeamId,
    sessionId: shellOptions.sessionId,
    limit: 64,
  });
  const skillSummaries = useSkillSummaries(shellOptions.cwd ?? process.cwd());

  useEffect(() => {
    if (shellOptions.teamId) {
      setSelectedTeamId(shellOptions.teamId);
      return;
    }
    if (!selectedTeamId || !allTeams.teams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(allTeams.selectedTeamId ?? allTeams.teams[0]?.id);
    }
  }, [allTeams.selectedTeamId, allTeams.teams, shellOptions.teamId, selectedTeamId]);

  return (
    <ChatShellSurface
      model={model}
      runtime={runtime}
      options={shellOptions}
      selectedTeamId={resolvedSelectedTeamId}
      selectedTeamLocked={Boolean(shellOptions.teamId)}
      onSelectTeam={setSelectedTeamId}
      onExit={props.onExit}
      skills={skillSummaries.skills}
      allSkills={skillSummaries.allSkills}
      onSkillsChanged={skillSummaries.reload}
    />
  );
}

export function ChatShellSurface(props: {
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options?: Partial<ChatShellOptions>;
  selectedTeamId?: TeamId | undefined;
  selectedTeamLocked?: boolean;
  onSelectTeam?: (teamId: TeamId) => void;
  onExit?: (info?: ChatShellExitInfo) => void;
  commands?: readonly SlashCommand[];
  clipboard?: ClipboardAccess | undefined;
  localMessageTtlMs?: number | undefined;
  skills?: readonly SkillSummary[] | undefined;
  allSkills?: readonly SkillSummary[] | undefined;
  onSkillsChanged?: (() => Promise<void> | void) | undefined;
}) {
  const dimensions = useTerminalDimensions();
  const { keyHandler } = useAppContext();
  const renderer = useRenderer() as ClipboardRenderer & SystemThemePaletteRenderer;
  const [view, setView] = useState<ShellView>("chat");
  const [promptParts, setPromptParts] = useState<PromptPart[]>([{ type: "text", text: "" }]);
  const [promptInputResetKey, setPromptInputResetKey] = useState(0);
  const [pastedImages, setPastedImages] = useState<Record<number, PastedPromptImage>>({});
  const pastedTextByMarkerRef = useRef<Map<string, string>>(new Map());
  const nextPastedTextMarkerIdRef = useRef(2);
  const nextPastedImageIdRef = useRef(1);
  const [skillMentionBindings, setSkillMentionBindings] = useState<RuntimeSkillMention[]>([]);
  const [localItems, setLocalItems] = useState<LocalTranscriptItem[]>([]);
  const deferredLocalItems = useDeferredValue(localItems);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [acceptedCompletionPrompt, setAcceptedCompletionPrompt] = useState<string | undefined>(undefined);
  const acceptedCompletionPromptRef = useRef<string | undefined>(undefined);
  const [themeId, setThemeId] = useState(() => initialTuiThemeId(props.options?.themeId));
  const [themePicker, setThemePicker] = useState<ThemePickerNavigation | undefined>(undefined);
  const modelCandidates = useMemo(
    () => props.runtime.modelCandidates ?? [],
    [props.runtime.modelCandidates],
  );
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | undefined>(undefined);
  const [reasoningLevel, setReasoningLevelState] = useState<ReasoningLevel | undefined>(undefined);
  const [serviceTier, setServiceTierState] = useState<ServiceTier | undefined>(undefined);
  const [modelPicker, setModelPicker] = useState<ModelPickerNavigation | undefined>(undefined);
  const [reasoningPicker, setReasoningPicker] = useState<ReasoningPickerNavigation | undefined>(undefined);
  const [permissionsPicker, setPermissionsPicker] = useState<PermissionsPickerNavigation | undefined>(undefined);
  const [mcpManager, setMcpManager] = useState<McpManagerState>(() => initialMcpManagerState());
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const messageScrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const [authManualPrompt, setAuthManualPromptState] = useState<AuthManualPrompt | undefined>(undefined);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [hideThinking, setHideThinkingState] = useState(false);
  const lastCtrlCPressMsRef = useRef<number | undefined>(undefined);
  const clearedPromptTextRef = useRef<string | undefined>(undefined);
  const localMessageTtlMs = props.localMessageTtlMs ?? LOCAL_ITEM_TTL_MS;
  const localItemTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissLocalItem = useCallback((id: string) => {
    const timer = localItemTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    localItemTimersRef.current.delete(id);
    setLocalItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const appendLocalItem = useCallback<AppendLocalItem>((level, text, itemOptions) => {
    const item = localItem(level, text, itemOptions?.persistent);
    setLocalItems((current) => [...current, item]);
    if (itemOptions?.persistent || localMessageTtlMs <= 0) return;
    const timer = setTimeout(() => dismissLocalItem(item.id), localMessageTtlMs);
    localItemTimersRef.current.set(item.id, timer);
  }, [dismissLocalItem, localMessageTtlMs]);
  const appendShellItem = useCallback<AppendShellItem>((item) => {
    const id = `${Date.now()}:shell:${item.command}`;
    setLocalItems((current) => [...current, { id, kind: "shell", ...item }]);
    return id;
  }, []);
  const updateShellItem = useCallback<UpdateShellItem>((id, update) => {
    setLocalItems((current) => current.map((item) => item.kind === "shell" && item.id === id ? { ...item, ...update } : item));
  }, []);
  const clearLocalItems = useCallback(() => {
    clearLocalItemTimers(localItemTimersRef.current);
    setLocalItems([]);
  }, []);
  useEffect(() => {
    return () => clearLocalItemTimers(localItemTimersRef.current);
  }, []);
  const sessionKey = `${props.runtime.activeSessionId ?? ""}\0${props.runtime.activeThreadId ?? ""}`;
  const previousSessionKey = useRef(sessionKey);
  useEffect(() => {
    if (previousSessionKey.current === sessionKey) return;
    previousSessionKey.current = sessionKey;
    clearLocalItems();
  }, [clearLocalItems, sessionKey]);
  useEffect(() => {
    const config = props.runtime.modelConfig;
    if (!config) return;
    setModelSelectionState(config.modelSelection);
    setReasoningLevelState(config.reasoningLevel);
    setServiceTierState(config.serviceTier);
  }, [
    props.runtime.modelConfig?.modelSelection?.provider,
    props.runtime.modelConfig?.modelSelection?.model,
    props.runtime.modelConfig?.reasoningLevel,
    props.runtime.modelConfig?.serviceTier,
    props.runtime.modelConfig,
  ]);
  const scrollEstimateWidth = Math.max(24, dimensions.width - 8);
  const transcriptLineCount = useMemo(() => estimatedTranscriptLineCount(props.runtime.chatView.items, deferredLocalItems, scrollEstimateWidth), [deferredLocalItems, props.runtime.chatView.items, scrollEstimateWidth]);
  const previousTranscriptLineCount = useRef<number | undefined>(undefined);
  const prompt = promptText(promptParts);
  const expandedPrompt = expandedPromptText(promptParts);
  const shellInputActive = prompt.startsWith("!");
  const history = usePromptHistory();
  const authManualPromptRef = useRef<AuthManualPrompt | undefined>(undefined);
  const systemTheme = useLiveSystemTheme(renderer, {
    enabled: Boolean(props.options?.liveSystemTheme) && themeId === SYSTEM_TUI_THEME_ID,
    initialTheme: props.options?.systemTheme,
    refreshMs: props.options?.systemThemeRefreshMs,
  });
  const theme = resolveTuiTheme(themeId, undefined, { systemTheme });
  const themeOptions = selectableTuiThemeOptions;
  const systemThemeAvailable = Boolean(systemTheme);
  const cwd = props.options?.cwd ?? process.cwd();
  const defaultSlashCommands = useMemo(() => createDefaultSlashCommands(), []);
  const customSlashCommands = useMemo(
    () => customSlashCommandsFromRuntime(props.runtime.commandList),
    [props.runtime.commandList],
  );
  const commands = useMemo(
    () => props.commands ?? [...defaultSlashCommands, ...customSlashCommands.commands],
    [customSlashCommands.commands, defaultSlashCommands, props.commands],
  );
  const slashContext = useMemo<SlashCommandContext>(() => ({
    model: props.model,
    cwd,
    ...(modelSelection ? { modelSelection } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    modelCandidates,
    skills: props.skills ?? [],
    allSkills: props.allSkills ?? props.skills ?? [],
    mcpServers: props.runtime.mcpStatus?.servers ?? [],
  }), [cwd, modelCandidates, modelSelection, props.allSkills, props.model, props.runtime.mcpStatus?.servers, props.skills, reasoningLevel, serviceTier]);
  const completionSuppressed = acceptedCompletionPrompt !== undefined && prompt === acceptedCompletionPrompt;
  const skillTrigger = activeSkillMentionTrigger(prompt);
  const skillCompletionItems = skillTrigger && !prompt.startsWith("/") && !shellInputActive
    ? skillCompletions(props.skills ?? [], skillTrigger.query)
    : [];
  const skillCompletionOpen = Boolean(skillTrigger && !prompt.startsWith("/") && !shellInputActive);
  const slashCompletionItems = prompt.startsWith("/") && !completionSuppressed
    ? slashCompletions(commands, slashContext, prompt, SLASH_COMPLETION_LIMIT)
    : [];
  const completions = skillCompletionOpen ? skillCompletionItems : slashCompletionItems;
  const resolvedSlashPrompt = prompt.startsWith("/") ? resolveSlashCommand(commands, prompt) : undefined;
  const slashInputActive = prompt.startsWith("/") && (prompt.trim() === "/" || completions.length > 0 || resolvedSlashPrompt !== undefined);
  const slashCompletionOpen = prompt.startsWith("/") && slashCompletionItems.length > 0;
  const selectedCompletionIndex = clampIndex(completionIndex, completions.length);
  const paletteItems = slashCompletions(commands, slashContext, "/", SLASH_COMPLETION_LIMIT);
  const firstApproval = props.runtime.chatView.pendingApprovals[0];
  const setPrompt = useMemo(() => setPromptText(setPromptParts, pastedTextByMarkerRef), []);
  const historyPromptValueRef = useRef<string | undefined>(undefined);
  const updateAcceptedCompletionPrompt = useCallback((value: string | undefined) => {
    acceptedCompletionPromptRef.current = value;
    setAcceptedCompletionPrompt(value);
  }, []);
  const clearPromptAttachments = useCallback(() => {
    pastedTextByMarkerRef.current.clear();
    setPastedImages({});
  }, []);
  const clearPromptInput = useCallback((clearedText: string) => {
    clearedPromptTextRef.current = clearedText;
    updateAcceptedCompletionPrompt(undefined);
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    setCompletionIndex(0);
    setSkillMentionBindings([]);
    clearPromptAttachments();
    setPrompt("");
    setPromptInputResetKey((current) => current + 1);
  }, [clearPromptAttachments, history, setPrompt, updateAcceptedCompletionPrompt]);
  const handlePromptChange = useCallback((value: string) => {
    const clearedText = clearedPromptTextRef.current;
    if (clearedText !== undefined) {
      if (value.length === 0 || value === clearedText) {
        setPrompt("");
        return;
      }
      clearedPromptTextRef.current = undefined;
    }
    if (value.length > 0) lastCtrlCPressMsRef.current = undefined;
    if (value !== acceptedCompletionPromptRef.current) updateAcceptedCompletionPrompt(undefined);
    if (historyPromptValueRef.current === value) {
      setPrompt(value);
      return;
    }
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    setPrompt(value);
  }, [history, setPrompt, updateAcceptedCompletionPrompt]);
  useEffect(() => {
    setSkillMentionBindings((current) => filterSkillMentionBindings(current, prompt));
  }, [prompt]);
  useEffect(() => {
    setPastedImages((current) => filterPastedImagesByPrompt(current, prompt));
  }, [prompt]);
  const setPromptFromHistory = useCallback((value: string) => {
    updateAcceptedCompletionPrompt(undefined);
    historyPromptValueRef.current = value;
    setPrompt(value);
  }, [setPrompt, updateAcceptedCompletionPrompt]);
  const setAuthManualPrompt = useCallback((value: AuthManualPrompt | undefined) => {
    authManualPromptRef.current = value;
    setAuthManualPromptState(value);
  }, []);
  const scrollMessageBy = useCallback((delta: number) => {
    messageScrollBoxRef.current?.scrollBy(delta);
  }, []);
  const scrollMessageToBottom = useCallback(() => {
    messageScrollBoxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  }, []);
  const openFileLink = useCallback((target: FileLinkTarget) => {
    void openLocalFileTarget(target).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      appendLocalItem("error", `Open file failed: ${message}`);
    });
  }, [appendLocalItem]);
  const startNewChatSession = useCallback(async () => {
    setView("chat");
    setAuthManualPrompt(undefined);
    setPrompt("");
    history.clear();
    clearLocalItems();
    scrollMessageToBottom();
    setTranscriptScrollOffset(0);
    await props.runtime.startNewSession();
  }, [clearLocalItems, history, props.runtime, scrollMessageToBottom, setAuthManualPrompt, setPrompt]);
  const submitAuthManualInput = useCallback(() => {
    const manual = authManualPromptRef.current;
    if (!manual) return false;
    const value = expandedPrompt.trim();
    if (!value) return true;
    manual.resolve(value);
    setAuthManualPrompt(undefined);
    setPrompt("");
    clearPromptAttachments();
    appendLocalItem("info", "Using pasted OpenAI authorization response...");
    return true;
  }, [appendLocalItem, clearPromptAttachments, expandedPrompt, setAuthManualPrompt, setPrompt]);
  const openThemePicker = useCallback(() => {
    const index = themeOptionIndex(themeOptions, themeId);
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker({
      previousThemeId: themeId,
      index,
    });
    setThemeId(themeOptions[index]?.id ?? DEFAULT_TUI_THEME_ID);
  }, [themeId, themeOptions]);
  const previewTheme = useCallback((index: number) => {
    const nextIndex = clampIndex(index, themeOptions.length);
    setThemePicker((current) => current ? { ...current, index: nextIndex } : current);
    setThemeId(themeOptions[nextIndex]?.id ?? DEFAULT_TUI_THEME_ID);
  }, [themeOptions]);
  const confirmThemePicker = useCallback(() => {
    setThemePicker(undefined);
  }, []);
  const cancelThemePicker = useCallback(() => {
    setThemePicker((current) => {
      if (current) setThemeId(current.previousThemeId);
      return undefined;
    });
  }, []);
  const openModelPicker = useCallback((query = "") => {
    void props.runtime.refreshModelConfig?.();
    const index = modelPickerIndex(modelCandidates, query, modelSelection);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setModelPicker({ query, selectedIndex: index });
  }, [modelCandidates, modelSelection, props.runtime]);
  const closeModelPicker = useCallback(() => {
    setModelPicker(undefined);
  }, []);
  const openReasoningPicker = useCallback(() => {
    const selectedIndex = Math.max(0, REASONING_LEVELS.indexOf(reasoningLevel ?? DEFAULT_REASONING_LEVEL));
    setModelPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setReasoningPicker({ selectedIndex });
  }, [reasoningLevel]);
  const closeReasoningPicker = useCallback(() => {
    setReasoningPicker(undefined);
  }, []);
  const openPermissionsPicker = useCallback(() => {
    void props.runtime.refreshPermissionConfig?.();
    const profiles = props.runtime.permissionConfig?.profiles ?? [];
    const selectedIndex = Math.max(0, profiles.findIndex((profile) => profile.current));
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setThemePicker(undefined);
    setPermissionsPicker({ selectedIndex });
  }, [props.runtime]);
  const closePermissionsPicker = useCallback(() => {
    setPermissionsPicker(undefined);
  }, []);
  const refreshMcpManager = useCallback(async (message?: McpManagerMessage) => {
    if (!props.runtime.refreshMcpStatus) {
      setMcpManager((current) => ({
        ...current,
        loading: false,
        message: { level: "error", text: "MCP control is not available from this runtime." },
      }));
      return;
    }
    setMcpManager((current) => ({ ...current, loading: true, ...(message ? { message } : {}) }));
    const status = await props.runtime.refreshMcpStatus();
    setMcpManager((current) => normalizeMcpManagerState({
      ...current,
      loading: false,
      ...(status ? { status } : {}),
      ...(status ? {} : { message: { level: "error", text: "Could not load MCP status." } }),
    }, status?.servers ?? props.runtime.mcpStatus?.servers ?? []));
  }, [props.runtime]);
  const openMcpManager = useCallback(() => {
    setView("mcp");
    setPaletteOpen(false);
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setPrompt("");
    setMcpManager(initialMcpManagerState());
    void refreshMcpManager();
  }, [refreshMcpManager, setPrompt]);
  const closeMcpManager = useCallback(() => {
    setView("chat");
    setMcpManager(initialMcpManagerState());
  }, []);
  const setModelSelection = useCallback(async (selection: ModelSelection, nextReasoningLevel?: ReasoningLevel) => {
    const persisted = props.runtime.setRuntimeModel ? await props.runtime.setRuntimeModel(selection) : true;
    if (!persisted) {
      setModelPicker(undefined);
      appendLocalItem("error", `Model unchanged: failed to persist ${modelSelectionLabel(selection)}`);
      return;
    }

    let reasoningPersisted = false;
    let resolvedReasoning: ReasoningLevel | undefined;
    if (modelSupportsReasoning(selection, modelCandidates)) {
      resolvedReasoning = nextReasoningLevel;
    } else {
      resolvedReasoning = "off";
    }

    if (resolvedReasoning !== undefined) {
      reasoningPersisted = props.runtime.setRuntimeReasoning
        ? await props.runtime.setRuntimeReasoning(resolvedReasoning)
        : true;
      if (!reasoningPersisted) {
        appendLocalItem("error", `Thinking unchanged: failed to persist ${resolvedReasoning}`);
      }
    }

    setModelSelectionState(selection);
    if (resolvedReasoning && reasoningPersisted) setReasoningLevelState(resolvedReasoning);
    setModelPicker(undefined);
    const reasoningText = resolvedReasoning && reasoningPersisted ? ` (thinking ${resolvedReasoning})` : "";
    const selectedModel = modelCandidates.find((candidate) => sameModelSelection(selection, modelDescriptorSelection(candidate)));
    const availabilityText = selectedModel?.available === false ? " (not configured)" : "";
    appendLocalItem("info", `Model: ${modelSelectionLabel(selection)}${reasoningText}${availabilityText}`);
  }, [appendLocalItem, modelCandidates, props.runtime]);

  const setReasoningLevel = useCallback(async (level: ReasoningLevel) => {
    const persisted = props.runtime.setRuntimeReasoning ? await props.runtime.setRuntimeReasoning(level) : true;
    if (!persisted) {
      setReasoningPicker(undefined);
      appendLocalItem("error", `Thinking unchanged: failed to persist ${level}`);
      return;
    }
    setReasoningLevelState(level);
    setReasoningPicker(undefined);
    appendLocalItem("info", `Thinking: ${level}`);
  }, [appendLocalItem, props.runtime]);

  const setServiceTier = useCallback(async (nextServiceTier: ServiceTier) => {
    const persisted = props.runtime.setRuntimeServiceTier ? await props.runtime.setRuntimeServiceTier(nextServiceTier) : true;
    if (!persisted) {
      appendLocalItem("error", `Fast mode unchanged: failed to persist ${nextServiceTier}`);
      return;
    }
    setServiceTierState(nextServiceTier);
    appendLocalItem("info", nextServiceTier === "fast" ? "Fast mode: on" : "Fast mode: off (standard)");
  }, [appendLocalItem, props.runtime]);

  const setPermissionProfile = useCallback(async (profile: RuntimePermissionProfileId) => {
    const item = props.runtime.permissionConfig?.profiles.find((candidate) => candidate.id === profile);
    if (item?.disabledReason) {
      appendLocalItem("error", `${item.label}: ${item.disabledReason}`);
      return;
    }
    const persisted = props.runtime.setRuntimePermissionProfile
      ? await props.runtime.setRuntimePermissionProfile(profile)
      : false;
    setPermissionsPicker(undefined);
    if (!persisted) {
      appendLocalItem("error", `Permissions unchanged: failed to select ${item?.label ?? profile}`);
      return;
    }
    appendLocalItem("info", `Permissions updated to ${item?.label ?? profile}`);
  }, [appendLocalItem, props.runtime]);
  const setHideThinking = useCallback((hidden: boolean) => {
    setHideThinkingState(hidden);
    appendLocalItem("info", hidden ? "Thinking traces hidden." : "Thinking traces shown.");
  }, [appendLocalItem]);

  const ensureOpenAICodexDefaultModel = useCallback(async () => {
    await props.runtime.refreshModelConfig?.();
    if (isValidModelSelection(modelSelection, modelCandidates)) return;
    const selection = defaultOpenAICodexSelection();
    await setModelSelection(selection);
    await props.runtime.refreshModelConfig?.();
  }, [modelCandidates, modelSelection, props.runtime, setModelSelection]);
  const reloadCommands = useCallback(async () => {
    const commandList = await props.runtime.reloadCommands?.();
    if (!commandList) {
      appendLocalItem("error", "Could not reload commands.");
      return;
    }
    const state = customSlashCommandsFromRuntime(commandList);
    appendLocalItem("info", `Commands reloaded: ${state.commands.length} custom command${state.commands.length === 1 ? "" : "s"}.`);
    for (const diagnostic of state.diagnostics) {
      appendLocalItem(diagnostic.level === "error" ? "error" : "info", `/${diagnostic.code}: ${diagnostic.message}`);
    }
    for (const name of state.skippedConflicts) {
      appendLocalItem("info", `Skipped user command /${name}; project command wins.`);
    }
  }, [appendLocalItem, props.runtime]);
  const slashActions = useMemo<SlashActions>(() => ({
    cwd,
    setView,
    appendLocalItem,
    appendShellItem,
    updateShellItem,
    startNewChatSession,
    setPrompt,
    openThemePicker,
    openMcpManager,
    setAuthManualPrompt,
    openModelPicker,
    setModelSelection,
    openReasoningPicker,
    openPermissionsPicker,
    setReasoningLevel,
    setServiceTier,
    setPermissionProfile,
    setHideThinking,
    ensureOpenAICodexDefaultModel,
    reloadSkills: async () => {
      await props.onSkillsChanged?.();
    },
    reloadCommands,
  }), [appendLocalItem, appendShellItem, cwd, ensureOpenAICodexDefaultModel, openMcpManager, openModelPicker, openPermissionsPicker, openReasoningPicker, openThemePicker, props.onSkillsChanged, reloadCommands, setAuthManualPrompt, setHideThinking, setModelSelection, setPermissionProfile, setPrompt, setReasoningLevel, setServiceTier, startNewChatSession, updateShellItem]);
  const runSelectedSlashCompletion = useCallback(() => {
    if (!slashCompletionOpen) return false;
    const completion = slashCompletionItems[selectedCompletionIndex] ?? slashCompletionItems[0];
    if (!completion) return false;
    const promptAtSelection = prompt;
    let promptUpdated = false;
    const trackedSlashActions: SlashActions = {
      ...slashActions,
      setPrompt: (value) => {
        promptUpdated = true;
        slashActions.setPrompt(value);
      },
    };
    updateAcceptedCompletionPrompt(undefined);
    history.resetNavigation();
    void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, trackedSlashActions)
      .then(() => {
        if (!promptUpdated) setPrompt((current) => current === promptAtSelection ? "" : current);
      });
    return true;
  }, [commands, history, prompt, props.model, props.runtime, selectedCompletionIndex, setPrompt, slashActions, slashCompletionItems, slashCompletionOpen, slashContext, updateAcceptedCompletionPrompt]);
  const runSelectedSkillCompletion = useCallback(() => {
    if (!skillCompletionOpen || !skillTrigger) return false;
    const completion = skillCompletionItems[selectedCompletionIndex] ?? skillCompletionItems[0];
    if (!completion?.skill) return false;
    insertSkillMention({
      skill: completion.skill,
      trigger: skillTrigger,
      prompt,
      setPrompt,
      setSkillMentionBindings,
      history,
      updateAcceptedCompletionPrompt,
    });
    return true;
  }, [history, prompt, selectedCompletionIndex, setPrompt, skillCompletionItems, skillCompletionOpen, skillTrigger, updateAcceptedCompletionPrompt]);
  useEffect(() => {
    setCompletionIndex(0);
  }, [prompt]);

  useEffect(() => {
    if (acceptedCompletionPrompt !== undefined && prompt !== acceptedCompletionPrompt) {
      updateAcceptedCompletionPrompt(undefined);
    }
  }, [acceptedCompletionPrompt, prompt, updateAcceptedCompletionPrompt]);

  useEffect(() => {
    setCompletionIndex((current) => clampIndex(current, completions.length));
  }, [completions.length]);

  const mcpServers = (mcpManager.status ?? props.runtime.mcpStatus)?.servers ?? [];
  const setMcpManagerMessage = useCallback((message: McpManagerMessage) => {
    setMcpManager((current) => ({ ...current, loading: false, message }));
  }, []);
  const loadMcpTools = useCallback(async (server: string) => {
    if (!props.runtime.listMcpTools) {
      setMcpManager((current) => ({
        screen: "tools",
        server,
        selectedIndex: 0,
        loading: false,
        tools: [],
        status: current.status,
        message: { level: "error", text: "MCP tools listing is not available from this runtime." },
      }));
      return;
    }
    setMcpManager((current) => ({ screen: "tools", server, selectedIndex: 0, loading: true, tools: [], status: current.status }));
    const result = await props.runtime.listMcpTools(server);
    setMcpManager((current) => {
      if (current.screen !== "tools" || current.server !== server) return current;
      return {
        ...current,
        loading: false,
        tools: result?.tools ?? [],
        ...(result ? {} : { message: { level: "error" as const, text: `Could not list tools for MCP server: ${server}` } }),
      };
    });
  }, [props.runtime]);
  const reloadMcpFromManager = useCallback(async () => {
    if (!props.runtime.reloadMcp) {
      setMcpManagerMessage({ level: "error", text: "MCP reload is not available from this runtime." });
      return;
    }
    setMcpManager((current) => ({ ...current, loading: true, message: { level: "info", text: "Reloading MCP..." } }));
    const result = await props.runtime.reloadMcp();
    if (!result) {
      setMcpManagerMessage({ level: "error", text: "Could not reload MCP configuration." });
      return;
    }
    await props.runtime.reloadCommands?.();
    setMcpManager((current) => normalizeMcpManagerState({
      ...current,
      loading: false,
      status: statusFromMcpServers(result.servers),
      message: { level: result.errors.length > 0 ? "error" : "info", text: `MCP reloaded: ${result.servers.length} server${result.servers.length === 1 ? "" : "s"}, ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}.` },
    }, result.servers));
  }, [props.runtime, setMcpManagerMessage]);
  const authenticateMcpFromManager = useCallback(async (server: string) => {
    if (!props.runtime.authMcpServer) {
      setMcpManagerMessage({ level: "error", text: "MCP auth is not available from this runtime." });
      return;
    }
    setMcpManager((current) => ({ ...current, loading: true, message: { level: "info", text: `Authenticating ${server}...` } }));
    const result = await props.runtime.authMcpServer(server);
    if (!result) {
      setMcpManagerMessage({ level: "error", text: `Could not authenticate MCP server: ${server}` });
      return;
    }
    const status = await props.runtime.refreshMcpStatus?.();
    setMcpManager((current) => normalizeMcpManagerState({
      ...current,
      loading: false,
      ...(status ? { status } : {}),
      message: { level: result.status === "unsupported" ? "error" : "info", text: result.message ?? `MCP auth ${server}: ${result.status}` },
    }, status?.servers ?? (current.status ?? props.runtime.mcpStatus)?.servers ?? []));
    if (result.url) {
      void openExternalUrl(result.url).catch((error) => {
        setMcpManagerMessage({ level: "error", text: `Could not open MCP auth URL automatically: ${errorMessage(error)}` });
      });
    }
  }, [props.runtime, setMcpManagerMessage]);
  const logoutMcpFromManager = useCallback(async (server: string) => {
    if (!props.runtime.logoutMcpServer) {
      setMcpManagerMessage({ level: "error", text: "MCP logout is not available from this runtime." });
      return;
    }
    setMcpManager((current) => ({ ...current, loading: true, message: { level: "info", text: `Clearing auth for ${server}...` } }));
    const result = await props.runtime.logoutMcpServer(server);
    const status = await props.runtime.refreshMcpStatus?.();
    setMcpManager((current) => normalizeMcpManagerState({
      ...current,
      loading: false,
      ...(status ? { status } : {}),
      message: result
        ? { level: result.loggedOut ? "info" : "error", text: result.loggedOut ? `MCP server logged out: ${server}` : `MCP server had no auth session: ${server}` }
        : { level: "error", text: `Could not log out MCP server: ${server}` },
    }, status?.servers ?? (current.status ?? props.runtime.mcpStatus)?.servers ?? []));
  }, [props.runtime, setMcpManagerMessage]);
  const removeMcpFromManager = useCallback(async (server: string) => {
    if (!props.runtime.removeMcpServer) {
      setMcpManagerMessage({ level: "error", text: "MCP remove is not available from this runtime." });
      return;
    }
    setMcpManager((current) => ({ ...current, loading: true, message: { level: "info", text: `Removing ${server}...` } }));
    const result = await props.runtime.removeMcpServer(server);
    if (!result) {
      setMcpManagerMessage({ level: "error", text: `Could not remove MCP server: ${server}` });
      return;
    }
    const nextServers = ((mcpManager.status ?? props.runtime.mcpStatus)?.servers ?? []).filter((candidate) => candidate.name !== server);
    setMcpManager({
      screen: "list",
      selectedIndex: 0,
      loading: false,
      status: statusFromMcpServers(nextServers),
      message: {
        level: result.removed ? "info" : "error",
        text: result.removed ? `MCP server removed: ${server}` : `MCP server was not found in user config: ${server}`,
      },
    });
    setMcpManager((current) => normalizeMcpManagerState(current, nextServers));
  }, [mcpManager.status, props.runtime, setMcpManagerMessage]);
  const runMcpManagerAction = useCallback((action: McpServerMenuAction, server: RuntimeMcpServerDescriptor) => {
    if (action === "tools") {
      void loadMcpTools(server.name);
      return;
    }
    if (action === "reload") {
      void reloadMcpFromManager();
      return;
    }
    if (action === "auth") {
      void authenticateMcpFromManager(server.name);
      return;
    }
    if (action === "logout") {
      void logoutMcpFromManager(server.name);
      return;
    }
    if (action === "remove") {
      setMcpManager((current) => ({ screen: "confirmRemove", server: server.name, selectedIndex: 0, status: current.status }));
      return;
    }
    setMcpManager((current) => ({ screen: "list", selectedIndex: serverIndexByName(mcpServers, server.name), status: current.status }));
  }, [authenticateMcpFromManager, loadMcpTools, logoutMcpFromManager, mcpServers, reloadMcpFromManager]);

  const selectorOpen = Boolean(modelPicker || reasoningPicker || permissionsPicker);
  const approvalShortcutsEnabled = view === "chat" && Boolean(firstApproval) && props.runtime.chatView.pendingApprovals.length > 0 && !authManualPrompt && !selectorOpen && !themePicker && !paletteOpen && !slashCompletionOpen && !skillCompletionOpen;
  const disabledReason = authManualPrompt
    ? undefined
    : modelPicker
    ? "Choose a model"
    : reasoningPicker
    ? "Choose thinking level"
    : permissionsPicker
    ? "Choose permissions"
    : view === "mcp"
    ? "MCP manager open"
    : shellInputActive
    ? undefined
    : slashInputActive
    ? undefined
    : props.runtime.chatView.pendingApprovals.length > 0
      ? "Resolve approval to continue"
      : props.runtime.chatView.status === "running"
        ? "Session running - ctrl+x interrupt"
        : props.runtime.submitBlockedReason
          ? props.runtime.submitBlockedReason
        : !props.runtime.canSubmit
          ? "Waiting for runtime"
          : undefined;
  const promptDisabled = Boolean(disabledReason);
  const clipboard = props.clipboard ?? systemClipboard;
  const registerPromptTextPaste = useCallback((value: string) => {
    const text = cleanClipboardText(value) ?? "";
    if (!text) return "";
    if (!shouldCollapsePromptTextPaste(text)) return text;
    const marker = uniquePromptTextPasteMarker(
      promptTextPasteMarker(text),
      pastedTextByMarkerRef.current,
      nextPastedTextMarkerIdRef,
    );
    pastedTextByMarkerRef.current.set(marker, text);
    return marker;
  }, []);
  const readPromptClipboard = useCallback(async () => {
    const image = await clipboard.readImage?.().catch(() => undefined);
    if (image) {
      try {
        const pasted = await saveClipboardImage(cwd, image);
        const data = Buffer.from(image.bytes).toString("base64");
        if (data.length > MAX_PASTED_IMAGE_BASE64_CHARS) {
          throw new Error(`image is too large for paste (${Math.ceil(data.length / 1024 / 1024)}MB base64)`);
        }
        const id = nextPastedImageIdRef.current++;
        const placeholder = imagePlaceholder(id);
        setPastedImages((current) => ({
          ...current,
          [id]: {
            id,
            data,
            mimeType: image.mimeType,
            filename: pasted.filename,
            sourcePath: pasted.relativePath,
            absolutePath: pasted.absolutePath,
          },
        }));
        appendLocalItem("info", `Pasted image ${placeholder}: ${pasted.relativePath}`);
        return placeholder;
      } catch (error) {
        appendLocalItem("error", `Clipboard image paste failed: ${errorMessage(error)}`);
        return undefined;
      }
    }
    const pasted = cleanClipboardText(await clipboard.readText().catch(() => "") ?? "") ?? "";
    if (!pasted) {
      appendLocalItem("error", "Clipboard is empty.");
      return undefined;
    }
    return pasted;
  }, [appendLocalItem, clipboard, cwd]);
  const handleCtrlCExitShortcut = useCallback(() => {
    const now = Date.now();
    if (isWithinCtrlCExitWindow(lastCtrlCPressMsRef.current, now)) {
      lastCtrlCPressMsRef.current = undefined;
      props.onExit?.(chatShellExitInfo(props.runtime, cwd));
      return;
    }
    lastCtrlCPressMsRef.current = now;
    const hadPrompt = prompt.length > 0;
    if (hadPrompt) clearPromptInput(prompt);
    appendLocalItem("info", hadPrompt ? "Input cleared. Press Ctrl+C again to exit." : "Press Ctrl+C again to exit.");
  }, [appendLocalItem, clearPromptInput, cwd, prompt, props.onExit, props.runtime]);

  useEffect(() => {
    const previous = previousTranscriptLineCount.current;
    previousTranscriptLineCount.current = transcriptLineCount;
    if (previous === undefined) return;
    const delta = transcriptLineCount - previous;
    if (delta <= 0) return;
    setTranscriptScrollOffset((current) => current > 0 ? current + delta : current);
  }, [transcriptLineCount]);

  useEffect(() => {
    const handleSelection = (selection: Selection) => {
      const text = cleanClipboardText(selection.getSelectedText());
      if (text) void copyClipboardText(text, clipboard, renderer);
    };
    renderer.on?.("selection", handleSelection);
    return () => {
      renderer.off?.("selection", handleSelection);
    };
  }, [clipboard, renderer]);

  useKeyboard((key) => {
    if (key.eventType !== "press") return;
    const ctrlCExitShortcut = key.ctrl && key.name === "c" && !key.shift;
    if (!ctrlCExitShortcut) lastCtrlCPressMsRef.current = undefined;
    if (isCopyShortcut(key)) {
      key.preventDefault();
      key.stopPropagation();
      const source = clipboardCopySource(renderer, props.runtime.chatView.items, view);
      if (!source) {
        appendLocalItem("error", "Nothing to copy yet.");
        return;
      }
      void copyClipboardText(source.text, clipboard, renderer).then((copied) => {
        appendLocalItem(copied ? "info" : "error", copied ? `Copied ${source.label}.` : "Clipboard copy is unavailable.");
      });
      return;
    }
    if (ctrlCExitShortcut) {
      key.preventDefault();
      key.stopPropagation();
      handleCtrlCExitShortcut();
      return;
    }
    if (key.ctrl && key.name === "x") {
      void props.runtime.interruptActiveSession();
      return;
    }
    if (key.ctrl && key.name === "p") {
      setPaletteOpen(true);
      setPaletteIndex(0);
      return;
    }
    if (key.ctrl && key.name === "o" && !key.shift) {
      setShowToolDetails((current) => !current);
      return;
    }
    if (key.ctrl && key.name === "t" && !key.shift) {
      setView((current) => current === "transcript" ? "chat" : "transcript");
      return;
    }
    if (view === "team") {
      if (isEscape(key)) setView("chat");
      return;
    }
    if (view === "mcp") {
      const state = normalizeMcpManagerState(mcpManager, mcpServers);
      const server = selectedMcpServer(state, mcpServers);
      if (isEscape(key)) {
        if (state.screen === "list") {
          closeMcpManager();
          return;
        }
        if (state.screen === "server" && server) {
          setMcpManager({ screen: "list", selectedIndex: serverIndexByName(mcpServers, server.name), status: state.status });
          return;
        }
        if ((state.screen === "tools" || state.screen === "confirmRemove") && server) {
          setMcpManager({ screen: "server", server: server.name, selectedIndex: 0, status: state.status });
          return;
        }
        if (state.screen === "tool" && server) {
          setMcpManager({ screen: "tools", server: server.name, selectedIndex: state.toolIndex ?? 0, tools: state.tools, status: state.status });
          return;
        }
        closeMcpManager();
        return;
      }
      if (isPlainRefreshKey(key)) {
        void refreshMcpManager();
        return;
      }
      if (state.screen === "list") {
        if (isArrowUp(key) || isArrowDown(key)) {
          const delta = isArrowUp(key) ? -1 : 1;
          setMcpManager((current) => ({ ...current, selectedIndex: clampIndex(current.selectedIndex + delta, mcpServers.length) }));
          return;
        }
        if (isEnter(key)) {
          const selected = mcpServers[clampIndex(state.selectedIndex, mcpServers.length)];
          if (selected) setMcpManager({ screen: "server", server: selected.name, selectedIndex: 0, status: state.status });
          return;
        }
        return;
      }
      if (state.screen === "server" && server) {
        const items = mcpServerMenuItems(server);
        if (isArrowUp(key) || isArrowDown(key)) {
          const delta = isArrowUp(key) ? -1 : 1;
          setMcpManager((current) => ({ ...current, selectedIndex: clampIndex(current.selectedIndex + delta, items.length) }));
          return;
        }
        if (isEnter(key)) {
          const item = items[clampIndex(state.selectedIndex, items.length)];
          if (item) runMcpManagerAction(item.action, server);
          return;
        }
        return;
      }
      if (state.screen === "tools" && server) {
        const tools = state.tools ?? [];
        if (isArrowUp(key) || isArrowDown(key)) {
          const delta = isArrowUp(key) ? -1 : 1;
          setMcpManager((current) => ({ ...current, selectedIndex: clampIndex(current.selectedIndex + delta, tools.length) }));
          return;
        }
        if (isEnter(key)) {
          const tool = tools[clampIndex(state.selectedIndex, tools.length)];
          if (tool) setMcpManager({ screen: "tool", server: server.name, selectedIndex: 0, tools, toolIndex: clampIndex(state.selectedIndex, tools.length), status: state.status });
          return;
        }
        return;
      }
      if (state.screen === "confirmRemove" && server) {
        if (isArrowUp(key) || isArrowDown(key)) {
          const delta = isArrowUp(key) ? -1 : 1;
          setMcpManager((current) => ({ ...current, selectedIndex: clampIndex(current.selectedIndex + delta, 2) }));
          return;
        }
        if (isEnter(key)) {
          if (state.selectedIndex === 1) void removeMcpFromManager(server.name);
          else setMcpManager({ screen: "server", server: server.name, selectedIndex: 0, status: state.status });
          return;
        }
        return;
      }
      return;
    }
    if (paletteOpen) {
      handlePaletteKey(key, paletteItems, paletteIndex, setPaletteIndex, (completion) => {
        setPaletteOpen(false);
        void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, slashActions);
      }, () => setPaletteOpen(false));
      return;
    }
    if (modelPicker) {
      handleModelPickerKey(key, modelPicker, modelCandidates, modelSelection, {
        setModelPicker,
        selectModel: setModelSelection,
        cancel: closeModelPicker,
      });
      return;
    }
    if (reasoningPicker) {
      handleReasoningPickerKey(key, reasoningPicker, {
        setReasoningPicker,
        selectLevel: setReasoningLevel,
        cancel: closeReasoningPicker,
      });
      return;
    }
    if (permissionsPicker) {
      handlePermissionsPickerKey(key, permissionsPicker, props.runtime.permissionConfig?.profiles ?? [], {
        setPermissionsPicker,
        selectProfile: setPermissionProfile,
        cancel: closePermissionsPicker,
      });
      return;
    }
    if (themePicker) {
      if (isEscape(key)) {
        cancelThemePicker();
        return;
      }
      if (isArrowUp(key) || isArrowDown(key)) {
        const delta = isArrowUp(key) ? -1 : 1;
        previewTheme(themePicker.index + delta);
        return;
      }
      if (isEnter(key)) {
        confirmThemePicker();
        return;
      }
      return;
    }
    if ((slashCompletionOpen || skillCompletionOpen) && !key.shift && (isArrowUp(key) || isArrowDown(key))) {
      const delta = isArrowUp(key) ? -1 : 1;
      setCompletionIndex((current) => wrapIndex(current + delta, completions.length));
      return;
    }
    if (skillCompletionOpen && isTab(key)) {
      if (runSelectedSkillCompletion()) return;
    }
    if (slashCompletionOpen && isTab(key)) {
      const completion = slashCompletionItems[selectedCompletionIndex] ?? slashCompletionItems[0];
      if (completion) {
        const accepted = `${completion.value} `;
        history.resetNavigation();
        updateAcceptedCompletionPrompt(accepted);
        setPrompt(accepted);
      }
      return;
    }
    if (isEscape(key)) {
      // Interrupt the active session if running
      if (props.runtime.chatView.status === "running") {
        void props.runtime.interruptActiveSession();
        return;
      }
      // Close theme picker if open
      if (themePicker) {
        cancelThemePicker();
        return;
      }
      // Close model picker if open
      if (modelPicker) {
        closeModelPicker();
        return;
      }
      // Close reasoning picker if open
      if (reasoningPicker) {
        closeReasoningPicker();
        return;
      }
      // Close permissions picker if open
      if (permissionsPicker) {
        closePermissionsPicker();
        return;
      }
      // Close palette if open
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      // Return to chat view if in another view
      if (view !== "chat") {
        setView("chat");
        return;
      }
      return;
    }
    if (view === "chat" && key.ctrl && key.name === "y") {
      scrollMessageBy(-scrollStep(dimensions.height));
      return;
    }
    if (view === "transcript" && key.ctrl && key.name === "y") {
      setTranscriptScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && (isPageUp(key) || (key.shift && isArrowUp(key)))) {
      scrollMessageBy(-scrollStep(dimensions.height));
      return;
    }
    if (view === "transcript" && (isPageUp(key) || (key.shift && isArrowUp(key)))) {
      setTranscriptScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && (isPageDown(key) || (key.shift && isArrowDown(key)))) {
      scrollMessageBy(scrollStep(dimensions.height));
      return;
    }
    if (view === "transcript" && (isPageDown(key) || (key.shift && isArrowDown(key)))) {
      setTranscriptScrollOffset((current) => Math.max(0, current - scrollStep(dimensions.height)));
      return;
    }
    if (view === "chat" && !promptDisabled && isPlainArrowUp(key) && !slashCompletionOpen && !skillCompletionOpen) {
      const previous = history.previous(prompt);
      if (previous !== undefined) setPromptFromHistory(previous);
      return;
    }
    if (view === "chat" && !promptDisabled && isPlainArrowDown(key) && !slashCompletionOpen && !skillCompletionOpen) {
      const next = history.next(prompt);
      if (next !== undefined) setPromptFromHistory(next);
      return;
    }
    if (approvalShortcutsEnabled && firstApproval && isApproveAlwaysKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "persistent" });
      return;
    }
    if (approvalShortcutsEnabled && firstApproval && isApproveSessionKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "session" });
      return;
    }
    if (approvalShortcutsEnabled && firstApproval && isApproveOnceKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "once" });
      return;
    }
    if (approvalShortcutsEnabled && firstApproval && isRejectApprovalKey(key)) {
      void props.runtime.rejectApproval(firstApproval.id);
      return;
    }
  });

  const gitBranch = useGitBranch(cwd, props.options?.gitBranch);
  const shellOptions: StatusFooterOptions = {
    modeName: props.options?.modeName ?? "Build",
    modelName: props.options?.modelName ?? "auto",
    providerName: props.options?.providerName ?? "runtime",
    ...(modelSelection ? { modelSelection } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    cwd,
    ...(gitBranch ? { gitBranch } : {}),
  };
  const modelPickerModel = modelPicker
    ? modelPickerView(modelPicker, modelCandidates, modelSelection)
    : undefined;
  const reasoningPickerModel = reasoningPicker
    ? reasoningPickerView(reasoningPicker, reasoningLevel ?? DEFAULT_REASONING_LEVEL)
    : undefined;
  const permissionsPickerModel = permissionsPicker
    ? permissionsPickerView(permissionsPicker, props.runtime.permissionConfig?.profiles ?? [])
    : undefined;

  if (view === "team") {
    return (
      <TeamLiveSurface
        model={props.model}
        runtime={props.runtime}
        selectedTeamId={props.selectedTeamId}
        selectedTeamLocked={props.selectedTeamLocked}
        onSelectTeam={props.onSelectTeam}
        onBack={() => setView("chat")}
        onExit={props.onExit}
        theme={theme}
      />
    );
  }

  const home = props.runtime.chatView.items.length === 0
    && localItems.length === 0
    && props.runtime.chatView.pendingApprovals.length === 0
    && view === "chat";
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.colors.background}>
      {home ? (
        <HomeScreen
          width={dimensions.width}
          height={dimensions.height}
          prompt={prompt}
          promptInputResetKey={promptInputResetKey}
          focused={view === "chat" && !paletteOpen && !themePicker && !modelPicker && !reasoningPicker && !permissionsPicker && !disabledReason}
          onPromptChange={handlePromptChange}
          onExitShortcut={handleCtrlCExitShortcut}
          onPasteShortcut={readPromptClipboard}
          onTextPaste={registerPromptTextPaste}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedSlashCompletion()) return;
            void submitPrompt(prompt, expandedPrompt, commands, slashContext, props.model, props.runtime, slashActions, history.record, skillMentionBindings, props.skills ?? [], pastedImages, clearPromptAttachments);
          }}
          completions={completions}
          completionOpen={skillCompletionOpen || slashCompletionOpen}
          completionTitle={skillCompletionOpen ? "Skills" : "Commands"}
          emptyCompletionText={skillCompletionOpen ? "no skills" : "no commands"}
          completionIndex={selectedCompletionIndex}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          showToolDetails={showToolDetails}
          transcriptActive={false}
          disabledReason={disabledReason}
          theme={theme}
          themePicker={themePicker ? {
            items: themeOptions,
            selectedIndex: themePicker.index,
            systemThemeAvailable,
          } : undefined}
          modelPicker={modelPickerModel}
          reasoningPicker={reasoningPickerModel}
          permissionsPicker={permissionsPickerModel}
        />
      ) : (
        <SessionScreen
          width={dimensions.width}
          height={dimensions.height}
          view={view}
          prompt={prompt}
          promptInputResetKey={promptInputResetKey}
          focused={view === "chat" && !paletteOpen && !themePicker && !modelPicker && !reasoningPicker && !permissionsPicker && !disabledReason}
          onPromptChange={handlePromptChange}
          onExitShortcut={handleCtrlCExitShortcut}
          onPasteShortcut={readPromptClipboard}
          onTextPaste={registerPromptTextPaste}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedSlashCompletion()) return;
            scrollMessageToBottom();
            void submitPrompt(prompt, expandedPrompt, commands, slashContext, props.model, props.runtime, slashActions, history.record, skillMentionBindings, props.skills ?? [], pastedImages, clearPromptAttachments);
          }}
          onTranscriptScroll={(event) => {
            const direction = event.scroll?.direction;
            if (direction !== "up" && direction !== "down") return;
            event.preventDefault();
            event.stopPropagation();
            const delta = Math.max(1, event.scroll?.delta ?? 1);
            const amount = Math.max(2, Math.ceil(delta * 3));
            if (direction === "up") {
              setTranscriptScrollOffset((current) => current + amount);
            } else {
              setTranscriptScrollOffset((current) => Math.max(0, current - amount));
            }
          }}
          localItems={deferredLocalItems}
          messageScrollRef={messageScrollBoxRef}
          onOpenFile={openFileLink}
          transcriptScrollOffset={transcriptScrollOffset}
          completions={completions}
          completionOpen={skillCompletionOpen || slashCompletionOpen}
          completionTitle={skillCompletionOpen ? "Skills" : "Commands"}
          emptyCompletionText={skillCompletionOpen ? "no skills" : "no commands"}
          completionIndex={selectedCompletionIndex}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          mcpManager={mcpManager}
          showToolDetails={showToolDetails}
          hideThinking={hideThinking}
          transcriptActive={view === "transcript"}
          commands={commands}
          disabledReason={disabledReason}
          theme={theme}
          themePicker={themePicker ? {
            items: themeOptions,
            selectedIndex: themePicker.index,
            systemThemeAvailable,
          } : undefined}
          modelPicker={modelPickerModel}
          reasoningPicker={reasoningPickerModel}
          permissionsPicker={permissionsPickerModel}
        />
      )}
    </box>
  );
}

function HomeScreen(props: {
  width: number;
  height: number;
  prompt: string;
  promptInputResetKey: number;
  focused: boolean;
  onPromptChange: (value: string) => void;
  onExitShortcut: () => void;
  onPasteShortcut: () => Promise<string | undefined>;
  onTextPaste: (value: string) => string;
  onSubmit: () => void;
  completions: readonly SlashCompletion[];
  completionOpen: boolean;
  completionTitle: string;
  emptyCompletionText: string;
  completionIndex: number;
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: StatusFooterOptions;
  showToolDetails: boolean;
  transcriptActive: boolean;
  disabledReason?: string | undefined;
  theme: TuiTheme;
  themePicker?: ThemePickerModel | undefined;
  modelPicker?: ModelPickerModel | undefined;
  reasoningPicker?: ReasoningPickerModel | undefined;
  permissionsPicker?: PermissionsPickerModel | undefined;
}) {
  const promptWidth = Math.min(76, Math.max(42, props.width - 12));
  const compactBrand = props.width < 92 || props.height < 32;
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const selectorHeight = selectorPickerHeight(props.modelPicker, props.reasoningPicker, props.permissionsPicker);
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    approvalHeight: 0,
    themePickerHeight,
    selectorHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completionOpen || props.completions.length > 0,
  });
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexGrow={2} />
      <box width="100%" flexDirection="column" alignItems="center">
        <BrandMark compact={compactBrand} />
        <box height={1} />
        <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Chili"}</text>
        <box height={1} />
        {props.themePicker ? <ThemePicker model={props.themePicker} theme={props.theme} /> : null}
        {props.modelPicker ? <ModelPicker model={props.modelPicker} theme={props.theme} /> : null}
        {props.reasoningPicker ? <ReasoningPicker model={props.reasoningPicker} theme={props.theme} /> : null}
        {props.permissionsPicker ? <PermissionsPicker model={props.permissionsPicker} theme={props.theme} /> : null}
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          resetKey={props.promptInputResetKey}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onExitShortcut={props.onExitShortcut}
          onPasteShortcut={props.onPasteShortcut}
          onTextPaste={props.onTextPaste}
          onSubmit={props.onSubmit}
          completions={props.completions}
          completionOpen={props.completionOpen}
          completionTitle={props.completionTitle}
          emptyCompletionText={props.emptyCompletionText}
          completionIndex={props.completionIndex}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={feedback}
          theme={props.theme}
          maxCommandItems={maxCommandItems}
        />
      </box>
      <box flexGrow={3} />
      <StatusFooter options={props.options} model={props.model} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} width={props.width} theme={props.theme} showToolDetails={props.showToolDetails} transcriptActive={props.transcriptActive} />
    </box>
  );
}

function SessionScreen(props: {
  width: number;
  height: number;
  view: Exclude<ShellView, "team">;
  prompt: string;
  promptInputResetKey: number;
  focused: boolean;
  onPromptChange: (value: string) => void;
  onExitShortcut: () => void;
  onPasteShortcut: () => Promise<string | undefined>;
  onTextPaste: (value: string) => string;
  onSubmit: () => void;
  onTranscriptScroll: (event: MouseEvent) => void;
  localItems: readonly LocalTranscriptItem[];
  messageScrollRef: RefObject<ScrollBoxRenderable | null>;
  onOpenFile: (target: FileLinkTarget) => void;
  transcriptScrollOffset: number;
  completions: readonly SlashCompletion[];
  completionOpen: boolean;
  completionTitle: string;
  emptyCompletionText: string;
  completionIndex: number;
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  mcpManager: McpManagerState;
  options: StatusFooterOptions;
  showToolDetails: boolean;
  hideThinking: boolean;
  transcriptActive: boolean;
  commands: readonly SlashCommand[];
  disabledReason?: string | undefined;
  theme: TuiTheme;
  themePicker?: ThemePickerModel | undefined;
  modelPicker?: ModelPickerModel | undefined;
  reasoningPicker?: ReasoningPickerModel | undefined;
  permissionsPicker?: PermissionsPickerModel | undefined;
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  const messageWidth = Math.max(24, props.width - 8);
  const approvalHeight = approvalDockHeight(props.runtime.chatView.pendingApprovals, messageWidth, props.theme);
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const selectorHeight = selectorPickerHeight(props.modelPicker, props.reasoningPicker, props.permissionsPicker);
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    approvalHeight,
    themePickerHeight,
    selectorHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completionOpen || props.completions.length > 0,
  });
  const promptHeight = promptComposerHeight({
    completions: props.completions,
    completionOpen: props.completionOpen,
    paletteOpen: props.paletteOpen,
    paletteItems: props.paletteItems,
    feedback,
    maxCommandItems,
    shellMode: props.prompt.startsWith("!"),
    prompt: props.prompt.startsWith("!") ? props.prompt.slice(1) : props.prompt,
    width: promptWidth,
  });
  const messagePaneHeight = Math.max(1, props.height - approvalHeight - themePickerHeight - selectorHeight - promptHeight - footerHeight);
  const transcriptChrome = props.height < 16 ? 6 : 3;
  const transcriptVisibleLimit = Math.max(1, props.height - approvalHeight - themePickerHeight - selectorHeight - promptHeight - footerHeight - transcriptChrome);
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      onMouseScroll={(event) => {
        if (props.view === "transcript") props.onTranscriptScroll(event);
      }}
    >
      <box height={messagePaneHeight} flexDirection="column" paddingX={3} paddingY={1}>
        {props.view === "help" ? (
          <HelpView commands={props.commands} theme={props.theme} showToolDetails={props.showToolDetails} />
        ) : props.view === "status" ? (
          <StatusView model={props.model} runtime={props.runtime} options={props.options} theme={props.theme} showToolDetails={props.showToolDetails} hideThinking={props.hideThinking} transcriptActive={props.transcriptActive} />
        ) : props.view === "mcp" ? (
          <McpManager state={props.mcpManager} runtime={props.runtime} theme={props.theme} />
        ) : props.view === "agents" ? (
          <AgentsView model={props.model} theme={props.theme} />
        ) : props.view === "transcript" ? (
          <TranscriptView
            chatView={props.runtime.chatView}
            localItems={props.localItems}
            width={messageWidth}
            visibleLimit={transcriptVisibleLimit}
            scrollOffset={props.transcriptScrollOffset}
            theme={props.theme}
          />
        ) : (
          <MessageList
            chatView={props.runtime.chatView}
            localItems={props.localItems}
            width={messageWidth}
            scrollRef={props.messageScrollRef}
            cwd={props.options.cwd}
            onOpenFile={props.onOpenFile}
            theme={props.theme}
            showToolDetails={props.showToolDetails}
            hideThinking={props.hideThinking}
          />
        )}
      </box>
      <ApprovalDock
        approvals={props.runtime.chatView.pendingApprovals}
        width={messageWidth}
        onApprove={(approvalId: ApprovalId, scope: ChatApprovalGrantScope) => void props.runtime.approveApproval(approvalId, { scope })}
        onReject={(approvalId: ApprovalId) => void props.runtime.rejectApproval(approvalId)}
        theme={props.theme}
      />
      <box width="100%" alignItems="center" flexDirection="column">
        {props.themePicker ? <ThemePicker model={props.themePicker} theme={props.theme} /> : null}
        {props.modelPicker ? <ModelPicker model={props.modelPicker} theme={props.theme} /> : null}
        {props.reasoningPicker ? <ReasoningPicker model={props.reasoningPicker} theme={props.theme} /> : null}
        {props.permissionsPicker ? <PermissionsPicker model={props.permissionsPicker} theme={props.theme} /> : null}
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          resetKey={props.promptInputResetKey}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onExitShortcut={props.onExitShortcut}
          onPasteShortcut={props.onPasteShortcut}
          onTextPaste={props.onTextPaste}
          onSubmit={props.onSubmit}
          completions={props.completions}
          completionOpen={props.completionOpen}
          completionTitle={props.completionTitle}
          emptyCompletionText={props.emptyCompletionText}
          completionIndex={props.completionIndex}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={feedback}
          theme={props.theme}
          maxCommandItems={maxCommandItems}
        />
      </box>
      <StatusFooter options={props.options} model={props.model} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} width={props.width} theme={props.theme} showToolDetails={props.showToolDetails} transcriptActive={props.transcriptActive} />
    </box>
  );
}

function estimatedTranscriptLineCount(items: readonly ChatTranscriptItem[], localItems: readonly LocalTranscriptItem[], width: number): number {
  const transcriptLineCount = buildTranscriptLines(items).reduce((count, line) => count + roughTextLineCount(line.text, width), 0);
  const localLineCount = localItems.reduce((count, item) => count + roughTextLineCount(localTranscriptEstimateText(item), width), 0);
  return transcriptLineCount + localLineCount;
}

function localTranscriptEstimateText(item: LocalTranscriptItem): string {
  if (item.kind === "local") return `${item.level}: ${item.text}`;
  const status = item.status === "running"
    ? `running in ${item.cwd}`
    : item.exitCode !== undefined
      ? `exit ${item.exitCode ?? "signal"}`
      : item.status;
  return `! ${item.command}\n${item.output || "(no output)"}\n${status}`;
}

function roughTextLineCount(value: string, width: number): number {
  const safeWidth = Math.max(8, width);
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").reduce((count, line) => {
    const lineWidth = [...line].reduce((sum, char) => sum + charDisplayWidth(char), 0);
    return count + Math.max(1, Math.ceil(lineWidth / safeWidth));
  }, 0);
}

interface ThemePickerNavigation {
  previousThemeId: string;
  index: number;
}

interface ThemePickerModel {
  items: readonly TuiThemeOption[];
  selectedIndex: number;
  systemThemeAvailable: boolean;
}

interface ModelPickerNavigation {
  query: string;
  selectedIndex: number;
}

interface ModelPickerModel {
  query: string;
  items: readonly ModelPickerItem[];
  selectedIndex: number;
  total: number;
}

interface ModelPickerItem {
  selection: ModelSelection;
  label: string;
  provider: string;
  displayName?: string | undefined;
  available?: boolean | undefined;
  current: boolean;
}

interface ReasoningPickerNavigation {
  selectedIndex: number;
}

interface ReasoningPickerModel {
  items: readonly ReasoningPickerItem[];
  selectedIndex: number;
}

interface ReasoningPickerItem {
  level: ReasoningLevel;
  description: string;
  current: boolean;
}

interface PermissionsPickerNavigation {
  selectedIndex: number;
}

interface PermissionsPickerModel {
  items: readonly RuntimePermissionProfileDescriptor[];
  selectedIndex: number;
}

interface SkillMentionTrigger {
  start: number;
  query: string;
}

type SkillCompletion = SlashCompletion & { skill: SkillSummary };

function pickerHeight(itemCount: number): number {
  return itemCount + 3;
}

function selectorPickerHeight(
  modelPicker: ModelPickerModel | undefined,
  reasoningPicker: ReasoningPickerModel | undefined,
  permissionsPicker: PermissionsPickerModel | undefined,
): number {
  if (modelPicker) return Math.min(modelPicker.items.length, 8) + 4;
  if (reasoningPicker) return reasoningPicker.items.length + 3;
  if (permissionsPicker) return permissionsPicker.items.length + 3;
  return 0;
}

function promptMenuItemLimit(input: {
  height: number;
  footerHeight: number;
  approvalHeight: number;
  themePickerHeight: number;
  selectorHeight: number;
  feedback: boolean;
  menuOpen: boolean;
}): number {
  if (!input.menuOpen) return PROMPT_MENU_MAX_ITEMS;
  const reserved = input.footerHeight
    + input.approvalHeight
    + input.themePickerHeight
    + input.selectorHeight
    + PROMPT_INPUT_HEIGHT
    + (input.feedback ? 1 : 0)
    + 1;
  return Math.max(1, Math.min(PROMPT_MENU_MAX_ITEMS, input.height - reserved - 3));
}

function ThemePicker(props: { model: ThemePickerModel; theme: TuiTheme }) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Theme"}</text>
      {props.model.items.map((item, index) => {
        const selected = index === props.model.selectedIndex;
        const suffix = item.id === SYSTEM_TUI_THEME_ID && !props.model.systemThemeAvailable ? " (fallback)" : "";
        return (
          <text
            key={item.id}
            fg={selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${item.name}${suffix}`}
          </text>
        );
      })}
    </box>
  );
}

function ModelPicker(props: { model: ModelPickerModel; theme: TuiTheme }) {
  const visibleItems = visiblePickerItems(props.model.items, props.model.selectedIndex, 8);
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Model"}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Filter: ${props.model.query || "all"}`}</text>
      {visibleItems.map(({ item, index }) => {
        const selected = index === props.model.selectedIndex;
        const suffix = [item.available === false ? " not configured" : "", item.current ? " *" : ""].join("");
        return (
          <text
            key={modelSelectionLabel(item.selection)}
            fg={selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${item.label} [${item.provider}]${suffix}`}
          </text>
        );
      })}
      {props.model.items.length === 0 ? (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  No matching models"}</text>
      ) : (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{modelPickerDetail(props.model)}</text>
      )}
    </box>
  );
}

function ReasoningPicker(props: { model: ReasoningPickerModel; theme: TuiTheme }) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Thinking"}</text>
      {props.model.items.map((item, index) => {
        const selected = index === props.model.selectedIndex;
        const suffix = item.current ? " *" : "";
        return (
          <text
            key={item.level}
            fg={selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${item.level.padEnd(7)} ${item.description}${suffix}`}
          </text>
        );
      })}
    </box>
  );
}

function PermissionsPicker(props: { model: PermissionsPickerModel; theme: TuiTheme }) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Update Model Permissions"}</text>
      {props.model.items.map((item, index) => {
        const selected = index === props.model.selectedIndex;
        const suffix = item.current ? " (current)" : item.disabledReason ? " (disabled)" : "";
        return (
          <text
            key={item.id}
            fg={selected ? props.theme.colors.menu.selectedText : item.disabledReason ? props.theme.colors.text.muted : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${index + 1}. ${item.label}${suffix}  ${item.description}`}
          </text>
        );
      })}
    </box>
  );
}

function modelPickerView(
  picker: ModelPickerNavigation,
  candidates: readonly ModelCandidate[],
  current: ModelSelection | undefined,
): ModelPickerModel {
  const items = filterModelCandidates(candidates, picker.query, current).map((candidate) => ({
    selection: modelDescriptorSelection(candidate),
    label: candidate.model,
    provider: candidate.provider,
    ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
    ...(candidate.available !== undefined ? { available: candidate.available } : {}),
    current: sameModelSelection(current, modelDescriptorSelection(candidate)),
  }));
  return {
    query: picker.query,
    items,
    selectedIndex: clampIndex(picker.selectedIndex, items.length),
    total: items.length,
  };
}

function reasoningPickerView(picker: ReasoningPickerNavigation, current: ReasoningLevel): ReasoningPickerModel {
  const items = REASONING_LEVELS.map((level) => ({
    level,
    description: reasoningDescription(level),
    current: level === current,
  }));
  return {
    items,
    selectedIndex: clampIndex(picker.selectedIndex, items.length),
  };
}

function permissionsPickerView(
  picker: PermissionsPickerNavigation,
  profiles: readonly RuntimePermissionProfileDescriptor[],
): PermissionsPickerModel {
  return {
    items: profiles,
    selectedIndex: clampIndex(picker.selectedIndex, profiles.length),
  };
}

function visiblePickerItems<T>(items: readonly T[], selectedIndex: number, maxVisible: number): Array<{ item: T; index: number }> {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)));
  return items.slice(start, start + maxVisible).map((item, offset) => ({ item, index: start + offset }));
}

function modelPickerDetail(model: ModelPickerModel): string {
  const selected = model.items[model.selectedIndex];
  if (!selected) return "  No matching models";
  const count = model.total > 1 ? ` (${model.selectedIndex + 1}/${model.total})` : "";
  const displayName = selected.displayName && selected.displayName !== selected.label ? ` ${selected.displayName}` : "";
  const availability = selected.available === false ? " not configured" : "";
  return `  ${modelSelectionLabel(selected.selection)}${displayName}${availability}${count}`;
}

function modelPickerIndex(
  candidates: readonly ModelCandidate[],
  query: string,
  current: ModelSelection | undefined,
): number {
  const items = filterModelCandidates(candidates, query, current);
  if (items.length === 0) return 0;
  const currentIndex = current
    ? items.findIndex((item) => sameModelSelection(current, modelDescriptorSelection(item)))
    : -1;
  return currentIndex >= 0 ? currentIndex : 0;
}

function reasoningDescription(level: ReasoningLevel): string {
  switch (level) {
    case "off":
      return "No reasoning";
    case "minimal":
      return "Very brief reasoning (~1k tokens)";
    case "low":
      return "Light reasoning (~2k tokens)";
    case "medium":
      return "Moderate reasoning (~8k tokens)";
    case "high":
      return "Deep reasoning (~16k tokens)";
    case "xhigh":
      return "Maximum reasoning (~32k tokens)";
  }
}

function activeSkillMentionTrigger(prompt: string): SkillMentionTrigger | undefined {
  const match = /(?:^|\s)\$([A-Za-z0-9._-]*)$/.exec(prompt);
  if (!match) return undefined;
  const token = match[0] ?? "";
  const query = match[1] ?? "";
  return {
    start: match.index + token.indexOf("$"),
    query,
  };
}

function skillCompletions(skills: readonly SkillSummary[], query: string): SkillCompletion[] {
  const normalized = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.hidden !== true && skill.disabled !== true)
    .filter((skill) => skillMatches(skill, normalized))
    .sort((left, right) => {
      // Priority: name starts with query first
      if (normalized) {
        const leftStarts = left.name.toLowerCase().startsWith(normalized);
        const rightStarts = right.name.toLowerCase().startsWith(normalized);
        if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      }
      return left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath);
    })
    .slice(0, 8)
    .map((skill) => ({
      value: `${skill.name}`,
      label: `$${skill.name}`,
      description: skillDescription(skill),
      category: "skills",
      skill,
    }));
}

function skillMatches(skill: SkillSummary, query: string): boolean {
  if (!query) return true;
  const haystack = `${skill.name} ${skill.description} ${skill.source}`.toLowerCase();
  return haystack.includes(query) || fuzzyMatchText(haystack, query);
}

function skillDescription(skill: SkillSummary): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return `${skill.source} ${skillPathHint(skill)}${description ? ` - ${description}` : ""}`;
}

function skillPathHint(skill: SkillSummary): string {
  const skillPath = skill.baseDir || skill.filePath;
  return skillPath.replace(/\/SKILL\.md$/, "");
}

function insertSkillMention(input: {
  skill: SkillSummary;
  trigger: SkillMentionTrigger;
  prompt: string;
  setPrompt: (value: string | ((current: string) => string)) => void;
  setSkillMentionBindings: Dispatch<SetStateAction<RuntimeSkillMention[]>>;
  history: ReturnType<typeof usePromptHistory>;
  updateAcceptedCompletionPrompt: (value: string | undefined) => void;
}): void {
  const next = `${input.prompt.slice(0, input.trigger.start)}$${input.skill.name} ${input.prompt.slice(input.trigger.start + input.trigger.query.length + 1)}`;
  input.history.resetNavigation();
  input.updateAcceptedCompletionPrompt(undefined);
  input.setSkillMentionBindings((current) => upsertSkillMentionBinding(current, {
    name: input.skill.name,
    path: input.skill.filePath,
  }));
  input.setPrompt(next);
}

function upsertSkillMentionBinding(
  bindings: readonly RuntimeSkillMention[],
  mention: RuntimeSkillMention,
): RuntimeSkillMention[] {
  const output = bindings.filter((binding) => binding.name !== mention.name);
  output.push(mention);
  return output;
}

function activeSkillMentionsOption(
  prompt: string,
  bindings: readonly RuntimeSkillMention[],
): { skillMentions?: RuntimeSkillMention[] } {
  const active = filterSkillMentionBindings(bindings, prompt);
  return active.length > 0 ? { skillMentions: active } : {};
}

function filterSkillMentionBindings(
  bindings: readonly RuntimeSkillMention[],
  prompt: string,
): RuntimeSkillMention[] {
  const activeNames = new Set(extractSkillMentionNames(prompt));
  const active = new Map<string, RuntimeSkillMention>();
  for (const binding of bindings) {
    if (!activeNames.has(binding.name)) continue;
    if (active.has(binding.name)) active.delete(binding.name);
    active.set(binding.name, binding);
  }
  return [...active.values()];
}

function localSkillMentionWarnings(
  prompt: string,
  skills: readonly SkillSummary[],
  bindings: readonly RuntimeSkillMention[],
): string[] {
  const boundNames = new Set(filterSkillMentionBindings(bindings, prompt).map((binding) => binding.name));
  const warnings: string[] = [];
  for (const name of extractSkillMentionNames(prompt)) {
    if (boundNames.has(name)) continue;
    const matches = skills.filter((skill) => skill.hidden !== true && skill.disabled !== true && skill.name === name);
    if (matches.length === 0) {
      warnings.push(`Skill $${name} was not found; it will not be injected.`);
    } else if (matches.length > 1) {
      warnings.push(`Skill $${name} is ambiguous; select it from /skills so Chili can bind the exact SKILL.md.`);
    }
  }
  return warnings;
}

function extractSkillMentionNames(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(/(^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g)) {
    const name = match[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function fuzzyMatchText(value: string, query: string): boolean {
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function HelpView(props: { commands: readonly SlashCommand[]; theme: TuiTheme; showToolDetails: boolean }) {
  const detailsText = props.showToolDetails ? "on" : "off";
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Commands"}</text>
      <box height={1} />
      {props.commands.filter((command) => !command.hidden).map((command) => (
        <text key={command.name} fg={props.theme.colors.text.secondary} wrapMode="none" truncate>
          {`/${command.name.padEnd(12)} ${command.description}`}
        </text>
      ))}
      <box height={1} />
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"!cmd runs a local shell command without asking the model."}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Esc closes views. Ctrl+C clears input; press again quickly to exit. Ctrl+P opens commands. Ctrl+O toggles tool details (${detailsText}). Ctrl+T opens transcript. Ctrl+V pastes. Ctrl+Shift+C copies.`}</text>
    </box>
  );
}

function StatusView(props: {
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: StatusFooterOptions;
  theme: TuiTheme;
  showToolDetails: boolean;
  hideThinking: boolean;
  transcriptActive: boolean;
}) {
  const selected = props.model.selected;
  const modelLabel = props.options.modelSelection
    ? modelSelectionLabel(props.options.modelSelection)
    : `${props.options.providerName}/${props.options.modelName}`;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Status"}</text>
      <box height={1} />
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`connection: ${props.model.connection.status}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`session: ${props.runtime.activeSessionId ?? "none"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`thread: ${props.runtime.activeThreadId ?? "none"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`mode: ${props.options.modeName}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`model: ${modelLabel}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`thinking: ${props.options.reasoningLevel ?? "default"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`service tier: ${props.options.serviceTier ?? "standard"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`thinking traces: ${props.hideThinking ? "hidden" : "shown"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`details: ${props.showToolDetails ? "on" : "off"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`transcript: ${props.transcriptActive ? "on" : "off"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`cwd: ${props.options.cwd}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`team: ${selected?.team.name ?? selected?.team.id ?? "none"}`}</text>
    </box>
  );
}

function AgentsView(props: { model: TeamLiveView; theme: TuiTheme }) {
  const members = props.model.selected?.members ?? [];
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Agents"}</text>
      <box height={1} />
      {members.length === 0 ? (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"No active agents yet."}</text>
      ) : (
        members.slice(0, 10).map((member) => (
          <text key={member.id} fg={props.theme.colors.text.secondary} wrapMode="none" truncate>
            {`${member.isLead ? "lead" : "agent"} ${member.name ?? member.path} ${member.status}`}
          </text>
        ))
      )}
    </box>
  );
}

async function submitPrompt(
  prompt: string,
  expandedPrompt: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
  onAccepted?: (text: string) => void,
  skillMentionBindings: readonly RuntimeSkillMention[] = [],
  skills: readonly SkillSummary[] = [],
  pastedImages: Readonly<Record<number, PastedPromptImage>> = {},
  clearPromptAttachments?: () => void,
): Promise<void> {
  const visibleTrimmed = prompt.trim();
  const trimmed = expandedPrompt.trim();
  if (!visibleTrimmed && !trimmed) return;
  const commandPrompt = visibleTrimmed || trimmed;
  if (commandPrompt.startsWith("!")) {
    actions.setPrompt("");
    clearPromptAttachments?.();
    const command = trimmed.slice(1).trim();
    if (!command) {
      actions.appendLocalItem("info", "Prefix a command with ! to run it locally\nExample: !ls", { persistent: true });
      return;
    }
    onAccepted?.(`!${command}`);
    await runUserShellCommand(command, actions.cwd, actions);
    return;
  }
  if (commandPrompt.startsWith("/")) {
    const slashMatch = resolveSlashCommand(commands, commandPrompt);
    if (slashMatch) {
      actions.setPrompt("");
      clearPromptAttachments?.();
      await runResolvedSlashCommand(slashMatch, ctx, model, runtime, actions);
      return;
    }
    if (isSlashCommandCandidate(commands, ctx, commandPrompt)) {
      actions.appendLocalItem("error", `Unknown command: ${commandPrompt}`);
      return;
    }
  }
  if (!runtime.canSubmit) {
    actions.appendLocalItem("error", runtime.submitBlockedReason ?? "Session is not ready for another prompt.");
    return;
  }
  for (const warning of localSkillMentionWarnings(visibleTrimmed, skills, skillMentionBindings)) {
    actions.appendLocalItem("info", warning);
  }
  const images = promptImagesForSubmit(visibleTrimmed, pastedImages);
  const modelCandidates = ctx.modelCandidates ?? [];
  const supportsImages = modelSupportsImages(ctx.modelSelection, modelCandidates);
  const text = images.length > 0 && !supportsImages
    ? textWithImagePathContext(trimmed, promptReferencedImages(visibleTrimmed, pastedImages))
    : trimmed;
  const accepted = await runtime.submitPrompt(text, {
    ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
    ...(ctx.reasoningLevel ? { reasoningLevel: ctx.reasoningLevel } : {}),
    ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
    ...(text !== trimmed ? { displayText: visibleTrimmed } : {}),
    ...(images.length > 0 && supportsImages ? { images } : {}),
    ...activeSkillMentionsOption(visibleTrimmed, skillMentionBindings),
  });
  if (accepted) {
    onAccepted?.(trimmed);
    actions.setPrompt("");
    clearPromptAttachments?.();
  }
}

async function runUserShellCommand(command: string, cwd: string, actions: SlashActions): Promise<void> {
  const id = actions.appendShellItem({
    command,
    cwd,
    status: "running",
    output: "",
  });
  try {
    const result = await runProcess("bash", ["-lc", command], {
      cwd,
      timeoutMs: USER_SHELL_TIMEOUT_MS,
      maxOutputBytes: USER_SHELL_OUTPUT_LIMIT_BYTES,
    });
    actions.updateShellItem(id, {
      status: result.exitCode === 0 && !result.timedOut ? "completed" : "failed",
      output: formatUserShellOutput(result),
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });
  } catch (error) {
    actions.updateShellItem(id, {
      status: "failed",
      output: "",
      error: errorMessage(error),
    });
  }
}

function formatUserShellOutput(result: RunProcessResult): string {
  const sections: string[] = [];
  if (result.stdout) sections.push(result.stdout.trimEnd());
  if (result.stderr) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  return sections.filter((section) => section.length > 0).join("\n\n");
}

async function runSlashInput(
  input: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
): Promise<void> {
  const match = resolveSlashCommand(commands, input);
  if (!match) {
    actions.appendLocalItem("error", `Unknown command: ${input}`);
    return;
  }
  await runResolvedSlashCommand(match, ctx, model, runtime, actions);
}

async function runResolvedSlashCommand(
  match: { command: SlashCommand; args: string },
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
): Promise<void> {
  const result = await match.command.run(ctx, match.args);
  await applySlashResult(result, ctx, model, runtime, actions);
}

async function applySlashResult(
  result: SlashCommandResult,
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
): Promise<void> {
  if (result.type === "open_view") {
    if (result.view === "mcp") {
      actions.openMcpManager();
      return;
    }
    actions.setView(result.view);
    return;
  }
  if (result.type === "close_view") {
    actions.setView("chat");
    return;
  }
  if (result.type === "open_theme_picker") {
    actions.openThemePicker();
    return;
  }
  if (result.type === "reload_commands") {
    await actions.reloadCommands();
    return;
  }
  if (result.type === "submit_command") {
    if (!runtime.canSubmit) {
      actions.appendLocalItem("error", runtime.submitBlockedReason ?? "Session is not ready for another prompt.");
      return;
    }
    const accepted = await runtime.submitCommand(result.commandName, result.args, {
      ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
      ...(ctx.reasoningLevel ? { reasoningLevel: ctx.reasoningLevel } : {}),
      ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
    });
    if (!accepted) actions.appendLocalItem("error", `/${result.commandName} did not submit.`);
    return;
  }
  if (result.type === "open_permissions_picker") {
    actions.openPermissionsPicker();
    return;
  }
  if (result.type === "new_session") {
    await actions.startNewChatSession();
    return;
  }
  if (result.type === "goal_action") {
    await performGoalAction(result, runtime, actions.appendLocalItem);
    return;
  }
  if (result.type === "insert_prompt") {
    actions.setPrompt(result.text);
    return;
  }
  if (result.type === "local_message") {
    actions.appendLocalItem(result.level, result.text);
    return;
  }
  if (result.type === "open_model_picker") {
    actions.openModelPicker(result.query ?? "");
    return;
  }
  if (result.type === "set_model") {
    await actions.setModelSelection(result.selection, result.reasoningLevel);
    return;
  }
  if (result.type === "open_reasoning_picker") {
    actions.openReasoningPicker();
    return;
  }
  if (result.type === "set_reasoning") {
    await actions.setReasoningLevel(result.level);
    return;
  }
  if (result.type === "set_service_tier") {
    await actions.setServiceTier(result.serviceTier);
    return;
  }
  if (result.type === "set_hide_thinking") {
    actions.setHideThinking(result.hidden);
    return;
  }
  if (result.type === "auth_action") {
    await performAuthAction(result, actions.appendLocalItem, actions.setAuthManualPrompt, actions.ensureOpenAICodexDefaultModel);
    return;
  }
  if (result.type === "skills_action") {
    await performSkillsAction(result, actions);
    return;
  }
  if (result.type === "mcp_action") {
    await performMcpAction(result, runtime, actions.appendLocalItem);
    return;
  }
  if (result.type === "sdk_action") {
    const action = actionForSlashResult(result, model);
    if (action) runtime.executeAction(action);
  }
}

async function performGoalAction(
  result: Extract<SlashCommandResult, { type: "goal_action" }>,
  runtime: ChatRuntimeState,
  appendLocalItem: AppendLocalItem,
): Promise<void> {
  if (result.action === "show") {
    const goal = runtime.chatView.goal;
    appendLocalItem("info", goal ? goalSummary(goal) : "No goal set for this thread.");
    return;
  }
  if (result.action === "set") {
    if (!result.objective) {
      appendLocalItem("error", "Goal objective is required.");
      return;
    }
    const goal = await runtime.setGoal({
      objective: result.objective,
      ...(result.tokenBudget !== undefined ? { tokenBudget: result.tokenBudget } : {}),
    });
    if (goal) appendLocalItem("info", `Goal set: ${goal.objective}`);
    return;
  }
  if (result.action === "pause") {
    const goal = await runtime.pauseGoal();
    if (goal) appendLocalItem("info", "Goal paused.");
    return;
  }
  if (result.action === "resume") {
    const goal = await runtime.resumeGoal();
    if (goal) appendLocalItem("info", "Goal resumed.");
    return;
  }
  const cleared = await runtime.clearGoal();
  appendLocalItem("info", cleared ? "Goal cleared." : "No goal to clear.");
}

function goalSummary(goal: NonNullable<ChatRuntimeState["chatView"]["goal"]>): string {
  const budget = goal.tokenBudget !== undefined
    ? `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`
    : `${formatTokenCount(goal.tokensUsed)} used`;
  return `Goal ${goal.status}: ${goal.objective} (${budget}, ${Math.round(goal.timeUsedSeconds)}s)`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

async function performSkillsAction(
  result: Extract<SlashCommandResult, { type: "skills_action" }>,
  actions: SlashActions,
): Promise<void> {
  const scope: SkillSettingsScope = result.scope ?? "project";
  try {
    await updateSkillDisabledSetting({
      cwd: actions.cwd,
      scope,
      name: result.name,
      disabled: result.action === "disable",
    });
    await actions.reloadSkills();
    const nextState = result.action === "disable" ? "disabled" : "enabled";
    actions.appendLocalItem("info", `Skill $${result.name} ${nextState} (${scope}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.appendLocalItem("error", `Could not ${result.action} skill $${result.name}: ${message}`);
  }
}

async function performMcpAction(
  result: Extract<SlashCommandResult, { type: "mcp_action" }>,
  runtime: ChatRuntimeState,
  appendLocalItem: AppendLocalItem,
): Promise<void> {
  if (result.action === "status" || result.action === "list") {
    if (!runtime.refreshMcpStatus) {
      appendLocalItem("error", "MCP control is not available from this runtime.");
      return;
    }
    if (result.action === "status" && result.server) {
      const server = runtime.getMcpServer
        ? await runtime.getMcpServer(result.server)
        : (await runtime.refreshMcpStatus())?.servers.find((item) => item.name === result.server);
      appendLocalItem(server ? "info" : "error", server ? formatMcpServerDetail(server) : `MCP server not found: ${result.server}`, { persistent: true });
      return;
    }
    const status = await runtime.refreshMcpStatus();
    appendLocalItem(status ? "info" : "error", status ? formatMcpStatus(status) : "Could not load MCP status.", { persistent: true });
    return;
  }

  if (result.action === "reload") {
    if (!runtime.reloadMcp) {
      appendLocalItem("error", "MCP reload is not available from this runtime.");
      return;
    }
    const reloaded = await runtime.reloadMcp();
    if (!reloaded) {
      appendLocalItem("error", "Could not reload MCP configuration.", { persistent: true });
      return;
    }
    await runtime.reloadCommands?.();
    appendLocalItem("info", formatMcpReload(reloaded), { persistent: true });
    return;
  }

  if (result.action === "tools") {
    if (!runtime.listMcpTools) {
      appendLocalItem("error", "MCP tools listing is not available from this runtime.");
      return;
    }
    const tools = await runtime.listMcpTools(result.server);
    appendLocalItem(tools ? "info" : "error", tools ? formatMcpTools(tools) : `Could not list tools for MCP server: ${result.server}`, { persistent: true });
    return;
  }

  if (result.action === "add") {
    if (!runtime.addMcpServer) {
      appendLocalItem("error", "MCP add is not available from this runtime.");
      return;
    }
    const server = await runtime.addMcpServer(result.input);
    appendLocalItem(server ? "info" : "error", server ? `MCP server added:\n${formatMcpServerLine(server)}` : `Could not add MCP server: ${result.input.name}`, { persistent: true });
    return;
  }

  if (result.action === "remove") {
    if (!runtime.removeMcpServer) {
      appendLocalItem("error", "MCP remove is not available from this runtime.");
      return;
    }
    const removed = await runtime.removeMcpServer(result.server);
    appendLocalItem(removed ? "info" : "error", removed ? formatMcpRemove(removed) : `Could not remove MCP server: ${result.server}`, { persistent: true });
    return;
  }

  if (result.action === "auth") {
    if (!runtime.authMcpServer) {
      appendLocalItem("error", "MCP auth is not available from this runtime.");
      return;
    }
    const auth = await runtime.authMcpServer(result.server, result.request);
    if (!auth) {
      appendLocalItem("error", `Could not authenticate MCP server: ${result.server}`, { persistent: true });
      return;
    }
    appendLocalItem("info", formatMcpAuth(auth), { persistent: true });
    if (auth.url) {
      void openExternalUrl(auth.url).catch((error) => {
        appendLocalItem("error", `Could not open MCP auth URL automatically: ${errorMessage(error)}`, { persistent: true });
      });
    }
    return;
  }

  if (result.action === "logout") {
    if (!runtime.logoutMcpServer) {
      appendLocalItem("error", "MCP logout is not available from this runtime.");
      return;
    }
    const logout = await runtime.logoutMcpServer(result.server);
    appendLocalItem(logout ? "info" : "error", logout ? formatMcpLogout(logout) : `Could not log out MCP server: ${result.server}`, { persistent: true });
  }
}

function formatMcpStatus(status: RuntimeMcpStatusResponse): string {
  const summary = status.summary;
  const lines = [
    `MCP servers: total=${summary.total} running=${summary.running} disabled=${summary.disabled} auth_required=${summary.authRequired} errored=${summary.errored}`,
  ];
  if (status.servers.length === 0) {
    lines.push("No MCP servers configured.");
    return lines.join("\n");
  }
  for (const server of status.servers) lines.push(formatMcpServerLine(server));
  return lines.join("\n");
}

function formatMcpServerDetail(server: RuntimeMcpServerDescriptor): string {
  const lines = [
    `MCP server: ${server.name}`,
    `status: ${server.status}`,
    `enabled: ${server.enabled ? "yes" : "no"}`,
    `transport: ${server.transport ?? "unknown"}`,
    `auth: ${mcpAuthLabel(server)}`,
    `tools: ${server.toolCount ?? "?"}`,
  ];
  const endpoint = mcpEndpoint(server);
  if (endpoint !== "-") lines.push(`endpoint: ${endpoint}`);
  if (server.description) lines.push(`description: ${server.description}`);
  if (server.error) lines.push(`error: ${server.error}`);
  return lines.join("\n");
}

function formatMcpReload(result: RuntimeMcpReloadResponse): string {
  const lines = [
    `MCP reloaded: ${result.reloaded ? "yes" : "no"} servers=${result.servers.length} errors=${result.errors.length}`,
  ];
  for (const error of result.errors) lines.push(`error ${error.server ?? "-"}: ${error.message}`);
  for (const server of result.servers) lines.push(formatMcpServerLine(server));
  lines.push("Prompt commands refreshed.");
  return lines.join("\n");
}

function formatMcpTools(result: RuntimeMcpToolsResponse): string {
  const limit = 40;
  const lines = [`MCP tools for ${result.server}: ${result.tools.length}`];
  if (result.tools.length === 0) {
    lines.push("No tools discovered.");
    return lines.join("\n");
  }
  for (const tool of result.tools.slice(0, limit)) lines.push(formatMcpToolLine(tool));
  if (result.tools.length > limit) lines.push(`Showing first ${limit} of ${result.tools.length} tools.`);
  return lines.join("\n");
}

function formatMcpToolLine(tool: RuntimeMcpToolDescriptor): string {
  const description = tool.description?.replace(/\s+/g, " ").trim();
  return `- ${tool.name}${description ? `: ${shorten(description, 140)}` : ""}`;
}

function formatMcpRemove(result: RuntimeMcpRemoveServerResponse): string {
  return result.removed
    ? `MCP server removed: ${result.server}`
    : `MCP server was not found in user config: ${result.server}`;
}

function formatMcpAuth(result: RuntimeMcpAuthResponse): string {
  const lines = [`MCP auth ${result.server}: ${result.status}`];
  if (result.message) lines.push(result.message);
  if (result.url) lines.push(`Open: ${result.url}`);
  return lines.join("\n");
}

function formatMcpLogout(result: RuntimeMcpLogoutResponse): string {
  return result.loggedOut
    ? `MCP server logged out: ${result.server}`
    : `MCP server had no auth session: ${result.server}`;
}

function formatMcpServerLine(server: RuntimeMcpServerDescriptor): string {
  return [
    server.name,
    server.status,
    server.enabled ? "enabled" : "disabled",
    server.transport ?? "-",
    `auth=${mcpAuthLabel(server)}`,
    `tools=${server.toolCount ?? "?"}`,
    mcpEndpoint(server),
    server.error ? `error=${server.error}` : "",
  ].filter(Boolean).join("  ");
}

function mcpAuthLabel(server: RuntimeMcpServerDescriptor): string {
  if (!server.auth?.required) return "none";
  if (server.auth.authenticated) return "authenticated";
  return "required";
}

function mcpEndpoint(server: RuntimeMcpServerDescriptor): string {
  if (server.url) return server.url;
  if (server.command) return [server.command, ...(server.args ?? [])].join(" ");
  return "-";
}

async function performAuthAction(
  result: Extract<SlashCommandResult, { type: "auth_action" }>,
  appendLocalItem: AppendLocalItem,
  setAuthManualPrompt: (value: AuthManualPrompt | undefined) => void,
  onLoginComplete?: () => Promise<void>,
): Promise<void> {
  if (result.provider !== OPENAI_CODEX_PROVIDER_ID) {
    appendLocalItem("error", `Unsupported auth provider: ${result.provider}`);
    return;
  }

  const storage = new FileAuthStorage();
  if (result.action === "status") {
    const status = await storage.status(OPENAI_CODEX_PROVIDER_ID);
    const text = status.configured
      ? `ChatGPT Codex auth: ${status.type}${status.accountId ? ` account ${status.accountId}` : ""}${status.expires ? `, expires ${formatAuthTime(status.expires)}` : ""}. Stored at ${status.authPath}.`
      : `ChatGPT Codex auth: not configured. Run /login to connect a ChatGPT Plus/Pro account. Auth file: ${status.authPath}.`;
    appendLocalItem("info", text);
    return;
  }

  if (result.action === "logout") {
    const removed = await storage.remove(OPENAI_CODEX_PROVIDER_ID);
    appendLocalItem("info", removed ? "Removed ChatGPT Codex credentials." : "No ChatGPT Codex credentials were stored.");
    return;
  }

  appendLocalItem("info", "Starting ChatGPT Codex login...");
  try {
    const credentials = await loginOpenAICodex({
      originator: "chili",
      onAuth: ({ url }: { url: string }) => {
        appendLocalItem("info", `Browser login opened. If it does not open, visit: ${url}`);
        void openExternalUrl(url).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          appendLocalItem("error", `Could not open browser automatically: ${message}`);
        });
      },
      onProgress: (message: string) => {
        appendLocalItem("info", message);
      },
      onManualCodeInput: () => new Promise<string>((resolve, reject) => {
        setAuthManualPrompt({ resolve, reject });
        appendLocalItem("info", "If browser login stalls, paste the full redirect URL or authorization code here and press Enter.");
      }),
      onPrompt: async () => {
        throw new Error("Local callback did not complete. Run /login again and keep the browser redirect window open.");
      },
    });
    await storage.setOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, credentials);
    appendLocalItem("info", `ChatGPT Codex login complete for account ${credentials.accountId}. Token expires ${formatAuthTime(credentials.expires)}.`);
    await onLoginComplete?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLocalItem("error", `ChatGPT Codex login failed: ${message}`);
  } finally {
    setAuthManualPrompt(undefined);
  }
}

async function openExternalUrl(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  await execFileAsync("xdg-open", [url]);
}

async function openLocalFileTarget(target: FileLinkTarget): Promise<void> {
  const zedTarget = zedPathWithPosition(target);
  try {
    await execFileAsync("zed", ["--existing", zedTarget]);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await openExternalUrl(target.path);
}

function formatAuthTime(value: number): string {
  return new Date(value).toLocaleString();
}

function actionForSlashResult(result: Extract<SlashCommandResult, { type: "sdk_action" }>, model: TeamLiveView): TeamLiveAction | undefined {
  const actions = model.selected?.availableActions ?? model.availableActions;
  if (result.action === "team_run") {
    return findAction(actions, "run_loop") ?? { type: "run_loop", ...(model.selectedTeamId ? { teamId: model.selectedTeamId } : {}), enabled: false, reason: "no_team" };
  }
  if (result.action === "team_merge") {
    return findAction(actions, "merge") ?? { type: "merge", ...(model.selectedTeamId ? { teamId: model.selectedTeamId } : {}), enabled: false, reason: "no_pending_merge" };
  }
  if (result.action === "approve") return findAction(actions, "approve");
  if (result.action === "reject") return findAction(actions, "reject");
  return undefined;
}

function isSlashCommandCandidate(commands: readonly SlashCommand[], ctx: SlashCommandContext, input: string): boolean {
  if (input.trim() === "/") return true;
  return slashCompletions(commands, ctx, input, 1).length > 0;
}

function handlePaletteKey(
  key: KeyEvent,
  items: readonly SlashCompletion[],
  selectedIndex: number,
  setSelectedIndex: (value: number) => void,
  onSelect: (completion: SlashCompletion) => void,
  onCancel: () => void,
): void {
  if (isEscape(key)) {
    onCancel();
    return;
  }
  if (isArrowUp(key) || isArrowDown(key)) {
    const delta = isArrowUp(key) ? -1 : 1;
    const next = Math.min(Math.max(0, selectedIndex + delta), Math.max(0, items.length - 1));
    setSelectedIndex(next);
    return;
  }
  if (isEnter(key)) {
    const item = items[selectedIndex] ?? items[0];
    if (item) onSelect(item);
  }
}

function handleModelPickerKey(
  key: KeyEvent,
  picker: ModelPickerNavigation,
  candidates: readonly ModelCandidate[],
  current: ModelSelection | undefined,
  actions: {
    setModelPicker: Dispatch<SetStateAction<ModelPickerNavigation | undefined>>;
    selectModel: (selection: ModelSelection) => Promise<void>;
    cancel: () => void;
  },
): void {
  if (isEscape(key)) {
    actions.cancel();
    return;
  }
  const items = filterModelCandidates(candidates, picker.query, current);
  if (isArrowUp(key) || isArrowDown(key)) {
    const delta = isArrowUp(key) ? -1 : 1;
    actions.setModelPicker((state) => state ? { ...state, selectedIndex: clampIndex(state.selectedIndex + delta, items.length) } : state);
    return;
  }
  if (isEnter(key)) {
    const selected = items[clampIndex(picker.selectedIndex, items.length)];
    if (selected) void actions.selectModel(modelDescriptorSelection(selected));
    return;
  }
  if (isBackspace(key)) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const query = state.query.slice(0, -1);
      return { query, selectedIndex: modelPickerIndex(candidates, query, current) };
    });
    return;
  }
  const printable = printableKey(key);
  if (printable) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const query = `${state.query}${printable}`;
      return { query, selectedIndex: modelPickerIndex(candidates, query, current) };
    });
  }
}

function handleReasoningPickerKey(
  key: KeyEvent,
  picker: ReasoningPickerNavigation,
  actions: {
    setReasoningPicker: Dispatch<SetStateAction<ReasoningPickerNavigation | undefined>>;
    selectLevel: (level: ReasoningLevel) => Promise<void>;
    cancel: () => void;
  },
): void {
  if (isEscape(key)) {
    actions.cancel();
    return;
  }
  if (isArrowUp(key) || isArrowDown(key)) {
    const delta = isArrowUp(key) ? -1 : 1;
    actions.setReasoningPicker((state) => state ? { selectedIndex: clampIndex(state.selectedIndex + delta, REASONING_LEVELS.length) } : state);
    return;
  }
  if (isEnter(key)) {
    const level = REASONING_LEVELS[clampIndex(picker.selectedIndex, REASONING_LEVELS.length)];
    if (level) void actions.selectLevel(level);
  }
}

function handlePermissionsPickerKey(
  key: KeyEvent,
  picker: PermissionsPickerNavigation,
  profiles: readonly RuntimePermissionProfileDescriptor[],
  actions: {
    setPermissionsPicker: Dispatch<SetStateAction<PermissionsPickerNavigation | undefined>>;
    selectProfile: (profile: RuntimePermissionProfileId) => Promise<void>;
    cancel: () => void;
  },
): void {
  if (isEscape(key)) {
    actions.cancel();
    return;
  }
  if (isArrowUp(key) || isArrowDown(key)) {
    const delta = isArrowUp(key) ? -1 : 1;
    actions.setPermissionsPicker((state) => state ? { selectedIndex: clampIndex(state.selectedIndex + delta, profiles.length) } : state);
    return;
  }
  const numericIndex = numericShortcutIndex(key);
  if (numericIndex !== undefined) {
    const profile = profiles[numericIndex];
    if (profile) void actions.selectProfile(profile.id);
    return;
  }
  if (isEnter(key)) {
    const profile = profiles[clampIndex(picker.selectedIndex, profiles.length)];
    if (profile) void actions.selectProfile(profile.id);
  }
}

function currentFeedback(runtime: ChatRuntimeState): { status: string; message: string } | undefined {
  if (runtime.chatFeedback) return runtime.chatFeedback;
  if (runtime.actionFeedback) return runtime.actionFeedback;
  return undefined;
}

interface ClipboardRenderer {
  getSelection?: () => Selection | null;
  copyToClipboardOSC52?: (text: string) => boolean;
  on?: (event: "selection", handler: (selection: Selection) => void) => void;
  off?: (event: "selection", handler: (selection: Selection) => void) => void;
}

function clipboardCopySource(renderer: ClipboardRenderer, items: readonly ChatTranscriptItem[], view: ShellView): { text: string; label: string } | undefined {
  const selected = cleanClipboardText(renderer.getSelection?.()?.getSelectedText() ?? "");
  if (selected) return { text: selected, label: "selection" };

  if (view === "transcript") {
    const transcript = buildTranscriptText(items).trimEnd();
    if (transcript.trim()) return { text: transcript, label: "transcript" };
  }

  const assistant = latestAssistantText(items);
  if (assistant) return { text: assistant, label: "latest assistant reply" };
  return undefined;
}

async function copyClipboardText(text: string, clipboard: ClipboardAccess, renderer: ClipboardRenderer): Promise<boolean> {
  const systemCopied = await clipboard.writeText(text).catch(() => false);
  if (systemCopied) return true;
  return Boolean(renderer.copyToClipboardOSC52?.(text));
}

function latestAssistantText(items: readonly ChatTranscriptItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "message" || item.role !== "assistant") continue;
    const text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n");
    if (text.trim()) return text;
  }
  return undefined;
}

function chatShellExitInfo(runtime: ChatRuntimeState, cwd: string | undefined): ChatShellExitInfo | undefined {
  const sessionId = runtime.activeSessionId ?? runtime.chatView.sessionId;
  const threadId = runtime.activeThreadId ?? runtime.chatView.threadId;
  if (!sessionId && !threadId && !cwd) return undefined;
  const info: ChatShellExitInfo = {};
  if (sessionId) info.sessionId = sessionId;
  if (threadId) info.threadId = threadId;
  if (cwd) info.cwd = cwd;
  return info;
}

function useSkillSummaries(cwd: string): SkillSummariesState {
  const [state, setState] = useState<{ skills: readonly SkillSummary[]; allSkills: readonly SkillSummary[] }>({
    skills: [],
    allSkills: [],
  });
  const load = useCallback(async () => {
    const [activeRegistry, allRegistry] = await Promise.all([
      discoverSkills({ cwd }),
      discoverSkills({ cwd, includeDisabled: true }),
    ]);
    setState({
      skills: activeRegistry.listAll(),
      allSkills: allRegistry.listAll(),
    });
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      discoverSkills({ cwd }),
      discoverSkills({ cwd, includeDisabled: true }),
    ])
      .then(([activeRegistry, allRegistry]) => {
        if (cancelled) return;
        setState({
          skills: activeRegistry.listAll(),
          allSkills: allRegistry.listAll(),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ skills: [], allSkills: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  return {
    ...state,
    reload: load,
  };
}

function useGitBranch(cwd: string, explicitBranch: string | undefined): string | undefined {
  const [branch, setBranch] = useState<string | undefined>(explicitBranch);
  useEffect(() => {
    if (explicitBranch) {
      setBranch(explicitBranch);
      return;
    }

    let cancelled = false;
    setBranch(undefined);
    void execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: 1000 })
      .then(({ stdout }) => {
        if (cancelled) return;
        const next = String(stdout).trim();
        setBranch(next || undefined);
      })
      .catch(() => {
        if (!cancelled) setBranch(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, explicitBranch]);
  return branch;
}

export function isWithinCtrlCExitWindow(previousPressMs: number | undefined, nowMs: number): boolean {
  if (previousPressMs === undefined) return false;
  const elapsedMs = nowMs - previousPressMs;
  return elapsedMs >= 0 && elapsedMs <= CTRL_C_EXIT_CONFIRM_MS;
}

function setPromptText(
  setPromptParts: (value: PromptPart[] | ((current: PromptPart[]) => PromptPart[])) => void,
  pastedTextByMarkerRef: { current: Map<string, string> },
) {
  return (value: string | ((current: string) => string)) => {
    setPromptParts((current) => {
      const currentText = promptText(current);
      const next = typeof value === "function" ? value(currentText) : value;
      const nextParts = reconcilePromptParts(next, pastedTextByMarkerRef.current);
      prunePromptPasteMarkers(pastedTextByMarkerRef.current, nextParts);
      return nextParts;
    });
  };
}

function promptText(parts: readonly PromptPart[]): string {
  return parts.map((part) => part.type === "paste" ? part.marker : part.text).join("");
}

function expandedPromptText(parts: readonly PromptPart[]): string {
  return parts.map((part) => part.text).join("");
}

function reconcilePromptParts(text: string, pastedTextByMarker: ReadonlyMap<string, string>): PromptPart[] {
  if (text.length === 0) return [{ type: "text", text: "" }];
  const markers = Array.from(pastedTextByMarker.keys()).sort((left, right) => right.length - left.length);
  if (markers.length === 0) return [{ type: "text", text }];

  const parts: PromptPart[] = [];
  let buffer = "";
  let index = 0;
  while (index < text.length) {
    const marker = markers.find((candidate) => text.startsWith(candidate, index));
    if (!marker) {
      buffer += text[index] ?? "";
      index += 1;
      continue;
    }
    if (buffer) {
      parts.push({ type: "text", text: buffer });
      buffer = "";
    }
    parts.push({ type: "paste", marker, text: pastedTextByMarker.get(marker) ?? marker });
    index += marker.length;
  }
  if (buffer) parts.push({ type: "text", text: buffer });
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function prunePromptPasteMarkers(pastedTextByMarker: Map<string, string>, parts: readonly PromptPart[]): void {
  const active = new Set(parts.flatMap((part) => part.type === "paste" ? [part.marker] : []));
  for (const marker of pastedTextByMarker.keys()) {
    if (!active.has(marker)) pastedTextByMarker.delete(marker);
  }
}

function shouldCollapsePromptTextPaste(text: string): boolean {
  const lineCount = text.split("\n").length;
  return lineCount >= PROMPT_TEXT_PASTE_LINE_THRESHOLD || text.length >= PROMPT_TEXT_PASTE_CHAR_THRESHOLD;
}

function promptTextPasteMarker(text: string): string {
  const lineCount = text.split("\n").length;
  if (lineCount >= PROMPT_TEXT_PASTE_LINE_THRESHOLD) return `[Pasted ~${lineCount} lines]`;
  return `[Pasted ~${text.length} chars]`;
}

function uniquePromptTextPasteMarker(
  marker: string,
  pastedTextByMarker: ReadonlyMap<string, string>,
  nextIdRef: { current: number },
): string {
  if (!pastedTextByMarker.has(marker)) return marker;
  let next: string;
  do {
    next = marker.replace(/\]$/, ` #${nextIdRef.current++}]`);
  } while (pastedTextByMarker.has(next));
  return next;
}

function imagePlaceholder(id: number): string {
  return `[Image #${id}]`;
}

function imagePlaceholderIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) ids.add(value);
  }
  return ids;
}

function filterPastedImagesByPrompt(
  images: Readonly<Record<number, PastedPromptImage>>,
  prompt: string,
): Record<number, PastedPromptImage> {
  const referenced = imagePlaceholderIds(prompt);
  const entries = Object.entries(images).filter(([id]) => referenced.has(Number(id)));
  if (entries.length === Object.keys(images).length) return images as Record<number, PastedPromptImage>;
  return Object.fromEntries(entries) as Record<number, PastedPromptImage>;
}

function promptImagesForSubmit(prompt: string, images: Readonly<Record<number, PastedPromptImage>>): MessageImageContent[] {
  const output: MessageImageContent[] = [];
  for (const image of promptReferencedImages(prompt, images)) {
    const item: MessageImageContent = {
      data: image.data,
      mimeType: image.mimeType,
    };
    if (image.filename) item.filename = image.filename;
    if (image.sourcePath) item.sourcePath = image.sourcePath;
    output.push(item);
  }
  return output;
}

function promptReferencedImages(prompt: string, images: Readonly<Record<number, PastedPromptImage>>): PastedPromptImage[] {
  const referenced = imagePlaceholderIds(prompt);
  const output: PastedPromptImage[] = [];
  for (const id of referenced) {
    const image = images[id];
    if (image) output.push(image);
  }
  return output;
}

function textWithImagePathContext(prompt: string, images: readonly PastedPromptImage[]): string {
  const lines = images
    .map((image) => {
      const path = image.sourcePath ?? image.filename ?? `Image #${image.id}`;
      const absolute = image.absolutePath ? ` absolutePath=${image.absolutePath}` : "";
      return `- [Image #${image.id}] path=${path}${absolute}`;
    });
  if (lines.length === 0) return prompt;
  return [
    prompt,
    "",
    "<pasted_image_files>",
    ...lines,
    "Direct image input is unavailable. Use an available MCP image-understanding or OCR tool that returns text with the matching absolutePath/path.",
    "Do not use read_image unless no text-returning image MCP tool is available.",
    "</pasted_image_files>",
  ].join("\n");
}

async function saveClipboardImage(cwd: string, image: ClipboardImage): Promise<{ relativePath: string; absolutePath: string; filename: string }> {
  const dir = join(cwd, ".chili", "clipboard-images");
  await mkdir(dir, { recursive: true });
  const extension = safeImageExtension(image.extension, image.mimeType);
  const filename = `clipboard-${timestampForFilename(new Date())}-${process.hrtime.bigint().toString(36)}.${extension}`;
  const absolutePath = join(dir, filename);
  await writeFile(absolutePath, image.bytes);
  return { relativePath: `.chili/clipboard-images/${filename}`, absolutePath, filename };
}

function safeImageExtension(extension: string, mimeType: string): string {
  const normalized = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "png" || normalized === "jpg" || normalized === "jpeg" || normalized === "gif" || normalized === "webp") {
    return normalized === "jpeg" ? "jpg" : normalized;
  }
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function timestampForFilename(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function localItem(level: "info" | "error", text: string, persistent?: boolean | undefined): LocalTranscriptItem {
  return { id: `${Date.now()}:${level}:${text}`, kind: "local", level, text, ...(persistent ? { persistent } : {}) };
}

function clearLocalItemTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validSelectedTeamId(model: TeamLiveView, selectedTeamId: TeamId | undefined): TeamId | undefined {
  if (selectedTeamId && model.teams.some((team) => team.id === selectedTeamId)) return selectedTeamId;
  return model.selectedTeamId ?? model.teams[0]?.id;
}

function themeOptionIndex(options: readonly TuiThemeOption[], themeId: string): number {
  const index = options.findIndex((option) => option.id === themeId);
  return index < 0 ? 0 : index;
}

function printableKey(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.super || key.hyper) return undefined;
  if (key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f") return key.sequence;
  if (key.name.length === 1) return key.name;
  return undefined;
}

function isPlainRefreshKey(key: KeyEvent): boolean {
  return printableKey(key)?.toLowerCase() === "r";
}

function numericShortcutIndex(key: KeyEvent): number | undefined {
  if (hasModifier(key)) return undefined;
  const value = key.sequence.length === 1 ? key.sequence : key.name;
  if (!/^[1-9]$/.test(value)) return undefined;
  return Number(value) - 1;
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter";
}

function isEscape(key: KeyEvent): boolean {
  return key.name === "escape" || key.sequence === "\x1b";
}

function isBackspace(key: KeyEvent): boolean {
  return key.name === "backspace" || key.sequence === "\b" || key.sequence === "\x7f";
}

function isTab(key: KeyEvent): boolean {
  return key.name === "tab";
}

function isCopyShortcut(key: KeyEvent): boolean {
  return key.name === "c" && (Boolean(key.super || key.meta) || (key.ctrl && key.shift));
}

function isPasteShortcut(key: KeyEvent): boolean {
  return key.name === "v" && !key.shift && (key.ctrl || Boolean(key.super || key.meta));
}

function isApproveOnceKey(key: KeyEvent): boolean {
  return key.name === "a" && !hasModifier(key);
}

function isApproveSessionKey(key: KeyEvent): boolean {
  return key.name === "s" && !hasModifier(key);
}

function isApproveAlwaysKey(key: KeyEvent): boolean {
  const upperA = key.name === "A" || key.sequence === "A" || (key.name === "a" && key.shift);
  return upperA && !key.ctrl && !key.meta && !key.super && !key.hyper && !key.option;
}

function isRejectApprovalKey(key: KeyEvent): boolean {
  return key.name === "x" && !hasModifier(key);
}

function isArrowUp(key: KeyEvent): boolean {
  return key.name === "up" || key.name === "arrow_up";
}

function isArrowDown(key: KeyEvent): boolean {
  return key.name === "down" || key.name === "arrow_down";
}

function isPlainArrowUp(key: KeyEvent): boolean {
  return isArrowUp(key) && !hasModifier(key);
}

function isPlainArrowDown(key: KeyEvent): boolean {
  return isArrowDown(key) && !hasModifier(key);
}

function hasModifier(key: KeyEvent): boolean {
  return Boolean(key.shift || key.ctrl || key.meta || key.super || key.hyper || key.option);
}

function isPageUp(key: KeyEvent): boolean {
  return key.name === "pageup" || key.name === "page_up" || key.name === "page-up";
}

function isPageDown(key: KeyEvent): boolean {
  return key.name === "pagedown" || key.name === "page_down" || key.name === "page-down";
}

function scrollStep(height: number): number {
  return Math.max(4, Math.floor(height / 2));
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function serverIndexByName(servers: readonly RuntimeMcpServerDescriptor[], name: string): number {
  const index = servers.findIndex((server) => server.name === name);
  return index < 0 ? 0 : index;
}

function statusFromMcpServers(servers: readonly RuntimeMcpServerDescriptor[]): RuntimeMcpStatusResponse {
  return {
    servers: [...servers],
    summary: {
      total: servers.length,
      running: servers.filter((server) => server.status === "running").length,
      disabled: servers.filter((server) => !server.enabled || server.status === "disabled").length,
      authRequired: servers.filter((server) => server.status === "auth_required" || (server.auth?.required && !server.auth.authenticated)).length,
      errored: servers.filter((server) => server.status === "error").length,
    },
  };
}
