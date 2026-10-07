import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useAppContext, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, MouseEvent, ScrollBoxRenderable, Selection } from "@opentui/core";
import { collectCommandNodes, completeCommandsSync, resolveCommand, type ResolveCommandResult } from "@chili/commands";
import type { ChatSessionView, ChatTranscriptItem, HttpRuntimeClient, RuntimeSessionSummary } from "@chili/sdk";
import { normalizeSessionTitle, SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import type {
  DelegationPolicy,
  MessageImageContent,
  RuntimeCommandNode,
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
} from "@chili/protocol";
import { FileAuthStorage, loginOpenAICodex, OPENAI_CODEX_PROVIDER_ID } from "@chili/providers";
import { discoverSkills, updateSkillDisabledSetting, type SkillSettingsScope, type SkillSummary } from "@chili/skills";
import { runProcess, type RunProcessResult } from "@chili/tools";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanClipboardText, systemClipboard, type ClipboardAccess, type ClipboardImage } from "./clipboard.js";
import type { RuntimeTuiOptions, RuntimeConnectionState } from "./useRuntimeEvents.js";
import { acceptedFeedbackMatchesStatus, useChatRuntime, type ChatRuntimeState } from "./useChatRuntime.js";
import { shorten } from "./components/helpers.js";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  defaultOpenAICodexSelection,
  filterModelCandidates,
  isValidModelSelection,
  type ModelCandidate,
  modelAuthLabel,
  modelDescriptorSelection,
  modelSelectionLabel,
  modelSupportsImages,
  modelSupportsReasoning,
  modelSupportsServiceTier,
  safeEndpointHost,
  sameModelSelection,
  type ModelSelection,
  type ReasoningLevel,
} from "./model-state.js";
import { AgentsView, agentsViewModel, type AgentsViewModel } from "./chat/AgentsView.js";
import { BrandMark } from "./chat/BrandMark.js";
import { charDisplayWidth } from "./chat/markdown.js";
import { zedPathWithPosition, type FileLinkTarget } from "./chat/file-links.js";
import { MessageList } from "./chat/MessageList.js";
import { commandListHeight } from "./chat/CommandList.js";
import { TranscriptLine } from "./chat/lines.js";
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
import { publicStatusReason, publicSyntheticAssistantText } from "./chat/public-error.js";
import { StatusFooter, statusFooterHeight, type StatusFooterOptions } from "./chat/StatusFooter.js";
import { buildTranscriptLines, buildTranscriptText } from "./chat/transcript.js";
import { TranscriptView } from "./chat/TranscriptView.js";
import type { LocalTranscriptItem, PromptPart } from "./chat/types.js";
import { usePromptHistory } from "./chat/usePromptHistory.js";
import { tuiCommands } from "./commands/catalog.js";
import { initialCommandMenuState, reduceCommandMenu } from "./commands/menu-state.js";
import type { TuiCommand, TuiCommandContext, TuiCommandResult, TuiCommandSuggestion } from "./commands/types.js";
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

type ShellView = "chat" | "help" | "agents" | "status" | "mcp" | "transcript";
type AppendLocalItem = (level: "info" | "error", text: string, options?: { persistent?: boolean | undefined; bare?: boolean | undefined }) => void;
type LocalShellItem = Extract<LocalTranscriptItem, { kind: "shell" }>;
type AppendShellItem = (item: Omit<LocalShellItem, "id" | "kind" | "createdAt">) => string;
type UpdateShellItem = (id: string, update: Partial<Omit<LocalShellItem, "id" | "kind" | "createdAt">>) => void;

interface PastedPromptImage extends MessageImageContent {
  id: number;
  absolutePath?: string | undefined;
}

interface InterruptedPromptCandidate {
  promptParts: PromptPart[];
  pastedTextByMarker: Array<[string, string]>;
  pastedImages: Record<number, PastedPromptImage>;
  skillMentionBindings: RuntimeSkillMention[];
  baselineOutput: Map<string, string>;
  sawActiveStatus: boolean;
  interruptOutcome?: "restored" | "discarded" | undefined;
}

interface PendingInterruptRequest {
  candidate?: InterruptedPromptCandidate | undefined;
}

interface CommandConfirmation {
  title: string;
  result: TuiCommandResult;
  selectedIndex: number;
}

interface CommandActions {
  cwd: string;
  enterSessionLayout: () => void;
  currentSessionUiEpoch: () => number;
  isSessionUiEpochCurrent: (epoch: number) => boolean;
  setView: (view: ShellView) => void;
  appendLocalItem: AppendLocalItem;
  appendShellItem: AppendShellItem;
  updateShellItem: UpdateShellItem;
  startNewChatSession: () => Promise<void>;
  openResumePicker: () => void;
  resumeSessionByTarget: (target: string) => Promise<void>;
  openRenamePrompt: () => void;
  renameChatSession: (title: string) => Promise<void>;
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
  requestConfirmation: (title: string, result: TuiCommandResult) => void;
  openCommandPalette: () => void;
  exitApp: () => void;
}

interface SkillSummariesState {
  skills: readonly SkillSummary[];
  allSkills: readonly SkillSummary[];
  reload: () => Promise<void>;
}

export interface ChatShellOptions extends RuntimeTuiOptions {
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
  cwd?: string;
}

interface AuthManualPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

const execFileAsync = promisify(execFile);
const PROMPT_MENU_MAX_ITEMS = 8;
const MODEL_PICKER_MAX_VISIBLE_ITEMS = 8;
const MODEL_PICKER_CHROME_HEIGHT = 9;
const LOCAL_ITEM_TTL_MS = 4_000;
const USER_SHELL_TIMEOUT_MS = 60 * 60 * 1_000;
const USER_SHELL_OUTPUT_LIMIT_BYTES = 256_000;
const MAX_PASTED_IMAGE_BASE64_CHARS = 20 * 1024 * 1024;
const PROMPT_TEXT_PASTE_LINE_THRESHOLD = 8;
const PROMPT_TEXT_PASTE_CHAR_THRESHOLD = 1_000;
const SLASH_COMPLETION_LIMIT = 64;
export const CTRL_C_EXIT_CONFIRM_MS = 2_000;
export const CONVERSATION_INTERRUPTED_NOTICE = "■ Conversation interrupted - tell the model what to do differently.";

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
      // /resume can switch sessions in-process, so keep the live stream global.
      // Older transcript history is hydrated on demand when a session is selected.
      streamScope: "all" as const,
    }),
    [shellOptions],
  );
  const runtime = useChatRuntime({ client: props.client, options: chatOptions });
  const skillSummaries = useSkillSummaries(runtime.chatView.cwd ?? shellOptions.cwd ?? process.cwd());

  return (
    <ChatShellSurface
      runtime={runtime}
      options={shellOptions}
      onExit={props.onExit}
      skills={skillSummaries.skills}
      allSkills={skillSummaries.allSkills}
      onSkillsChanged={skillSummaries.reload}
    />
  );
}

export function ChatShellSurface(props: {
  runtime: ChatRuntimeState;
  options?: Partial<ChatShellOptions>;
  onExit?: (info?: ChatShellExitInfo) => void;
  commands?: readonly TuiCommand[];
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
  // A session reset invalidates notices and other UI work started by the old session.
  const sessionUiEpochRef = useRef(0);
  // The welcome screen is an entry state. Once work reaches the session layout,
  // expiring transient notices must not remount the composer back on welcome.
  const [sessionLayoutEntered, setSessionLayoutEntered] = useState(() => (
    props.runtime.chatView.items.length > 0
    || props.runtime.chatView.pendingApprovals.length > 0
    || Boolean(
      props.options?.sessionId
      || props.runtime.activeSessionId
      || props.runtime.chatView.sessionId,
    )
  ));
  const [statusClipboardFeedback, setStatusClipboardFeedback] = useState<StatusPageFeedback | undefined>(undefined);
  const deferredLocalItems = useDeferredValue(localItems);
  const [commandMenu, dispatchCommandMenu] = useReducer(reduceCommandMenu, initialCommandMenuState);
  const paletteOpen = commandMenu.mode === "palette";
  const paletteIndex = commandMenu.selectedIndex;
  const paletteQuery = commandMenu.query;
  const [completionIndex, setCompletionIndex] = useState(0);
  const [commandConfirmation, setCommandConfirmation] = useState<CommandConfirmation | undefined>(undefined);
  const [themeId, setThemeId] = useState(() => initialTuiThemeId(props.options?.themeId));
  const [themePicker, setThemePicker] = useState<ThemePickerNavigation | undefined>(undefined);
  const modelCandidates = useMemo(
    () => props.runtime.modelCandidates ?? [],
    [props.runtime.modelCandidates],
  );
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | undefined>(undefined);
  const [reasoningLevel, setReasoningLevelState] = useState<ReasoningLevel | undefined>(undefined);
  const [serviceTier, setServiceTierState] = useState<ServiceTier | undefined>(undefined);
  const capabilitySelection = modelSelection ?? modelSelectionFromOptions(props.options);
  const reasoningConfigurable = modelSupportsReasoning(capabilitySelection, modelCandidates);
  const serviceTierConfigurable = modelSupportsServiceTier(capabilitySelection, modelCandidates);
  const availableReasoningLevels = reasoningConfigurable
    ? props.runtime.modelConfig?.availableReasoningLevels ?? REASONING_LEVELS
    : [];
  const [modelPicker, setModelPicker] = useState<ModelPickerNavigation | undefined>(undefined);
  const [reasoningPicker, setReasoningPicker] = useState<ReasoningPickerNavigation | undefined>(undefined);
  const [permissionsPicker, setPermissionsPicker] = useState<PermissionsPickerNavigation | undefined>(undefined);
  const [resumePicker, setResumePicker] = useState<ResumePickerNavigation | undefined>(undefined);
  const [renamePrompt, setRenamePrompt] = useState<RenamePromptNavigation | undefined>(undefined);
  const [mcpManager, setMcpManager] = useState<McpManagerState>(() => initialMcpManagerState());
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const messageScrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const [authManualPrompt, setAuthManualPromptState] = useState<AuthManualPrompt | undefined>(undefined);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [hideThinking, setHideThinkingState] = useState(false);
  const interruptedPromptCandidateRef = useRef<InterruptedPromptCandidate | undefined>(undefined);
  const [pendingInterrupt, setPendingInterrupt] = useState<PendingInterruptRequest | undefined>(undefined);
  const lastCtrlCPressMsRef = useRef<number | undefined>(undefined);
  const clearedPromptTextRef = useRef<string | undefined>(undefined);
  const localMessageTtlMs = props.localMessageTtlMs ?? LOCAL_ITEM_TTL_MS;
  const localItemTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const statusClipboardFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const statusClipboardFeedbackEpochRef = useRef(0);
  const clearStatusClipboardFeedback = useCallback(() => {
    statusClipboardFeedbackEpochRef.current += 1;
    if (statusClipboardFeedbackTimerRef.current) clearTimeout(statusClipboardFeedbackTimerRef.current);
    statusClipboardFeedbackTimerRef.current = undefined;
    setStatusClipboardFeedback(undefined);
  }, []);
  const beginStatusClipboardFeedback = useCallback(() => {
    statusClipboardFeedbackEpochRef.current += 1;
    if (statusClipboardFeedbackTimerRef.current) clearTimeout(statusClipboardFeedbackTimerRef.current);
    statusClipboardFeedbackTimerRef.current = undefined;
    setStatusClipboardFeedback(undefined);
    return statusClipboardFeedbackEpochRef.current;
  }, []);
  const showStatusClipboardFeedback = useCallback((feedback: StatusPageFeedback, epoch: number) => {
    if (statusClipboardFeedbackEpochRef.current !== epoch) return;
    setStatusClipboardFeedback(feedback);
    if (localMessageTtlMs <= 0) return;
    statusClipboardFeedbackTimerRef.current = setTimeout(() => {
      if (statusClipboardFeedbackEpochRef.current !== epoch) return;
      statusClipboardFeedbackTimerRef.current = undefined;
      setStatusClipboardFeedback(undefined);
    }, localMessageTtlMs);
  }, [localMessageTtlMs]);
  const dismissLocalItem = useCallback((id: string) => {
    const timer = localItemTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    localItemTimersRef.current.delete(id);
    setLocalItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const enterSessionLayout = useCallback(() => {
    setSessionLayoutEntered(true);
  }, []);
  const currentSessionUiEpoch = useCallback(() => sessionUiEpochRef.current, []);
  const isSessionUiEpochCurrent = useCallback((epoch: number) => sessionUiEpochRef.current === epoch, []);
  const invalidateSessionUiOperations = useCallback(() => {
    sessionUiEpochRef.current += 1;
  }, []);
  const appendLocalItem = useCallback<AppendLocalItem>((level, text, itemOptions) => {
    const item = localItem(level, text, itemOptions?.persistent, itemOptions?.bare);
    enterSessionLayout();
    setLocalItems((current) => [...current, item]);
    if (itemOptions?.persistent || localMessageTtlMs <= 0) return;
    const timer = setTimeout(() => dismissLocalItem(item.id), localMessageTtlMs);
    localItemTimersRef.current.set(item.id, timer);
  }, [dismissLocalItem, enterSessionLayout, localMessageTtlMs]);
  const appendShellItem = useCallback<AppendShellItem>((item) => {
    const createdAt = Date.now();
    const id = `${createdAt}:shell:${item.command}`;
    enterSessionLayout();
    setLocalItems((current) => [...current, { id, kind: "shell", createdAt, ...item }]);
    return id;
  }, [enterSessionLayout]);
  const updateShellItem = useCallback<UpdateShellItem>((id, update) => {
    setLocalItems((current) => current.map((item) => item.kind === "shell" && item.id === id ? { ...item, ...update } : item));
  }, []);
  const clearLocalItems = useCallback(() => {
    clearLocalItemTimers(localItemTimersRef.current);
    setLocalItems([]);
  }, []);
  useEffect(() => {
    if (view !== "status") clearStatusClipboardFeedback();
  }, [clearStatusClipboardFeedback, view]);
  const runtimeSessionActivity = props.runtime.chatView.items.length > 0
    || props.runtime.chatView.pendingApprovals.length > 0;
  useEffect(() => {
    if (runtimeSessionActivity) setSessionLayoutEntered(true);
  }, [runtimeSessionActivity]);
  useEffect(() => {
    return () => {
      clearLocalItemTimers(localItemTimersRef.current);
      statusClipboardFeedbackEpochRef.current += 1;
      if (statusClipboardFeedbackTimerRef.current) clearTimeout(statusClipboardFeedbackTimerRef.current);
      statusClipboardFeedbackTimerRef.current = undefined;
    };
  }, []);
  const sessionKey = props.runtime.activeSessionId ?? "";
  const previousSessionKey = useRef(sessionKey);
  useEffect(() => {
    if (previousSessionKey.current === sessionKey) return;
    previousSessionKey.current = sessionKey;
    interruptedPromptCandidateRef.current = undefined;
    setPendingInterrupt(undefined);
    clearLocalItems();
    clearStatusClipboardFeedback();
  }, [clearLocalItems, clearStatusClipboardFeedback, sessionKey]);
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
  const cwd = props.runtime.chatView.cwd ?? props.options?.cwd ?? process.cwd();
  const closeCommandMenu = useCallback(() => {
    dispatchCommandMenu({ type: "close" });
  }, []);
  const openCommandPalette = useCallback(() => {
    setResumePicker(undefined);
    setRenamePrompt(undefined);
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    dispatchCommandMenu({ type: "open_palette", draft: prompt });
  }, [prompt]);
  const statusOptions: StatusFooterOptions = {
    modeName: props.options?.modeName ?? "Build",
    modelName: props.options?.modelName ?? "auto",
    providerName: props.options?.providerName ?? "runtime",
    ...(modelSelection ? { modelSelection } : {}),
    reasoningConfigurable,
    serviceTierConfigurable,
    ...(reasoningConfigurable && reasoningLevel ? { reasoningLevel } : {}),
    ...(serviceTierConfigurable && serviceTier ? { serviceTier } : {}),
    cwd,
  };
  const capabilityCandidate = capabilitySelection
    ? modelCandidates.find((item) => sameModelSelection(capabilitySelection, modelDescriptorSelection(item)))
    : undefined;
  const capabilitySupported = modelToolCallSupport(capabilityCandidate);
  const currentSessionId = props.runtime.activeSessionId ?? props.runtime.chatView.sessionId;
  const agentExperience = agentsViewModel({
    runtimeView: props.runtime.runtimeView,
    ...(props.runtime.delegationConfig ? { delegationConfig: props.runtime.delegationConfig } : {}),
    parentExecution: props.runtime.chatView.status,
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    ...(capabilitySupported === undefined ? {} : { capabilitySupported }),
  });
  const statusPage = statusPageModel({
    runtime: props.runtime,
    options: statusOptions,
    agentExperience,
    showToolDetails,
    hideThinking,
    transcriptActive: view === "transcript",
  });
  const commands = useMemo(
    () => props.commands ?? tuiCommands(props.runtime.commandList),
    [props.commands, props.runtime.commandList],
  );
  const commandContext = useMemo<TuiCommandContext>(() => ({
    busy: isInterruptInFlight(props.runtime.chatView.status),
    cwd,
    ...(modelSelection ? { modelSelection } : {}),
    ...(reasoningConfigurable && reasoningLevel ? { reasoningLevel } : {}),
    availableReasoningLevels,
    serviceTierConfigurable,
    ...(serviceTierConfigurable && serviceTier ? { serviceTier } : {}),
    modelCandidates,
    skills: props.skills ?? [],
    allSkills: props.allSkills ?? props.skills ?? [],
    mcpServers: props.runtime.mcpStatus?.servers ?? [],
    commandDiagnostics: props.runtime.commandList?.diagnostics ?? [],
  }), [availableReasoningLevels, cwd, modelCandidates, modelSelection, props.allSkills, props.runtime.chatView.status, props.runtime.commandList?.diagnostics, props.runtime.mcpStatus?.servers, props.skills, reasoningConfigurable, reasoningLevel, serviceTier, serviceTierConfigurable]);
  const skillTrigger = activeSkillMentionTrigger(prompt);
  const skillCompletionItems = skillTrigger && !prompt.startsWith("/") && !shellInputActive
    ? skillCompletions(props.skills ?? [], skillTrigger.query)
    : [];
  const skillCompletionOpen = Boolean(skillTrigger && !prompt.startsWith("/") && !shellInputActive);
  const commandCompletionItems = prompt.startsWith("/")
    ? completeCommandsSync(commands, commandContext, prompt, { scope: "contextual", limit: SLASH_COMPLETION_LIMIT })
    : [];
  const completions = skillCompletionOpen ? skillCompletionItems : commandCompletionItems;
  const resolvedCommandPrompt = prompt.startsWith("/") ? resolveCommand(commands, commandContext, prompt) : undefined;
  const commandInputActive = prompt.startsWith("/")
    && resolvedCommandPrompt?.status !== "not_command"
    && (prompt.trim() === "/" || completions.length > 0 || resolvedCommandPrompt !== undefined);
  const commandCompletionOpen = prompt.startsWith("/") && commandCompletionItems.length > 0;
  const selectedCompletionIndex = clampIndex(completionIndex, completions.length);
  const paletteDrilldown = paletteQuery.endsWith(" ");
  const paletteItems = completeCommandsSync(commands, commandContext, paletteDrilldown ? `/${paletteQuery}` : paletteQuery, {
    scope: paletteDrilldown ? "contextual" : "global",
    limit: SLASH_COMPLETION_LIMIT,
  });
  const setPrompt = useMemo(() => setPromptText(setPromptParts, pastedTextByMarkerRef), []);
  const historyPromptValueRef = useRef<string | undefined>(undefined);
  const clearPromptAttachments = useCallback(() => {
    pastedTextByMarkerRef.current.clear();
    setPastedImages({});
  }, []);
  const clearPromptInput = useCallback((clearedText: string) => {
    clearedPromptTextRef.current = clearedText;
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    setCompletionIndex(0);
    setSkillMentionBindings([]);
    clearPromptAttachments();
    setPrompt("");
    setPromptInputResetKey((current) => current + 1);
  }, [clearPromptAttachments, history, setPrompt]);
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
    if (historyPromptValueRef.current === value) {
      setPrompt(value);
      return;
    }
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    setPrompt(value);
  }, [history, setPrompt]);
  useEffect(() => {
    setSkillMentionBindings((current) => filterSkillMentionBindings(current, prompt));
  }, [prompt]);
  useEffect(() => {
    setPastedImages((current) => filterPastedImagesByPrompt(current, prompt));
  }, [prompt]);
  const setPromptFromHistory = useCallback((value: string) => {
    historyPromptValueRef.current = value;
    setPrompt(value);
  }, [setPrompt]);
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
    invalidateSessionUiOperations();
    setView("chat");
    setAuthManualPrompt(undefined);
    setResumePicker(undefined);
    setRenamePrompt(undefined);
    interruptedPromptCandidateRef.current = undefined;
    setPendingInterrupt(undefined);
    setPrompt("");
    history.clear();
    clearLocalItems();
    scrollMessageToBottom();
    setTranscriptScrollOffset(0);
    setSessionLayoutEntered(false);
    await props.runtime.startNewSession();
  }, [clearLocalItems, history, invalidateSessionUiOperations, props.runtime, scrollMessageToBottom, setAuthManualPrompt, setPrompt]);
  const prepareForSessionSwitch = useCallback(() => {
    setView("chat");
    setAuthManualPrompt(undefined);
    interruptedPromptCandidateRef.current = undefined;
    setPendingInterrupt(undefined);
    setPrompt("");
    history.clear();
    clearLocalItems();
    scrollMessageToBottom();
    setTranscriptScrollOffset(0);
    setSessionLayoutEntered(true);
  }, [clearLocalItems, history, scrollMessageToBottom, setAuthManualPrompt, setPrompt]);
  const resumeChatSession = useCallback(async (session: RuntimeSessionSummary) => {
    if (session.status === "archived") {
      appendLocalItem("error", "Archived sessions cannot be resumed yet.");
      return;
    }
    invalidateSessionUiOperations();
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    setResumePicker(undefined);
    const resumed = await props.runtime.resumeSession(session);
    if (resumed && isSessionUiEpochCurrent(uiEpoch)) prepareForSessionSwitch();
  }, [appendLocalItem, currentSessionUiEpoch, enterSessionLayout, invalidateSessionUiOperations, isSessionUiEpochCurrent, prepareForSessionSwitch, props.runtime]);
  const openResumePicker = useCallback(() => {
    if (props.runtime.chatView.status === "running" || props.runtime.chatView.status === "waiting_for_approval") {
      appendLocalItem("error", "Finish or interrupt the current session before resuming another chat.");
      return;
    }
    closeCommandMenu();
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setRenamePrompt(undefined);
    setResumePicker({ query: "", selectedIndex: 0, sessions: [], loading: true, showAll: false });
    void props.runtime.listSessions()
      .then((sessions) => {
        setResumePicker((current) => current ? { ...current, sessions, loading: false, selectedIndex: 0 } : current);
      })
      .catch((error) => {
        setResumePicker((current) => current ? { ...current, loading: false, error: errorMessage(error) } : current);
      });
  }, [appendLocalItem, closeCommandMenu, props.runtime]);
  const resumeSessionByTarget = useCallback(async (target: string) => {
    if (props.runtime.chatView.status === "running" || props.runtime.chatView.status === "waiting_for_approval") {
      appendLocalItem("error", "Finish or interrupt the current session before resuming another chat.");
      return;
    }
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    let sessions: RuntimeSessionSummary[];
    try {
      sessions = await props.runtime.listSessions();
    } catch {
      return;
    }
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    const match = resolveResumeTarget(sessions, target);
    if (typeof match === "string") {
      appendLocalItem("error", match);
      return;
    }
    await resumeChatSession(match);
  }, [appendLocalItem, currentSessionUiEpoch, enterSessionLayout, isSessionUiEpochCurrent, props.runtime, resumeChatSession]);
  const openRenamePrompt = useCallback(() => {
    closeCommandMenu();
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setResumePicker(undefined);
    setRenamePrompt({ value: "", submitting: false });
  }, [closeCommandMenu]);
  const renameChatSession = useCallback(async (title: string) => {
    let normalized: string;
    try {
      normalized = normalizeSessionTitle(title);
    } catch (error) {
      appendLocalItem("error", error instanceof Error ? error.message : "Invalid session title.");
      return;
    }
    setRenamePrompt((current) => current ? { ...current, submitting: true } : current);
    const renamed = await props.runtime.renameSession(normalized);
    if (renamed) setRenamePrompt(undefined);
    else setRenamePrompt((current) => current ? { ...current, submitting: false } : current);
  }, [appendLocalItem, props.runtime]);
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
    setResumePicker(undefined);
    setRenamePrompt(undefined);
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
    const items = modelPickerCandidates(modelCandidates, query, modelSelection, undefined);
    const index = modelPickerIndex(modelCandidates, query, modelSelection, undefined);
    const selectedCandidate = items[index];
    const selected = selectedCandidate ? modelDescriptorSelection(selectedCandidate) : undefined;
    setResumePicker(undefined);
    setRenamePrompt(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setModelPicker({ query, cursor: query.length, selectedIndex: index, selected, provider: undefined });
  }, [modelCandidates, modelSelection, props.runtime]);
  const closeModelPicker = useCallback(() => {
    setModelPicker(undefined);
  }, []);
  const openReasoningPicker = useCallback(() => {
    if (!reasoningConfigurable) {
      appendLocalItem("error", `${capabilityModelLabel(capabilitySelection)} does not support configurable thinking`);
      return;
    }
    const selectedIndex = Math.max(0, availableReasoningLevels.indexOf(reasoningLevel ?? DEFAULT_REASONING_LEVEL));
    setResumePicker(undefined);
    setRenamePrompt(undefined);
    setModelPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setReasoningPicker({ selectedIndex });
  }, [appendLocalItem, availableReasoningLevels, capabilitySelection, reasoningConfigurable, reasoningLevel]);
  const closeReasoningPicker = useCallback(() => {
    setReasoningPicker(undefined);
  }, []);
  const openPermissionsPicker = useCallback(() => {
    void props.runtime.refreshPermissionConfig?.();
    const profiles = props.runtime.permissionConfig?.profiles ?? [];
    const selectedIndex = Math.max(0, profiles.findIndex((profile) => profile.current));
    setResumePicker(undefined);
    setRenamePrompt(undefined);
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
    closeCommandMenu();
    setModelPicker(undefined);
    setReasoningPicker(undefined);
    setPermissionsPicker(undefined);
    setThemePicker(undefined);
    setResumePicker(undefined);
    setRenamePrompt(undefined);
    setPrompt("");
    setMcpManager(initialMcpManagerState());
    void refreshMcpManager();
  }, [closeCommandMenu, refreshMcpManager, setPrompt]);
  const closeMcpManager = useCallback(() => {
    setView("chat");
    setMcpManager(initialMcpManagerState());
  }, []);
  const setModelSelection = useCallback(async (selection: ModelSelection, nextReasoningLevel?: ReasoningLevel) => {
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    const persisted = props.runtime.setRuntimeModel ? await props.runtime.setRuntimeModel(selection) : true;
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
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
      setReasoningLevelState(undefined);
    }

    if (resolvedReasoning !== undefined) {
      reasoningPersisted = props.runtime.setRuntimeReasoning
        ? await props.runtime.setRuntimeReasoning(resolvedReasoning)
        : true;
      if (!isSessionUiEpochCurrent(uiEpoch)) return;
      if (!reasoningPersisted) {
        appendLocalItem("error", `Thinking unchanged: failed to persist ${resolvedReasoning}`);
      }
    }

    setModelSelectionState(selection);
    if (!modelSupportsServiceTier(selection, modelCandidates)) setServiceTierState(undefined);
    if (resolvedReasoning && reasoningPersisted) setReasoningLevelState(resolvedReasoning);
    setModelPicker(undefined);
    const reasoningText = resolvedReasoning && reasoningPersisted ? ` (thinking ${resolvedReasoning})` : "";
    const selectedModel = modelCandidates.find((candidate) => sameModelSelection(selection, modelDescriptorSelection(candidate)));
    const availabilityText = selectedModel?.available === false ? " (not configured)" : "";
    appendLocalItem("info", `Model: ${modelSelectionLabel(selection)}${reasoningText}${availabilityText}`);
  }, [appendLocalItem, currentSessionUiEpoch, enterSessionLayout, isSessionUiEpochCurrent, modelCandidates, props.runtime]);

  const setReasoningLevel = useCallback(async (level: ReasoningLevel) => {
    if (!reasoningConfigurable) {
      appendLocalItem("error", `${capabilityModelLabel(capabilitySelection)} does not support configurable thinking`);
      return;
    }
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    const persisted = props.runtime.setRuntimeReasoning ? await props.runtime.setRuntimeReasoning(level) : true;
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    if (!persisted) {
      setReasoningPicker(undefined);
      appendLocalItem("error", `Thinking unchanged: failed to persist ${level}`);
      return;
    }
    setReasoningLevelState(level);
    setReasoningPicker(undefined);
    appendLocalItem("info", `Thinking: ${level}`);
  }, [appendLocalItem, capabilitySelection, currentSessionUiEpoch, enterSessionLayout, isSessionUiEpochCurrent, props.runtime, reasoningConfigurable]);

  const setServiceTier = useCallback(async (nextServiceTier: ServiceTier) => {
    if (!serviceTierConfigurable) {
      appendLocalItem("error", `${capabilityModelLabel(capabilitySelection)} does not support selectable service tiers`);
      return;
    }
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    const persisted = props.runtime.setRuntimeServiceTier ? await props.runtime.setRuntimeServiceTier(nextServiceTier) : true;
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    if (!persisted) {
      appendLocalItem("error", `Fast mode unchanged: failed to persist ${nextServiceTier}`);
      return;
    }
    setServiceTierState(nextServiceTier);
    appendLocalItem("info", nextServiceTier === "fast" ? "Fast mode: on" : "Fast mode: off (standard)");
  }, [appendLocalItem, capabilitySelection, currentSessionUiEpoch, enterSessionLayout, isSessionUiEpochCurrent, props.runtime, serviceTierConfigurable]);

  const setPermissionProfile = useCallback(async (profile: RuntimePermissionProfileId) => {
    const item = props.runtime.permissionConfig?.profiles.find((candidate) => candidate.id === profile);
    if (item?.disabledReason) {
      appendLocalItem("error", `${item.label}: ${item.disabledReason}`);
      return;
    }
    const uiEpoch = currentSessionUiEpoch();
    enterSessionLayout();
    const persisted = props.runtime.setRuntimePermissionProfile
      ? await props.runtime.setRuntimePermissionProfile(profile)
      : false;
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    setPermissionsPicker(undefined);
    if (!persisted) {
      appendLocalItem("error", `Permissions unchanged: failed to select ${item?.label ?? profile}`);
      return;
    }
    appendLocalItem("info", `Permissions updated to ${item?.label ?? profile}`);
  }, [appendLocalItem, currentSessionUiEpoch, enterSessionLayout, isSessionUiEpochCurrent, props.runtime]);
  const setHideThinking = useCallback((hidden: boolean) => {
    setHideThinkingState(hidden);
    appendLocalItem("info", hidden ? "Thinking traces hidden." : "Thinking traces shown.");
  }, [appendLocalItem]);

  const ensureOpenAICodexDefaultModel = useCallback(async () => {
    const uiEpoch = currentSessionUiEpoch();
    await props.runtime.refreshModelConfig?.();
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    if (isValidModelSelection(modelSelection, modelCandidates)) return;
    const selection = defaultOpenAICodexSelection();
    await setModelSelection(selection);
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    await props.runtime.refreshModelConfig?.();
  }, [currentSessionUiEpoch, isSessionUiEpochCurrent, modelCandidates, modelSelection, props.runtime, setModelSelection]);
  const reloadCommands = useCallback(async () => {
    const uiEpoch = currentSessionUiEpoch();
    const commandList = await props.runtime.reloadCommands?.();
    if (!isSessionUiEpochCurrent(uiEpoch)) return;
    if (!commandList) {
      appendLocalItem("error", "Could not reload commands.");
      return;
    }
    const count = countRuntimeCommandNodes(commandList.roots);
    appendLocalItem("info", `Command catalog reloaded: ${count} node${count === 1 ? "" : "s"}.`);
    for (const diagnostic of commandList.diagnostics) {
      appendLocalItem(diagnostic.level === "error" ? "error" : "info", `[${diagnostic.code}] ${diagnostic.message}`);
    }
  }, [appendLocalItem, currentSessionUiEpoch, isSessionUiEpochCurrent, props.runtime]);
  const commandActions = useMemo<CommandActions>(() => ({
    cwd,
    enterSessionLayout,
    currentSessionUiEpoch,
    isSessionUiEpochCurrent,
    setView,
    appendLocalItem,
    appendShellItem,
    updateShellItem,
    startNewChatSession,
    openResumePicker,
    resumeSessionByTarget,
    openRenamePrompt,
    renameChatSession,
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
    requestConfirmation: (title, result) => setCommandConfirmation({ title, result, selectedIndex: 0 }),
    openCommandPalette,
    exitApp: () => props.onExit?.(chatShellExitInfo(props.runtime, cwd)),
  }), [appendLocalItem, appendShellItem, currentSessionUiEpoch, cwd, ensureOpenAICodexDefaultModel, enterSessionLayout, isSessionUiEpochCurrent, openCommandPalette, openMcpManager, openModelPicker, openPermissionsPicker, openReasoningPicker, openRenamePrompt, openResumePicker, openThemePicker, props.onExit, props.onSkillsChanged, props.runtime, reloadCommands, renameChatSession, resumeSessionByTarget, setAuthManualPrompt, setHideThinking, setModelSelection, setPermissionProfile, setPrompt, setReasoningLevel, setServiceTier, startNewChatSession, updateShellItem]);
  const runSelectedCommandCompletion = useCallback(() => {
    if (!commandCompletionOpen) return false;
    const completion = commandCompletionItems[selectedCompletionIndex] ?? commandCompletionItems[0];
    if (!completion) return false;
    if (!completion.value.toLowerCase().startsWith(prompt.trim().toLowerCase())) return false;
    const requiresArgument = completion.intent === "complete"
      && collectCommandNodes(commands).some((command) => command.id === completion.id && command.argumentMode === "required");
    if (requiresArgument) {
      history.resetNavigation();
      setPrompt(`${completion.value} `);
      return true;
    }
    const promptAtSelection = prompt;
    let promptUpdated = false;
    const trackedCommandActions: CommandActions = {
      ...commandActions,
      setPrompt: (value) => {
        promptUpdated = true;
        commandActions.setPrompt(value);
      },
    };
    history.resetNavigation();
    void runCommandInput(completion.value, commands, commandContext, props.runtime, trackedCommandActions)
      .then(() => {
        if (!promptUpdated) setPrompt((current) => current === promptAtSelection ? "" : current);
      });
    return true;
  }, [commandActions, commandCompletionItems, commandCompletionOpen, commandContext, commands, history, prompt, props.runtime, selectedCompletionIndex, setPrompt]);
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
    });
    return true;
  }, [history, prompt, selectedCompletionIndex, setPrompt, skillCompletionItems, skillCompletionOpen, skillTrigger]);
  const submitCurrentChatPrompt = useCallback(() => {
    const candidate = interruptedPromptCandidate(
      promptParts,
      pastedTextByMarkerRef.current,
      pastedImages,
      skillMentionBindings,
      props.runtime.chatView.items,
    );
    void submitPrompt(
      prompt,
      expandedPrompt,
      commands,
      commandContext,
      props.runtime,
      commandActions,
      history.record,
      skillMentionBindings,
      props.skills ?? [],
      pastedImages,
      clearPromptAttachments,
      (state) => trackInterruptedPromptCandidate(interruptedPromptCandidateRef, candidate, state),
    );
  }, [clearPromptAttachments, commandActions, commandContext, commands, expandedPrompt, history.record, pastedImages, prompt, promptParts, props.runtime, props.skills, skillMentionBindings]);
  useEffect(() => {
    setCompletionIndex(0);
  }, [prompt]);

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

  const resumePickerItems = resumePicker
    ? filteredResumeSessions(resumePicker.sessions, resumePicker.query, cwd, resumePicker.showAll)
    : [];
  const selectorOpen = Boolean(modelPicker || reasoningPicker || permissionsPicker || resumePicker || renamePrompt);
  const disabledReason = authManualPrompt
    ? undefined
    : modelPicker
    ? "Choose a model"
    : reasoningPicker
    ? "Choose thinking level"
    : permissionsPicker
    ? "Choose permissions"
    : resumePicker
    ? "Choose a saved chat"
    : renamePrompt
    ? "Rename the current chat"
    : view === "mcp"
    ? "MCP manager open"
    : shellInputActive
    ? undefined
    : commandInputActive
    ? undefined
    : props.runtime.chatView.status === "cancelling"
      ? "Cancelling session..."
      : props.runtime.chatView.status === "running"
        ? "Session running - Esc or Ctrl+X to interrupt"
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

  const restoreInterruptedPrompt = useCallback((candidate: InterruptedPromptCandidate) => {
    clearedPromptTextRef.current = undefined;
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    pastedTextByMarkerRef.current.clear();
    for (const [marker, text] of candidate.pastedTextByMarker) {
      pastedTextByMarkerRef.current.set(marker, text);
    }
    setPromptParts(candidate.promptParts.map((part) => ({ ...part })));
    setPastedImages({ ...candidate.pastedImages });
    setSkillMentionBindings(candidate.skillMentionBindings.map((binding) => ({ ...binding })));
    setPromptInputResetKey((current) => current + 1);
  }, [history]);

  const requestActiveSessionInterrupt = useCallback(() => {
    if (!isInterruptInFlight(props.runtime.chatView.status) || pendingInterrupt) return;
    setPendingInterrupt({ candidate: interruptedPromptCandidateRef.current });
    void props.runtime.interruptActiveSession();
  }, [pendingInterrupt, props.runtime]);

  useEffect(() => {
    const status = props.runtime.chatView.status;
    const active = isInterruptInFlight(status);
    const candidate = interruptedPromptCandidateRef.current;
    if (active && candidate) candidate.sawActiveStatus = true;

    if (pendingInterrupt) {
      if (active) return;
      const interruptedCandidate = pendingInterrupt.candidate;
      if (interruptedCandidate && !hasVisibleOutputSince(interruptedCandidate, props.runtime.chatView.items)) {
        interruptedCandidate.interruptOutcome = "restored";
        restoreInterruptedPrompt(interruptedCandidate);
      } else {
        if (interruptedCandidate) interruptedCandidate.interruptOutcome = "discarded";
        appendLocalItem("error", CONVERSATION_INTERRUPTED_NOTICE, { persistent: true, bare: true });
      }
      interruptedPromptCandidateRef.current = undefined;
      setPendingInterrupt(undefined);
      return;
    }

    if (
      candidate
      && !active
      && (
        candidate.sawActiveStatus
        || status === "cancelled"
        || status === "failed"
        || hasVisibleOutputSince(candidate, props.runtime.chatView.items)
      )
    ) {
      interruptedPromptCandidateRef.current = undefined;
    }
  }, [appendLocalItem, pendingInterrupt, props.runtime.chatView.items, props.runtime.chatView.status, restoreInterruptedPrompt]);

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
      const copyView = view;
      const statusFeedbackEpoch = copyView === "status" ? beginStatusClipboardFeedback() : undefined;
      const reportCopyResult = (level: "info" | "error", text: string) => {
        if (statusFeedbackEpoch !== undefined) {
          showStatusClipboardFeedback({ level, text }, statusFeedbackEpoch);
          return;
        }
        appendLocalItem(level, text);
      };
      const source = clipboardCopySource(renderer, props.runtime.chatView.items, copyView, statusPage.text);
      if (!source) {
        reportCopyResult("error", "Nothing to copy yet.");
        return;
      }
      void copyClipboardText(source.text, clipboard, renderer).then((copied) => {
        reportCopyResult(copied ? "info" : "error", copied ? `Copied ${source.label}.` : "Clipboard copy is unavailable.");
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
      key.preventDefault();
      key.stopPropagation();
      requestActiveSessionInterrupt();
      return;
    }
    if (commandConfirmation) {
      if (isEscape(key) || (!key.ctrl && key.name === "n")) {
        setCommandConfirmation(undefined);
        return;
      }
      if (isArrowLeft(key) || isArrowRight(key) || isArrowUp(key) || isArrowDown(key)) {
        setCommandConfirmation((current) => current ? { ...current, selectedIndex: current.selectedIndex === 0 ? 1 : 0 } : current);
        return;
      }
      if (isEnter(key) || (!key.ctrl && key.name === "y")) {
        if (commandConfirmation.selectedIndex === 1 || key.name === "y") {
          const result = commandConfirmation.result;
          setCommandConfirmation(undefined);
          void applyCommandResult(result, commandContext, props.runtime, commandActions);
        } else {
          setCommandConfirmation(undefined);
        }
        return;
      }
      return;
    }
    if (resumePicker) {
      if (isEscape(key)) {
        setResumePicker(undefined);
        return;
      }
      if (key.ctrl && key.name === "a") {
        setResumePicker((current) => current ? { ...current, showAll: !current.showAll, selectedIndex: 0 } : current);
        return;
      }
      if (isArrowUp(key) || isArrowDown(key)) {
        const delta = isArrowUp(key) ? -1 : 1;
        setResumePicker((current) => current ? {
          ...current,
          selectedIndex: clampIndex(current.selectedIndex + delta, resumePickerItems.length),
        } : current);
        return;
      }
      if (isEnter(key)) {
        const selected = resumePickerItems[clampIndex(resumePicker.selectedIndex, resumePickerItems.length)];
        if (selected) void resumeChatSession(selected);
        return;
      }
      if (isBackspace(key)) {
        setResumePicker((current) => current ? { ...current, query: current.query.slice(0, -1), selectedIndex: 0 } : current);
        return;
      }
      if (isPasteShortcut(key)) {
        void clipboard.readText().then((value) => {
          const pasted = cleanClipboardText(value ?? "")?.replace(/\s+/g, " ") ?? "";
          if (pasted) setResumePicker((current) => current ? { ...current, query: `${current.query}${pasted}`, selectedIndex: 0 } : current);
        });
        return;
      }
      const printable = printableKey(key);
      if (printable) {
        setResumePicker((current) => current ? { ...current, query: `${current.query}${printable}`, selectedIndex: 0 } : current);
      }
      return;
    }
    if (renamePrompt) {
      if (isEscape(key)) {
        setRenamePrompt(undefined);
        return;
      }
      if (renamePrompt.submitting) return;
      if (isEnter(key)) {
        void renameChatSession(renamePrompt.value);
        return;
      }
      if (isBackspace(key)) {
        setRenamePrompt((current) => current ? { ...current, value: current.value.slice(0, -1) } : current);
        return;
      }
      if (isPasteShortcut(key)) {
        void clipboard.readText().then((value) => {
          const pasted = cleanClipboardText(value ?? "")?.replace(/\s+/g, " ") ?? "";
          if (pasted) setRenamePrompt((current) => current ? { ...current, value: `${current.value}${pasted}`.slice(0, SESSION_TITLE_MAX_CHARS) } : current);
        });
        return;
      }
      const printable = printableKey(key);
      if (printable) {
        setRenamePrompt((current) => current ? { ...current, value: `${current.value}${printable}`.slice(0, SESSION_TITLE_MAX_CHARS) } : current);
      }
      return;
    }
    if (key.ctrl && key.name === "p") {
      openCommandPalette();
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
      const selected = paletteItems[clampIndex(paletteIndex, paletteItems.length)];
      if (isEscape(key)) {
        closeCommandMenu();
        return;
      }
      if (isArrowUp(key) || isArrowDown(key)) {
        dispatchCommandMenu({ type: "move", delta: isArrowUp(key) ? -1 : 1, itemCount: paletteItems.length });
        return;
      }
      if (isTab(key) || isArrowRight(key)) {
        if (!selected) return;
        if (selected.intent === "drilldown") {
          dispatchCommandMenu({ type: "complete", value: `${selected.value} ` });
          return;
        }
        closeCommandMenu();
        history.resetNavigation();
        setPrompt(`${selected.value}${selected.intent === "complete" ? " " : ""}`);
        return;
      }
      if (isEnter(key)) {
        if (!selected) return;
        closeCommandMenu();
        const requiresArgument = selected.intent === "complete"
          && collectCommandNodes(commands).some((command) => command.id === selected.id && command.argumentMode === "required");
        if (requiresArgument) {
          history.resetNavigation();
          setPrompt(`${selected.value} `);
          return;
        }
        void runCommandInput(selected.value, commands, commandContext, props.runtime, commandActions);
        return;
      }
      if (isBackspace(key)) {
        dispatchCommandMenu({ type: "backspace" });
        return;
      }
      if (key.ctrl && key.name === "u") {
        dispatchCommandMenu({ type: "delete" });
        return;
      }
      const printable = printableKey(key);
      if (printable) dispatchCommandMenu({ type: "insert", text: printable });
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
      handleReasoningPickerKey(key, reasoningPicker, availableReasoningLevels, {
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
    if ((commandCompletionOpen || skillCompletionOpen) && !key.shift && (isArrowUp(key) || isArrowDown(key))) {
      const delta = isArrowUp(key) ? -1 : 1;
      setCompletionIndex((current) => wrapIndex(current + delta, completions.length));
      return;
    }
    if (skillCompletionOpen && isTab(key)) {
      if (runSelectedSkillCompletion()) return;
    }
    if (commandCompletionOpen && (isTab(key) || isArrowRight(key))) {
      const completion = commandCompletionItems[selectedCompletionIndex] ?? commandCompletionItems[0];
      if (completion) {
        history.resetNavigation();
        setPrompt(`${completion.value}${completion.intent === "execute" ? "" : " "}`);
      }
      return;
    }
    if (isEscape(key)) {
      // Interrupt the active session if running
      if (isInterruptInFlight(props.runtime.chatView.status)) {
        requestActiveSessionInterrupt();
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
        closeCommandMenu();
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
    if (view === "chat" && !promptDisabled && isPlainArrowUp(key) && !commandCompletionOpen && !skillCompletionOpen) {
      const previous = history.previous(prompt);
      if (previous !== undefined) setPromptFromHistory(previous);
      return;
    }
    if (view === "chat" && !promptDisabled && isPlainArrowDown(key) && !commandCompletionOpen && !skillCompletionOpen) {
      const next = history.next(prompt);
      if (next !== undefined) setPromptFromHistory(next);
      return;
    }
  });

  const gitBranch = useGitBranch(cwd, props.options?.gitBranch);
  const shellOptions: StatusFooterOptions = {
    ...statusOptions,
    ...(gitBranch ? { gitBranch } : {}),
  };
  const modelPickerModel = modelPicker
    ? modelPickerView(modelPicker, modelCandidates, modelSelection)
    : undefined;
  const reasoningPickerModel = reasoningPicker
    ? reasoningPickerView(reasoningPicker, reasoningLevel ?? DEFAULT_REASONING_LEVEL, availableReasoningLevels)
    : undefined;
  const permissionsPickerModel = permissionsPicker
    ? permissionsPickerView(permissionsPicker, props.runtime.permissionConfig?.profiles ?? [])
    : undefined;
  const resumePickerModel = resumePicker
    ? resumePickerView(resumePicker, resumePickerItems, props.runtime.activeSessionId)
    : undefined;
  const renamePromptModel = renamePrompt;

  if (commandConfirmation) {
    return (
      <box width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent="center" backgroundColor={theme.colors.background}>
        <box width={Math.min(72, Math.max(36, dimensions.width - 8))} flexDirection="column" border borderStyle="single" borderColor={theme.colors.status.warning} paddingX={2} paddingY={1}>
          <text fg={theme.colors.status.warning} wrapMode="none" truncate>{"Confirm command"}</text>
          <box height={1} />
          <text fg={theme.colors.text.primary} wrapMode="word">{commandConfirmation.title}</text>
          <box height={1} />
          <text fg={commandConfirmation.selectedIndex === 0 ? theme.colors.menu.selectedText : theme.colors.menu.text} bg={commandConfirmation.selectedIndex === 0 ? theme.colors.menu.selectedBackground : theme.colors.menu.background} wrapMode="none">{"  Cancel"}</text>
          <text fg={commandConfirmation.selectedIndex === 1 ? theme.colors.menu.selectedText : theme.colors.menu.text} bg={commandConfirmation.selectedIndex === 1 ? theme.colors.menu.selectedBackground : theme.colors.menu.background} wrapMode="none">{"  Confirm"}</text>
          <box height={1} />
          <text fg={theme.colors.text.muted} wrapMode="none" truncate>{"←/→ choose · Enter confirm · Esc cancel"}</text>
        </box>
      </box>
    );
  }

  const home = !sessionLayoutEntered
    && props.runtime.chatView.items.length === 0
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
          focused={view === "chat" && !paletteOpen && !themePicker && !modelPicker && !reasoningPicker && !permissionsPicker && !resumePicker && !renamePrompt && !disabledReason}
          onPromptChange={handlePromptChange}
          onExitShortcut={handleCtrlCExitShortcut}
          onPasteShortcut={readPromptClipboard}
          onTextPaste={registerPromptTextPaste}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedCommandCompletion()) return;
            submitCurrentChatPrompt();
          }}
          completions={completions}
          completionOpen={skillCompletionOpen || commandCompletionOpen}
          completionTitle={skillCompletionOpen ? "Skills" : "Commands"}
          emptyCompletionText={skillCompletionOpen ? "no skills" : "no commands"}
          completionIndex={selectedCompletionIndex}
          paletteOpen={paletteOpen}
          paletteTitle={`Command Palette · ${paletteQuery || "type to search"}`}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          agentExperience={agentExperience}
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
          resumePicker={resumePickerModel}
          renamePrompt={renamePromptModel}
        />
      ) : (
        <SessionScreen
          width={dimensions.width}
          height={dimensions.height}
          view={view}
          prompt={prompt}
          promptInputResetKey={promptInputResetKey}
          focused={view === "chat" && !paletteOpen && !themePicker && !modelPicker && !reasoningPicker && !permissionsPicker && !resumePicker && !renamePrompt && !disabledReason}
          onPromptChange={handlePromptChange}
          onExitShortcut={handleCtrlCExitShortcut}
          onPasteShortcut={readPromptClipboard}
          onTextPaste={registerPromptTextPaste}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedCommandCompletion()) return;
            scrollMessageToBottom();
            submitCurrentChatPrompt();
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
          completionOpen={skillCompletionOpen || commandCompletionOpen}
          completionTitle={skillCompletionOpen ? "Skills" : "Commands"}
          emptyCompletionText={skillCompletionOpen ? "no skills" : "no commands"}
          completionIndex={selectedCompletionIndex}
          paletteOpen={paletteOpen}
          paletteTitle={`Command Palette · ${paletteQuery || "type to search"}`}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          agentExperience={agentExperience}
          options={shellOptions}
          runtime={props.runtime}
          mcpManager={mcpManager}
          statusPage={statusPage}
          statusClipboardFeedback={statusClipboardFeedback}
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
          resumePicker={resumePickerModel}
          renamePrompt={renamePromptModel}
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
  completions: readonly TuiCommandSuggestion[];
  completionOpen: boolean;
  completionTitle: string;
  emptyCompletionText: string;
  completionIndex: number;
  paletteOpen: boolean;
  paletteTitle: string;
  paletteItems: readonly TuiCommandSuggestion[];
  paletteIndex: number;
  agentExperience: AgentsViewModel;
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
  resumePicker?: ResumePickerModel | undefined;
  renamePrompt?: RenamePromptNavigation | undefined;
}) {
  const promptWidth = Math.min(76, Math.max(42, props.width - 12));
  const compactBrand = props.width < 92 || props.height < 32;
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const modelPicker = fitModelPickerRows(
    props.modelPicker,
    props.height
      - footerHeight
      - PROMPT_INPUT_HEIGHT
      - (feedback ? 1 : 0)
      - MODEL_PICKER_CHROME_HEIGHT,
  );
  const showBrand = !modelPicker;
  const selectorHeight = selectorPickerHeight(modelPicker, props.reasoningPicker, props.permissionsPicker, props.resumePicker, props.renamePrompt);
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    themePickerHeight,
    selectorHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completionOpen || props.completions.length > 0,
    menuItems: props.paletteOpen ? props.paletteItems : props.completions,
  });
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexGrow={2} />
      <box width="100%" flexDirection="column" alignItems="center">
        {showBrand ? (
          <>
            <BrandMark compact={compactBrand} />
            <box height={1} />
            <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Chili"}</text>
            <box height={1} />
          </>
        ) : null}
        {props.themePicker ? <ThemePicker model={props.themePicker} theme={props.theme} /> : null}
        {modelPicker ? <ModelPicker model={modelPicker} theme={props.theme} /> : null}
        {props.reasoningPicker ? <ReasoningPicker model={props.reasoningPicker} theme={props.theme} /> : null}
        {props.permissionsPicker ? <PermissionsPicker model={props.permissionsPicker} theme={props.theme} /> : null}
        {props.resumePicker ? <ResumePicker model={props.resumePicker} theme={props.theme} /> : null}
        {props.renamePrompt ? <RenamePrompt model={props.renamePrompt} theme={props.theme} /> : null}
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
          paletteTitle={props.paletteTitle}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={feedback}
          theme={props.theme}
          maxCommandItems={maxCommandItems}
        />
      </box>
      <box flexGrow={3} />
      <StatusFooter options={props.options} agentExperience={props.agentExperience} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} width={props.width} theme={props.theme} showToolDetails={props.showToolDetails} transcriptActive={props.transcriptActive} />
    </box>
  );
}

function SessionScreen(props: {
  width: number;
  height: number;
  view: ShellView;
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
  completions: readonly TuiCommandSuggestion[];
  completionOpen: boolean;
  completionTitle: string;
  emptyCompletionText: string;
  completionIndex: number;
  paletteOpen: boolean;
  paletteTitle: string;
  paletteItems: readonly TuiCommandSuggestion[];
  paletteIndex: number;
  agentExperience: AgentsViewModel;
  runtime: ChatRuntimeState;
  mcpManager: McpManagerState;
  statusPage: StatusPageModel;
  statusClipboardFeedback?: StatusPageFeedback | undefined;
  options: StatusFooterOptions;
  showToolDetails: boolean;
  hideThinking: boolean;
  transcriptActive: boolean;
  commands: readonly TuiCommand[];
  disabledReason?: string | undefined;
  theme: TuiTheme;
  themePicker?: ThemePickerModel | undefined;
  modelPicker?: ModelPickerModel | undefined;
  reasoningPicker?: ReasoningPickerModel | undefined;
  permissionsPicker?: PermissionsPickerModel | undefined;
  resumePicker?: ResumePickerModel | undefined;
  renamePrompt?: RenamePromptNavigation | undefined;
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  const messageWidth = Math.max(24, props.width - 8);
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const modelPicker = fitModelPickerRows(
    props.modelPicker,
    props.height
      - themePickerHeight
      - footerHeight
      - PROMPT_INPUT_HEIGHT
      - (feedback ? 1 : 0)
      - 2
      - MODEL_PICKER_CHROME_HEIGHT,
  );
  const selectorHeight = selectorPickerHeight(modelPicker, props.reasoningPicker, props.permissionsPicker, props.resumePicker, props.renamePrompt);
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    themePickerHeight,
    selectorHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completionOpen || props.completions.length > 0,
    menuItems: props.paletteOpen ? props.paletteItems : props.completions,
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
  const messagePaneHeight = Math.max(1, props.height - themePickerHeight - selectorHeight - promptHeight - footerHeight);
  const transcriptChrome = props.height < 16 ? 6 : 3;
  const transcriptVisibleLimit = Math.max(1, props.height - themePickerHeight - selectorHeight - promptHeight - footerHeight - transcriptChrome);
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
          <StatusView page={props.statusPage} feedback={props.statusClipboardFeedback} theme={props.theme} />
        ) : props.view === "mcp" ? (
          <McpManager state={props.mcpManager} runtime={props.runtime} theme={props.theme} />
        ) : props.view === "agents" ? (
          <AgentsView model={props.agentExperience} theme={props.theme} />
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
            cwd={props.runtime.chatView.cwd ?? props.options.cwd}
            onOpenFile={props.onOpenFile}
            theme={props.theme}
            showToolDetails={props.showToolDetails}
            hideThinking={props.hideThinking}
          />
        )}
      </box>
      <box width="100%" alignItems="center" flexDirection="column">
        {props.themePicker ? <ThemePicker model={props.themePicker} theme={props.theme} /> : null}
        {modelPicker ? <ModelPicker model={modelPicker} theme={props.theme} /> : null}
        {props.reasoningPicker ? <ReasoningPicker model={props.reasoningPicker} theme={props.theme} /> : null}
        {props.permissionsPicker ? <PermissionsPicker model={props.permissionsPicker} theme={props.theme} /> : null}
        {props.resumePicker ? <ResumePicker model={props.resumePicker} theme={props.theme} /> : null}
        {props.renamePrompt ? <RenamePrompt model={props.renamePrompt} theme={props.theme} /> : null}
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
          paletteTitle={props.paletteTitle}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={feedback}
          theme={props.theme}
          maxCommandItems={maxCommandItems}
        />
      </box>
      <StatusFooter options={props.options} agentExperience={props.agentExperience} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} width={props.width} theme={props.theme} showToolDetails={props.showToolDetails} transcriptActive={props.transcriptActive} />
    </box>
  );
}

function estimatedTranscriptLineCount(items: readonly ChatTranscriptItem[], localItems: readonly LocalTranscriptItem[], width: number): number {
  const transcriptLineCount = buildTranscriptLines(items).reduce((count, line) => count + roughTextLineCount(line.text, width), 0);
  const localLineCount = localItems.reduce((count, item) => count + roughTextLineCount(localTranscriptEstimateText(item), width), 0);
  return transcriptLineCount + localLineCount;
}

function localTranscriptEstimateText(item: LocalTranscriptItem): string {
  if (item.kind === "local") return item.bare ? item.text : `${item.level}: ${item.text}`;
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
  cursor: number;
  selectedIndex: number;
  selected: ModelSelection | undefined;
  provider: string | undefined;
}

interface ModelPickerModel {
  query: string;
  cursor: number;
  items: readonly ModelPickerItem[];
  selectedIndex: number;
  total: number;
  provider: ModelPickerProvider;
  visibleLimit: number;
}

interface ModelPickerItem {
  selection: ModelSelection;
  label: string;
  provider: string;
  providerLabel: string;
  displayName?: string | undefined;
  connectionLabel?: string | undefined;
  authSource?: ModelCandidate["authSource"];
  endpoint?: string | undefined;
  available?: boolean | undefined;
  current: boolean;
}

interface ModelPickerProvider {
  id: string | undefined;
  label: string;
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

interface ResumePickerNavigation {
  query: string;
  selectedIndex: number;
  sessions: readonly RuntimeSessionSummary[];
  loading: boolean;
  showAll: boolean;
  error?: string;
}

interface ResumePickerModel {
  query: string;
  items: readonly RuntimeSessionSummary[];
  selectedIndex: number;
  loading: boolean;
  showAll: boolean;
  currentSessionId?: SessionId;
  error?: string;
}

interface RenamePromptNavigation {
  value: string;
  submitting: boolean;
}

interface SkillMentionTrigger {
  start: number;
  query: string;
}

type SkillCompletion = TuiCommandSuggestion & { skill: SkillSummary };

function pickerHeight(itemCount: number): number {
  return itemCount + 3;
}

function selectorPickerHeight(
  modelPicker: ModelPickerModel | undefined,
  reasoningPicker: ReasoningPickerModel | undefined,
  permissionsPicker: PermissionsPickerModel | undefined,
  resumePicker: ResumePickerModel | undefined,
  renamePrompt: RenamePromptNavigation | undefined,
): number {
  if (modelPicker) {
    return Math.min(modelPicker.items.length, modelPicker.visibleLimit) + MODEL_PICKER_CHROME_HEIGHT;
  }
  if (reasoningPicker) return reasoningPicker.items.length + 3;
  if (permissionsPicker) return permissionsPicker.items.length + 3;
  if (resumePicker) return Math.min(resumePicker.items.length, 8) + 6;
  if (renamePrompt) return 5;
  return 0;
}

function promptMenuItemLimit(input: {
  height: number;
  footerHeight: number;
  themePickerHeight: number;
  selectorHeight: number;
  feedback: boolean;
  menuOpen: boolean;
  menuItems: readonly TuiCommandSuggestion[];
}): number {
  if (!input.menuOpen) return PROMPT_MENU_MAX_ITEMS;
  const reserved = input.footerHeight
    + input.themePickerHeight
    + input.selectorHeight
    + PROMPT_INPUT_HEIGHT
    + (input.feedback ? 1 : 0)
    + 1;
  const availableHeight = input.height - reserved;
  for (let maxItems = PROMPT_MENU_MAX_ITEMS; maxItems >= 1; maxItems -= 1) {
    if (commandListHeight(input.menuItems, maxItems) <= availableHeight) return maxItems;
  }
  return 1;
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
  const visibleItems = visiblePickerItems(props.model.items, props.model.selectedIndex, props.model.visibleLimit);
  const cursor = Math.min(Math.max(0, props.model.cursor), props.model.query.length);
  const searchValue = `${props.model.query.slice(0, cursor)}▏${props.model.query.slice(cursor)}`;
  const hasQuery = props.model.query.trim().length > 0;
  const resultNoun = hasQuery
    ? props.model.total === 1 ? "match" : "matches"
    : props.model.total === 1 ? "model" : "models";
  const resultLabel = `${props.model.total} ${resultNoun}`;
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Select model"}</text>
      <box
        width="100%"
        height={3}
        border
        borderStyle="single"
        borderColor={props.theme.colors.border.default}
        backgroundColor={props.theme.colors.input.background}
        paddingX={1}
        flexDirection="row"
        alignItems="center"
      >
        <text
          fg={hasQuery ? props.theme.colors.input.text : props.theme.colors.input.placeholder}
          wrapMode="none"
          truncate
        >
          {`Search  > ${searchValue}${hasQuery ? "" : "  type a model or source"}`}
        </text>
      </box>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>
        {`Source  ${props.model.provider.label} · ${resultLabel}  tab switch`}
      </text>
      {visibleItems.map(({ item, index }) => {
        const selected = index === props.model.selectedIndex;
        const suffix = [item.available === false ? " not configured" : "", item.current ? " *" : ""].join("");
        const provider = ` [${item.providerLabel}]`;
        return (
          <text
            key={modelSelectionLabel(item.selection)}
            fg={selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${item.label}${provider}${suffix}`}
          </text>
        );
      })}
      {props.model.items.length === 0 ? (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  No matching models"}</text>
      ) : (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{modelPickerDetail(props.model)}</text>
      )}
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  ↑/↓ navigate  type to search  tab source  enter select  esc close"}</text>
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

function ResumePicker(props: { model: ResumePickerModel; theme: TuiTheme }) {
  const visibleItems = visiblePickerItems(props.model.items, props.model.selectedIndex, 8);
  const scope = props.model.showAll ? "all projects" : "current project";
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Resume saved chat"}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Search: ${props.model.query || "type to filter"}  Scope: ${scope}`}</text>
      {props.model.loading ? (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  Loading sessions..."}</text>
      ) : props.model.error ? (
        <text fg={props.theme.colors.status.error} wrapMode="none" truncate>{`  ${props.model.error}`}</text>
      ) : visibleItems.length === 0 ? (
        <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{props.model.showAll ? "  No matching saved chats" : "  No matching chats in this project"}</text>
      ) : visibleItems.map(({ item, index }) => {
        const selected = index === props.model.selectedIndex;
        const current = item.id === props.model.currentSessionId ? " (current)" : "";
        const preview = sessionDisplayPreview(item);
        return (
          <text
            key={item.id}
            fg={selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${selected ? ">" : " "} ${sessionDisplayTitle(item)}${current}  ${relativeSessionTime(item.updatedAt)}${preview ? `  ${preview}` : ""}`}
          </text>
        );
      })}
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  ↑/↓ navigate  enter resume  ctrl+a all projects  esc close"}</text>
    </box>
  );
}

function RenamePrompt(props: { model: RenamePromptNavigation; theme: TuiTheme }) {
  const status = props.model.submitting
    ? "Saving..."
    : props.model.value || "Type a name";
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Rename chat"}</text>
      <text fg={props.model.value ? props.theme.colors.input.text : props.theme.colors.input.placeholder} wrapMode="none" truncate>{`> ${status}`}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  enter save  esc cancel"}</text>
    </box>
  );
}

function modelPickerView(
  picker: ModelPickerNavigation,
  candidates: readonly ModelCandidate[],
  current: ModelSelection | undefined,
): ModelPickerModel {
  const providers = modelPickerProviders(candidates, current, picker.query, picker.provider);
  const providerIndex = Math.max(0, providers.findIndex((provider) => provider.id === picker.provider));
  const provider = providers[providerIndex] ?? providers[0]!;
  const items = modelPickerCandidates(candidates, picker.query, current, provider.id).map((candidate) => ({
    selection: modelDescriptorSelection(candidate),
    label: candidate.model,
    provider: candidate.provider,
    providerLabel: candidate.providerDisplayName ?? candidate.provider,
    ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
    ...(candidate.connectionLabel ? { connectionLabel: candidate.connectionLabel } : {}),
    ...(candidate.authSource ? { authSource: candidate.authSource } : {}),
    ...(candidate.endpoint ? { endpoint: candidate.endpoint } : {}),
    ...(candidate.available !== undefined ? { available: candidate.available } : {}),
    current: sameModelSelection(current, modelDescriptorSelection(candidate)),
  }));
  return {
    query: picker.query,
    cursor: picker.cursor,
    items,
    selectedIndex: resolvedModelPickerIndex(picker, items, (item) => item.selection),
    total: items.length,
    provider,
    visibleLimit: MODEL_PICKER_MAX_VISIBLE_ITEMS,
  };
}

function fitModelPickerRows(
  model: ModelPickerModel | undefined,
  availableRows: number,
): ModelPickerModel | undefined {
  if (!model) return undefined;
  return {
    ...model,
    visibleLimit: Math.max(0, Math.min(model.visibleLimit, availableRows)),
  };
}

function modelPickerProviders(
  candidates: readonly ModelCandidate[],
  current: ModelSelection | undefined,
  query: string,
  activeProvider: string | undefined,
): ModelPickerProvider[] {
  const matchingCandidates = filterModelCandidates(candidates, query, current);
  const matchingCounts = new Map<string, number>();
  for (const candidate of matchingCandidates) {
    matchingCounts.set(candidate.provider, (matchingCounts.get(candidate.provider) ?? 0) + 1);
  }
  const hasQuery = query.trim().length > 0;
  const providers = new Map<string, ModelPickerProvider>();
  for (const candidate of candidates) {
    const matchCount = matchingCounts.get(candidate.provider) ?? 0;
    if (hasQuery && matchCount === 0 && candidate.provider !== activeProvider) continue;
    const existing = providers.get(candidate.provider);
    providers.set(candidate.provider, {
      id: candidate.provider,
      label: candidate.providerDisplayName ?? existing?.label ?? candidate.provider,
    });
  }
  const sorted = [...providers.values()].sort((left, right) => {
    if (left.id === current?.provider && right.id !== current?.provider) return -1;
    if (right.id === current?.provider && left.id !== current?.provider) return 1;
    return left.label.localeCompare(right.label);
  });
  return [{ id: undefined, label: "All" }, ...sorted];
}

function modelPickerCandidates(
  candidates: readonly ModelCandidate[],
  query: string,
  current: ModelSelection | undefined,
  provider: string | undefined,
): ModelCandidate[] {
  const scoped = provider ? candidates.filter((candidate) => candidate.provider === provider) : candidates;
  return filterModelCandidates(scoped, query, current);
}

function reasoningPickerView(
  picker: ReasoningPickerNavigation,
  current: ReasoningLevel,
  availableLevels: readonly ReasoningLevel[],
): ReasoningPickerModel {
  const items = availableLevels.map((level) => ({
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

function resumePickerView(
  picker: ResumePickerNavigation,
  items: readonly RuntimeSessionSummary[],
  currentSessionId: SessionId | undefined,
): ResumePickerModel {
  return {
    query: picker.query,
    items,
    selectedIndex: clampIndex(picker.selectedIndex, items.length),
    loading: picker.loading,
    showAll: picker.showAll,
    ...(currentSessionId ? { currentSessionId } : {}),
    ...(picker.error ? { error: picker.error } : {}),
  };
}

function filteredResumeSessions(
  sessions: readonly RuntimeSessionSummary[],
  query: string,
  cwd: string,
  showAll: boolean,
): RuntimeSessionSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sessions
    .filter(isResumableRootSession)
    .filter((session) => session.status === "active")
    .filter((session) => showAll || samePath(session.cwd, cwd))
    .filter((session) => {
      if (!normalizedQuery) return true;
      const text = [session.id, session.title, session.preview, session.cwd].filter(Boolean).join(" ").toLowerCase();
      return text.includes(normalizedQuery) || fuzzyMatchText(text, normalizedQuery);
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id)));
}

function resolveResumeTarget(
  sessions: readonly RuntimeSessionSummary[],
  target: string,
): RuntimeSessionSummary | string {
  const normalized = target.trim().toLowerCase();
  const active = sessions.filter((session) => session.status === "active" && isResumableRootSession(session));
  const exactId = active.find((session) => String(session.id).toLowerCase() === normalized);
  if (exactId) return exactId;
  const exactTitles = active.filter((session) => session.title?.toLowerCase() === normalized);
  if (exactTitles.length === 1) return exactTitles[0]!;
  if (exactTitles.length > 1) return `More than one saved chat is named "${target}". Use /session resume and select one, or pass its session ID.`;
  const idPrefixes = active.filter((session) => String(session.id).toLowerCase().startsWith(normalized));
  if (idPrefixes.length === 1) return idPrefixes[0]!;
  if (idPrefixes.length > 1) return `Session ID prefix "${target}" is ambiguous.`;
  return `Saved chat not found: ${target}`;
}

function isResumableRootSession(session: RuntimeSessionSummary): boolean {
  return !session.agent;
}

function sessionDisplayTitle(session: RuntimeSessionSummary): string {
  const automaticTitle = session.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled";
  const title = session.title?.trim();
  if (title && title !== automaticTitle) return shorten(title, 44);
  const preview = firstDisplayLine(session.preview);
  if (preview) return shorten(preview, 44);
  return shorten(title || String(session.id), 44);
}

function sessionDisplayPreview(session: RuntimeSessionSummary): string {
  const title = sessionDisplayTitle(session);
  const preview = firstDisplayLine(session.preview);
  if (!preview || title === shorten(preview, 44)) {
    return session.cwd.split("/").filter(Boolean).at(-1) ?? session.cwd;
  }
  return shorten(preview, 54);
}

function firstDisplayLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function relativeSessionTime(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - time) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(time).toISOString().slice(0, 10);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, "") || "/";
  return normalize(left) === normalize(right);
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
  const connection = safeConnectionLabel(selected.connectionLabel);
  const endpoint = safeEndpointHost(selected.endpoint);
  const details = [
    connection ? `connection ${connection}` : undefined,
    selected.authSource ? `auth ${modelAuthLabel(selected.authSource)}` : undefined,
    endpoint ? `endpoint ${endpoint}` : undefined,
  ].filter(Boolean).join(" · ");
  const suffix = details ? ` · ${details}` : "";
  return `  ${modelSelectionLabel(selected.selection)}${displayName}${availability}${count}${suffix}`;
}

function resolvedModelPickerIndex<T>(
  picker: ModelPickerNavigation,
  items: readonly T[],
  selectionForItem: (item: T) => ModelSelection,
): number {
  if (picker.selected) {
    const selectedIndex = items.findIndex((item) => sameModelSelection(picker.selected, selectionForItem(item)));
    if (selectedIndex >= 0) return selectedIndex;
  }
  return clampIndex(picker.selectedIndex, items.length);
}

function modelPickerSelectedCandidate(
  items: readonly ModelCandidate[],
  index: number,
): ModelSelection | undefined {
  const candidate = items[index];
  return candidate ? modelDescriptorSelection(candidate) : undefined;
}

function modelPickerIndex(
  candidates: readonly ModelCandidate[],
  query: string,
  current: ModelSelection | undefined,
  provider: string | undefined,
): number {
  const items = modelPickerCandidates(candidates, query, current, provider);
  if (items.length === 0) return 0;
  if (query.trim()) return 0;
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
      return "Extra-high reasoning (~32k tokens)";
    case "max":
      return "Maximum reasoning for the hardest problems";
    case "ultra":
      return "Maximum reasoning with proactive agents";
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
      id: `skill:${skill.filePath}`,
      value: `${skill.name}`,
      label: `$${skill.name}`,
      description: skillDescription(skill),
      group: "skills",
      source: "builtin" as const,
      argumentHint: "",
      hidden: false,
      enabled: true,
      intent: "execute" as const,
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
}): void {
  const next = `${input.prompt.slice(0, input.trigger.start)}$${input.skill.name} ${input.prompt.slice(input.trigger.start + input.trigger.query.length + 1)}`;
  input.history.resetNavigation();
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
      warnings.push(`Skill $${name} is ambiguous; select it from /skills browse so Chili can bind the exact SKILL.md.`);
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

function HelpView(props: { commands: readonly TuiCommand[]; theme: TuiTheme; showToolDetails: boolean }) {
  const detailsText = props.showToolDetails ? "on" : "off";
  const commandNodes = collectCommandNodes(props.commands).filter((command) => !command.hidden);
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Commands"}</text>
      <box height={1} />
      {commandNodes.map((command) => (
        <text key={command.id} fg={props.theme.colors.text.secondary} wrapMode="none" truncate>
          {`${command.path.padEnd(24)} ${command.description}`}
        </text>
      ))}
      <box height={1} />
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"!cmd runs a local shell command without asking the model."}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Esc closes views. Ctrl+C clears input; press again quickly to exit. Ctrl+P opens commands. Ctrl+O toggles tool details (${detailsText}). Ctrl+T opens transcript. Ctrl+V pastes. Ctrl+Shift+C copies.`}</text>
    </box>
  );
}

function countRuntimeCommandNodes(nodes: readonly RuntimeCommandNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countRuntimeCommandNodes(node.children), 0);
}

type StatusPageRowTone = "heading" | "text" | "error" | "spacer";

interface StatusPageRow {
  key: string;
  text: string;
  tone: StatusPageRowTone;
}

interface StatusPageModel {
  rows: readonly StatusPageRow[];
  text: string;
}

interface StatusPageInput {
  runtime: ChatRuntimeState;
  options: StatusFooterOptions;
  agentExperience: AgentsViewModel;
  showToolDetails: boolean;
  hideThinking: boolean;
  transcriptActive: boolean;
}

interface StatusPageFeedback {
  level: "info" | "error";
  text: string;
}

function StatusView(props: { page: StatusPageModel; feedback?: StatusPageFeedback | undefined; theme: TuiTheme }) {
  const selectionColors = {
    selectionBg: props.theme.colors.menu.selectedBackground,
    selectionFg: props.theme.colors.menu.selectedText,
  };
  const [heading, ...bodyRows] = props.page.rows;
  return (
    <box width="100%" height="100%" flexDirection="column">
      {heading ? <StatusPageRowView row={heading} theme={props.theme} selectionColors={selectionColors} /> : null}
      {props.feedback ? (
        <TranscriptLine
          line={{
            key: `status:feedback:${props.feedback.level}:${props.feedback.text}`,
            text: props.feedback.text,
            fg: props.feedback.level === "error" ? props.theme.colors.status.error : props.theme.colors.status.info,
          }}
          selectionColors={selectionColors}
        />
      ) : null}
      {bodyRows.map((row) => <StatusPageRowView key={row.key} row={row} theme={props.theme} selectionColors={selectionColors} />)}
    </box>
  );
}

function StatusPageRowView(props: {
  row: StatusPageRow;
  theme: TuiTheme;
  selectionColors: { selectionBg: string; selectionFg: string };
}) {
  if (props.row.tone === "spacer") return <box height={1} />;
  return (
    <TranscriptLine
      line={{ key: props.row.key, text: props.row.text, fg: statusPageRowFg(props.row.tone, props.theme) }}
      selectionColors={props.selectionColors}
    />
  );
}

function statusPageModel(input: StatusPageInput): StatusPageModel {
  const modelSelection = statusModelSelection(input.runtime, input.options);
  const candidate = modelSelection
    ? input.runtime.modelCandidates?.find((item) => sameModelSelection(modelSelection, modelDescriptorSelection(item)))
    : undefined;
  const modelLabel = modelSelection
    ? modelSelectionLabel(modelSelection)
    : `${input.options.providerName}/${input.options.modelName}`;
  const connection = safeConnectionLabel(candidate?.connectionLabel)
    ?? safeConnectionLabel(candidate?.providerDisplayName)
    ?? safeConnectionLabel(modelSelection?.provider)
    ?? "unknown";
  const auth = modelAuthLabel(candidate?.authSource);
  const endpoint = safeEndpointHost(candidate?.endpoint) ?? "unknown";
  const executionStatus = input.runtime.chatView.status;
  const rows: StatusPageRow[] = [
    { key: "status:title", text: "Status", tone: "heading" },
    { key: "status:spacer", text: "", tone: "spacer" },
    { key: "status:event-stream", text: `event stream: ${eventStreamStatus(input.runtime.connection.status)}`, tone: "text" },
    { key: "status:execution", text: `parent execution: ${input.agentExperience.parentExecution}`, tone: executionStatus === "failed" || executionStatus === "cancelled" ? "error" : "text" },
  ];
  const reason = singleLineStatusValue(input.runtime.chatView.statusReason);
  if ((executionStatus === "failed" || executionStatus === "cancelled") && reason) {
    rows.push({ key: "status:reason", text: `reason: ${reason}`, tone: "error" });
  }
  rows.push(
    { key: "status:agent-capability", text: `agent capability: ${input.agentExperience.capability}`, tone: input.agentExperience.capability.startsWith("unavailable") ? "error" : "text" },
    { key: "status:delegation", text: `delegation: ${input.agentExperience.delegation}`, tone: "text" },
    { key: "status:agents", text: `agents: ${input.agentExperience.summary}`, tone: "text" },
    { key: "status:session", text: `session: ${input.runtime.activeSessionId ?? "none"}`, tone: "text" },
    { key: "status:mode", text: `mode: ${input.options.modeName}`, tone: "text" },
    { key: "status:model", text: `model: ${modelLabel}`, tone: "text" },
    { key: "status:connection", text: `connection: ${connection}`, tone: "text" },
    { key: "status:auth", text: `auth: ${auth}`, tone: "text" },
    { key: "status:endpoint", text: `endpoint: ${endpoint}`, tone: "text" },
    { key: "status:thinking", text: `thinking: ${input.options.reasoningConfigurable === false ? "unsupported" : input.options.reasoningLevel ?? "default"}`, tone: "text" },
    { key: "status:service-tier", text: `service tier: ${input.options.serviceTierConfigurable === false ? "unsupported" : input.options.serviceTier ?? "standard"}`, tone: "text" },
    { key: "status:thinking-traces", text: `thinking traces: ${input.hideThinking ? "hidden" : "shown"}`, tone: "text" },
    { key: "status:details", text: `details: ${input.showToolDetails ? "on" : "off"}`, tone: "text" },
    { key: "status:transcript", text: `transcript: ${input.transcriptActive ? "on" : "off"}`, tone: "text" },
    { key: "status:workspace", text: `workspace: ${input.runtime.chatView.cwd ?? input.options.cwd}`, tone: "text" },
    ...(input.runtime.chatView.cwd && input.runtime.chatView.cwd !== input.options.cwd
      ? [{ key: "status:local-cwd", text: `local cwd: ${input.options.cwd}`, tone: "text" as const }]
      : []),
  );
  return { rows, text: rows.map((row) => row.text).join("\n") };
}

function statusPageRowFg(tone: Exclude<StatusPageRowTone, "spacer">, theme: TuiTheme): string {
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "error") return theme.colors.status.error;
  return theme.colors.text.secondary;
}

function singleLineStatusValue(value: string | undefined): string | undefined {
  return publicStatusReason(value);
}

function statusModelSelection(runtime: ChatRuntimeState, options: StatusFooterOptions): ModelSelection | undefined {
  if (options.modelSelection) return options.modelSelection;
  const metadata = runtime.chatView.latestModelMetadata;
  if (metadata?.provider && metadata.model) {
    return { provider: metadata.provider, model: metadata.model };
  }
  return modelSelectionFromOptions(options);
}

function safeConnectionLabel(value: string | undefined): string | undefined {
  const sanitized = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(sanitized)) return safeEndpointHost(sanitized);
  return sanitized.slice(0, 80);
}

function eventStreamStatus(status: RuntimeConnectionState["status"]): string {
  return status === "streaming" ? "connected" : status;
}

function modelSelectionFromOptions(
  options: { providerName?: string | undefined; modelName?: string | undefined } | undefined,
): ModelSelection | undefined {
  const provider = options?.providerName?.trim();
  const model = options?.modelName?.trim();
  return provider && model ? { provider, model } : undefined;
}

function capabilityModelLabel(selection: ModelSelection | undefined): string {
  return selection ? modelSelectionLabel(selection) : "Selected model";
}

function modelToolCallSupport(candidate: ModelCandidate | undefined): boolean | undefined {
  return candidate?.capabilities?.toolCalls;
}

async function submitPrompt(
  prompt: string,
  expandedPrompt: string,
  commands: readonly TuiCommand[],
  ctx: TuiCommandContext,
  runtime: ChatRuntimeState,
  actions: CommandActions,
  onAccepted?: (text: string) => void,
  skillMentionBindings: readonly RuntimeSkillMention[] = [],
  skills: readonly SkillSummary[] = [],
  pastedImages: Readonly<Record<number, PastedPromptImage>> = {},
  clearPromptAttachments?: () => void,
  onPromptSubmissionState?: (state: "pending" | "accepted" | "rejected") => boolean | void,
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
    const commandMatch = resolveCommand(commands, ctx, commandPrompt);
    if (commandMatch.status === "matched") {
      actions.setPrompt("");
      clearPromptAttachments?.();
      await runResolvedCommand(commandMatch, ctx, runtime, actions);
      return;
    }
    if (commandMatch.status !== "not_command") {
      actions.appendLocalItem("error", commandResolutionMessage(commandMatch));
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
  onPromptSubmissionState?.("pending");
  const accepted = await runtime.submitPrompt(text, {
    ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
    ...(ctx.reasoningLevel ? { reasoningLevel: ctx.reasoningLevel } : {}),
    ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
    ...(text !== trimmed ? { displayText: visibleTrimmed } : {}),
    ...(images.length > 0 && supportsImages ? { images } : {}),
    ...activeSkillMentionsOption(visibleTrimmed, skillMentionBindings),
  });
  if (accepted) {
    const applyAcceptedState = onPromptSubmissionState?.("accepted") !== false;
    onAccepted?.(trimmed);
    if (applyAcceptedState) {
      actions.setPrompt("");
      clearPromptAttachments?.();
    }
  } else {
    onPromptSubmissionState?.("rejected");
  }
}

async function runUserShellCommand(command: string, cwd: string, actions: CommandActions): Promise<void> {
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

async function runCommandInput(
  input: string,
  commands: readonly TuiCommand[],
  ctx: TuiCommandContext,
  runtime: ChatRuntimeState,
  actions: CommandActions,
): Promise<void> {
  const match = resolveCommand(commands, ctx, input);
  if (match.status !== "matched") {
    actions.appendLocalItem("error", commandResolutionMessage(match));
    return;
  }
  await runResolvedCommand(match, ctx, runtime, actions);
}

async function runResolvedCommand(
  match: Extract<ResolveCommandResult<TuiCommandContext, TuiCommandResult>, { status: "matched" }>,
  ctx: TuiCommandContext,
  runtime: ChatRuntimeState,
  actions: CommandActions,
): Promise<void> {
  if (!match.command.run) {
    actions.appendLocalItem("error", `${match.path} cannot be executed.`);
    return;
  }
  const uiEpoch = actions.currentSessionUiEpoch();
  const result = await match.command.run(ctx, match.args);
  if (!actions.isSessionUiEpochCurrent(uiEpoch)) return;
  const scopedActions: CommandActions = {
    ...actions,
    enterSessionLayout: () => {
      if (actions.isSessionUiEpochCurrent(uiEpoch)) actions.enterSessionLayout();
    },
    appendLocalItem: (level, text, options) => {
      if (actions.isSessionUiEpochCurrent(uiEpoch)) actions.appendLocalItem(level, text, options);
    },
    setAuthManualPrompt: (value) => {
      if (actions.isSessionUiEpochCurrent(uiEpoch)) actions.setAuthManualPrompt(value);
    },
    ensureOpenAICodexDefaultModel: async () => {
      if (actions.isSessionUiEpochCurrent(uiEpoch)) await actions.ensureOpenAICodexDefaultModel();
    },
    requestConfirmation: (title, result) => {
      if (actions.isSessionUiEpochCurrent(uiEpoch)) actions.requestConfirmation(title, result);
    },
  };
  await applyCommandResult(result, ctx, runtime, scopedActions);
}

async function applyCommandResult(
  result: TuiCommandResult,
  ctx: TuiCommandContext,
  runtime: ChatRuntimeState,
  actions: CommandActions,
): Promise<void> {
  if (result.type === "confirm") {
    actions.requestConfirmation(result.title, result.result);
    return;
  }
  if (result.type === "open_view") {
    if (result.view === "help") {
      actions.openCommandPalette();
      return;
    }
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
    actions.enterSessionLayout();
    await actions.reloadCommands();
    return;
  }
  if (result.type === "reload_skills") {
    actions.enterSessionLayout();
    await actions.reloadSkills();
    actions.appendLocalItem("info", "Skills reloaded.");
    return;
  }
  if (result.type === "exit_app") {
    actions.exitApp();
    return;
  }
  if (result.type === "submit_command") {
    if (!runtime.canSubmit) {
      actions.appendLocalItem("error", runtime.submitBlockedReason ?? "Session is not ready for another prompt.");
      return;
    }
    actions.enterSessionLayout();
    const accepted = await runtime.submitCommand(result.commandId, result.args, {
      ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
      ...(ctx.reasoningLevel ? { reasoningLevel: ctx.reasoningLevel } : {}),
      ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
    });
    if (!accepted) actions.appendLocalItem("error", `Command ${result.commandId} did not submit.`);
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
  if (result.type === "open_resume_picker") {
    actions.openResumePicker();
    return;
  }
  if (result.type === "resume_session") {
    await actions.resumeSessionByTarget(result.target);
    return;
  }
  if (result.type === "open_rename_prompt") {
    actions.openRenamePrompt();
    return;
  }
  if (result.type === "rename_session") {
    await actions.renameChatSession(result.title);
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
  if (result.type === "delegation_action") {
    actions.enterSessionLayout();
    await performDelegationAction(result, runtime, actions.appendLocalItem);
    return;
  }
  if (result.type === "auth_action") {
    actions.enterSessionLayout();
    await performAuthAction(result, actions.appendLocalItem, actions.setAuthManualPrompt, actions.ensureOpenAICodexDefaultModel);
    return;
  }
  if (result.type === "skills_action") {
    actions.enterSessionLayout();
    await performSkillsAction(result, actions);
    return;
  }
  if (result.type === "mcp_action") {
    actions.enterSessionLayout();
    await performMcpAction(result, runtime, actions.appendLocalItem);
    return;
  }
  if (result.type === "agent_action") {
    try {
      if (result.action === "stop") await runtime.stopAgent(result.agentId);
      else await runtime.resumeAgent(result.agentId);
      actions.appendLocalItem("info", `Agent ${result.agentId} ${result.action === "stop" ? "stopped" : "resumed"}.`);
    } catch (error) {
      actions.appendLocalItem("error", errorMessage(error));
    }
    return;
  }
}

function commandResolutionMessage(
  result: Exclude<ResolveCommandResult<TuiCommandContext, TuiCommandResult>, { status: "matched" }>,
): string {
  if (result.status === "disabled") return `${result.path} is unavailable: ${result.reason}`;
  if (result.status === "incomplete") {
    const available = result.children.length > 0 ? `\nAvailable: ${result.children.join(", ")}` : "";
    return `Incomplete command. Usage: ${result.usage}${available}`;
  }
  if (result.status === "unknown") {
    const suggestions = result.suggestions.length > 0 ? ` Did you mean ${result.suggestions.join(" or ")}?` : "";
    return `Unknown command token: ${result.token || result.input}.${suggestions}`;
  }
  return `Not a command: ${result.input}`;
}

async function performDelegationAction(
  result: Extract<TuiCommandResult, { type: "delegation_action" }>,
  runtime: ChatRuntimeState,
  appendLocalItem: AppendLocalItem,
): Promise<void> {
  if (result.action === "status") {
    if (!runtime.activeSessionId && !runtime.chatView.sessionId) {
      appendLocalItem("error", "Start a session before checking its agent delegation policy.");
      return;
    }
    const config = await runtime.refreshDelegationConfig?.() ?? runtime.delegationConfig;
    if (!config) {
      appendLocalItem("error", "Could not read the session agent delegation policy.");
      return;
    }
    appendLocalItem("info", delegationConfigMessage(config.policy, config.source));
    return;
  }
  if (!result.policy || !runtime.setRuntimeDelegationPolicy) {
    appendLocalItem("error", "This runtime cannot update agent delegation policy.");
    return;
  }
  const config = await runtime.setRuntimeDelegationPolicy(result.policy);
  if (!config) {
    appendLocalItem("error", `Could not set agent delegation to ${result.policy}.`);
    return;
  }
  appendLocalItem("info", delegationConfigMessage(config.policy, config.source));
}

function delegationConfigMessage(policy: DelegationPolicy, source: string): string {
  const detail = policy === "off"
    ? "Chili will not delegate work in this session."
    : policy === "explicit"
      ? "Chili delegates only when the user explicitly requests it."
      : "Chili may delegate useful independent work proactively.";
  return `Agent delegation: ${policy} (source: ${source}). ${detail}`;
}

async function performSkillsAction(
  result: Extract<TuiCommandResult, { type: "skills_action" }>,
  actions: CommandActions,
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
  result: Extract<TuiCommandResult, { type: "mcp_action" }>,
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
  result: Extract<TuiCommandResult, { type: "auth_action" }>,
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
      : `ChatGPT Codex auth: not configured. Run /auth login to connect a ChatGPT Plus/Pro account. Auth file: ${status.authPath}.`;
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
        throw new Error("Local callback did not complete. Run /auth login again and keep the browser redirect window open.");
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
  const providers = modelPickerProviders(candidates, current, picker.query, picker.provider);
  const effectiveProvider = picker.provider !== undefined
    && providers.some((provider) => provider.id === picker.provider)
    ? picker.provider
    : undefined;
  if (isTab(key)) {
    const currentProviderIndex = Math.max(0, providers.findIndex((provider) => provider.id === effectiveProvider));
    const delta = key.shift ? -1 : 1;
    const provider = providers[wrapIndex(currentProviderIndex + delta, providers.length)]?.id;
    actions.setModelPicker((state) => {
      if (!state) return state;
      const items = modelPickerCandidates(candidates, state.query, current, provider);
      const selectedIndex = modelPickerIndex(candidates, state.query, current, provider);
      return {
        ...state,
        provider,
        selectedIndex,
        selected: modelPickerSelectedCandidate(items, selectedIndex),
      };
    });
    return;
  }
  if (isArrowLeft(key) || isArrowRight(key)) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const delta = isArrowLeft(key) ? -1 : 1;
      return {
        ...state,
        provider: effectiveProvider,
        cursor: Math.min(Math.max(0, state.cursor + delta), state.query.length),
      };
    });
    return;
  }
  const items = modelPickerCandidates(candidates, picker.query, current, effectiveProvider);
  if (isArrowUp(key) || isArrowDown(key)) {
    const delta = isArrowUp(key) ? -1 : 1;
    actions.setModelPicker((state) => {
      if (!state) return state;
      const currentIndex = resolvedModelPickerIndex(state, items, modelDescriptorSelection);
      const selectedIndex = clampIndex(currentIndex + delta, items.length);
      return {
        ...state,
        provider: effectiveProvider,
        selectedIndex,
        selected: modelPickerSelectedCandidate(items, selectedIndex),
      };
    });
    return;
  }
  if (isEnter(key)) {
    const selected = items[resolvedModelPickerIndex(picker, items, modelDescriptorSelection)];
    if (selected) void actions.selectModel(modelDescriptorSelection(selected));
    return;
  }
  if (isBackspace(key)) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const cursor = Math.min(Math.max(0, state.cursor), state.query.length);
      if (cursor === 0) return state;
      const query = `${state.query.slice(0, cursor - 1)}${state.query.slice(cursor)}`;
      const nextItems = modelPickerCandidates(candidates, query, current, effectiveProvider);
      const selectedIndex = modelPickerIndex(candidates, query, current, effectiveProvider);
      return {
        ...state,
        provider: effectiveProvider,
        query,
        cursor: cursor - 1,
        selectedIndex,
        selected: modelPickerSelectedCandidate(nextItems, selectedIndex),
      };
    });
    return;
  }
  if (isDelete(key)) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const cursor = Math.min(Math.max(0, state.cursor), state.query.length);
      if (cursor >= state.query.length) return state;
      const query = `${state.query.slice(0, cursor)}${state.query.slice(cursor + 1)}`;
      const nextItems = modelPickerCandidates(candidates, query, current, effectiveProvider);
      const selectedIndex = modelPickerIndex(candidates, query, current, effectiveProvider);
      return {
        ...state,
        provider: effectiveProvider,
        query,
        cursor,
        selectedIndex,
        selected: modelPickerSelectedCandidate(nextItems, selectedIndex),
      };
    });
    return;
  }
  const printable = printableKey(key);
  if (printable) {
    actions.setModelPicker((state) => {
      if (!state) return state;
      const cursor = Math.min(Math.max(0, state.cursor), state.query.length);
      const query = `${state.query.slice(0, cursor)}${printable}${state.query.slice(cursor)}`;
      const nextItems = modelPickerCandidates(candidates, query, current, effectiveProvider);
      const selectedIndex = modelPickerIndex(candidates, query, current, effectiveProvider);
      return {
        ...state,
        provider: effectiveProvider,
        query,
        cursor: cursor + printable.length,
        selectedIndex,
        selected: modelPickerSelectedCandidate(nextItems, selectedIndex),
      };
    });
  }
}

function handleReasoningPickerKey(
  key: KeyEvent,
  picker: ReasoningPickerNavigation,
  availableLevels: readonly ReasoningLevel[],
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
    actions.setReasoningPicker((state) => state ? { selectedIndex: clampIndex(state.selectedIndex + delta, availableLevels.length) } : state);
    return;
  }
  if (isEnter(key)) {
    const level = availableLevels[clampIndex(picker.selectedIndex, availableLevels.length)];
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
  if (runtime.chatFeedback?.status === "pending") return runtime.chatFeedback;
  if (runtime.chatFeedback?.status === "accepted") {
    if (acceptedFeedbackMatchesStatus(runtime.chatFeedback, runtime.chatView)) return runtime.chatFeedback;
    if (runtime.chatFeedback.acceptedAgainstStatusEventId === undefined
      && (runtime.chatView.status === "idle" || runtime.chatView.status === "unknown")) {
      return runtime.chatFeedback;
    }
  }
  const reason = publicStatusReason(runtime.chatView.statusReason);
  if (runtime.chatView.status === "failed") return { status: "error", message: reason ?? "Session failed" };
  if (runtime.chatView.status === "cancelled") return { status: "error", message: reason ?? "Session cancelled" };
  if (runtime.chatFeedback && runtime.chatFeedback.status !== "accepted") {
    if (runtime.chatFeedback.status === "error") {
      return {
        status: "error",
        message: publicStatusReason(runtime.chatFeedback.message) ?? "Runtime request failed",
      };
    }
    return runtime.chatFeedback;
  }
  if (runtime.chatView.status === "cancelling") return { status: "pending", message: "cancelling session" };
  // The footer already owns this state. Avoid consuming an
  // extra row (and never let a stale neutral acknowledgement replace the dock).
  if (runtime.chatView.status === "waiting_for_approval") return undefined;
  if (runtime.chatView.status === "running") {
    const retry = runtime.chatView.retry;
    if (retry) {
      const delaySeconds = Math.max(1, Math.ceil(retry.delayMs / 1_000));
      return { status: "pending", message: `retrying request · attempt ${retry.attempt} · ${delaySeconds}s` };
    }
    return { status: "pending", message: "session running" };
  }
  return undefined;
}

interface ClipboardRenderer {
  getSelection?: () => Selection | null;
  copyToClipboardOSC52?: (text: string) => boolean;
  on?: (event: "selection", handler: (selection: Selection) => void) => void;
  off?: (event: "selection", handler: (selection: Selection) => void) => void;
}

function clipboardCopySource(
  renderer: ClipboardRenderer,
  items: readonly ChatTranscriptItem[],
  view: ShellView,
  statusText: string,
): { text: string; label: string } | undefined {
  const selected = cleanClipboardText(renderer.getSelection?.()?.getSelectedText() ?? "");
  if (selected) return { text: selected, label: "selection" };

  if (view === "status" && statusText.trim()) {
    return { text: statusText.trimEnd(), label: "status" };
  }

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
      .map((part) => publicSyntheticAssistantText(part.text, part.synthetic))
      .filter(Boolean)
      .join("\n\n");
    if (text.trim()) return text;
  }
  return undefined;
}

function chatShellExitInfo(runtime: ChatRuntimeState, cwd: string | undefined): ChatShellExitInfo | undefined {
  const sessionId = runtime.activeSessionId ?? runtime.chatView.sessionId;
  if (!sessionId && !cwd) return undefined;
  const info: ChatShellExitInfo = {};
  if (sessionId) info.sessionId = sessionId;
  if (cwd) info.cwd = cwd;
  return info;
}

function useSkillSummaries(cwd: string): SkillSummariesState {
  const [state, setState] = useState<{ skills: readonly SkillSummary[]; allSkills: readonly SkillSummary[] }>({
    skills: [],
    allSkills: [],
  });
  const loadEpochRef = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    const [activeRegistry, allRegistry] = await Promise.all([
      discoverSkills({ cwd }),
      discoverSkills({ cwd, includeDisabled: true }),
    ]);
    if (loadEpochRef.current !== epoch) return;
    setState({
      skills: activeRegistry.listAll(),
      allSkills: allRegistry.listAll(),
    });
  }, [cwd]);

  useEffect(() => {
    const epoch = ++loadEpochRef.current;
    let cancelled = false;
    void Promise.all([
      discoverSkills({ cwd }),
      discoverSkills({ cwd, includeDisabled: true }),
    ])
      .then(([activeRegistry, allRegistry]) => {
        if (cancelled || loadEpochRef.current !== epoch) return;
        setState({
          skills: activeRegistry.listAll(),
          allSkills: allRegistry.listAll(),
        });
      })
      .catch(() => {
        if (!cancelled && loadEpochRef.current === epoch) setState({ skills: [], allSkills: [] });
      });
    return () => {
      cancelled = true;
      if (loadEpochRef.current === epoch) loadEpochRef.current += 1;
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

function interruptedPromptCandidate(
  promptParts: readonly PromptPart[],
  pastedTextByMarker: ReadonlyMap<string, string>,
  pastedImages: Readonly<Record<number, PastedPromptImage>>,
  skillMentionBindings: readonly RuntimeSkillMention[],
  items: readonly ChatTranscriptItem[],
): InterruptedPromptCandidate {
  return {
    promptParts: promptParts.map((part) => ({ ...part })),
    pastedTextByMarker: [...pastedTextByMarker.entries()],
    pastedImages: Object.fromEntries(
      Object.entries(pastedImages).map(([id, image]) => [id, { ...image }]),
    ),
    skillMentionBindings: skillMentionBindings.map((binding) => ({ ...binding })),
    baselineOutput: visibleOutputFingerprints(items),
    sawActiveStatus: false,
  };
}

function trackInterruptedPromptCandidate(
  candidateRef: { current: InterruptedPromptCandidate | undefined },
  candidate: InterruptedPromptCandidate,
  state: "pending" | "accepted" | "rejected",
): boolean {
  if (state === "rejected") {
    if (candidateRef.current === candidate) candidateRef.current = undefined;
  } else if (!candidate.interruptOutcome) {
    candidateRef.current = candidate;
  }
  return state !== "accepted" || candidate.interruptOutcome !== "restored";
}

function hasVisibleOutputSince(
  candidate: InterruptedPromptCandidate,
  items: readonly ChatTranscriptItem[],
): boolean {
  for (const [key, fingerprint] of visibleOutputFingerprints(items)) {
    if (candidate.baselineOutput.get(key) !== fingerprint) return true;
  }
  return false;
}

function visibleOutputFingerprints(items: readonly ChatTranscriptItem[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const item of items) {
    const fingerprint = visibleOutputFingerprint(item);
    if (fingerprint) output.set(`${item.kind}:${item.id}`, fingerprint);
  }
  return output;
}

function visibleOutputFingerprint(item: ChatTranscriptItem): string | undefined {
  if (item.kind === "tool" || item.kind === "approval") return item.id;
  if (item.role === "user") return undefined;
  const visibleParts = item.parts.flatMap((part) => {
    if (part.type === "reasoning") return [];
    if (part.type === "text") return part.text.trim() ? [`text:${part.id}:${part.text}`] : [];
    if (part.type === "tool_result") {
      const visible = part.output.trim() || part.error?.trim() || (part.content?.length ?? 0) > 0;
      return visible ? [`tool_result:${part.id}:${part.output}:${part.error ?? ""}:${part.content?.length ?? 0}`] : [];
    }
    return [`${part.type}:${part.id}`];
  });
  return visibleParts.length > 0 ? visibleParts.join("\0") : undefined;
}

function isInterruptInFlight(status: ChatSessionView["status"]): boolean {
  return status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

function localItem(level: "info" | "error", text: string, persistent?: boolean | undefined, bare?: boolean | undefined): LocalTranscriptItem {
  const createdAt = Date.now();
  return {
    id: `${createdAt}:${level}:${text}`,
    kind: "local",
    level,
    text,
    createdAt,
    ...(persistent ? { persistent } : {}),
    ...(bare ? { bare } : {}),
  };
}

function clearLocalItemTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isDelete(key: KeyEvent): boolean {
  return key.name === "delete" || key.name === "del" || key.sequence === "\x1b[3~";
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

function isArrowUp(key: KeyEvent): boolean {
  return key.name === "up" || key.name === "arrow_up";
}

function isArrowDown(key: KeyEvent): boolean {
  return key.name === "down" || key.name === "arrow_down";
}

function isArrowLeft(key: KeyEvent): boolean {
  return key.name === "left" || key.name === "arrow_left";
}

function isArrowRight(key: KeyEvent): boolean {
  return key.name === "right" || key.name === "arrow_right";
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
