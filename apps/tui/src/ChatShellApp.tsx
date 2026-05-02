import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useAppContext, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, MouseEvent, PasteEvent, Selection } from "@opentui/core";
import type { ChatSessionView, ChatTranscriptItem, HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { ApprovalId, RuntimeSkillMention, TeamId } from "@chili/protocol";
import { FileAuthStorage, loginOpenAICodex, OPENAI_CODEX_PROVIDER_ID } from "@chili/providers";
import { discoverSkills, updateSkillDisabledSetting, type SkillSettingsScope, type SkillSummary } from "@chili/skills";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanClipboardText, promptClipboardText, promptPasteBytes, systemClipboard, type ClipboardAccess } from "./clipboard.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import { teamLiveModel, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import { useChatRuntime, type ChatApprovalGrantScope, type ChatRuntimeState } from "./useChatRuntime.js";
import { findAction } from "./components/helpers.js";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  defaultOpenAICodexSelection,
  filterModelCandidates,
  isValidModelSelection,
  type ModelCandidate,
  modelDescriptorSelection,
  modelSelectionLabel,
  modelSupportsReasoning,
  sameModelSelection,
  type ModelSelection,
  type ReasoningLevel,
} from "./model-state.js";
import { ApprovalDock, approvalDockHeight } from "./chat/ApprovalDock.js";
import { BrandMark } from "./chat/BrandMark.js";
import { charDisplayWidth } from "./chat/markdown.js";
import { MessageList } from "./chat/MessageList.js";
import { buildChatDisplayItems, type ChatDisplayItem, type ToolActivityDisplay } from "./chat/presentation.js";
import { PROMPT_INPUT_HEIGHT, PROMPT_PLACEHOLDER, PromptComposer, promptComposerHeight } from "./chat/PromptComposer.js";
import { StatusFooter, statusFooterHeight, type StatusFooterOptions } from "./chat/StatusFooter.js";
import { buildTranscriptLines, buildTranscriptText } from "./chat/transcript.js";
import { TranscriptView } from "./chat/TranscriptView.js";
import type { LocalTranscriptItem, PromptPart } from "./chat/types.js";
import { usePromptHistory } from "./chat/usePromptHistory.js";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./slash/registry.js";
import type { SlashCommand, SlashCommandContext, SlashCommandResult, SlashCompletion } from "./slash/types.js";
import {
  DEFAULT_TUI_THEME_ID,
  initialTuiThemeId,
  resolveTuiTheme,
  selectableTuiThemeOptions,
  SYSTEM_TUI_THEME_ID,
  type TuiTheme,
  type TuiThemeOption,
} from "./theme/index.js";

type ShellView = "chat" | "team" | "help" | "agents" | "status" | "transcript";
type AppendLocalItem = (level: "info" | "error", text: string) => void;

interface SlashActions {
  cwd: string;
  setView: (view: ShellView) => void;
  appendLocalItem: AppendLocalItem;
  startNewChatSession: () => Promise<void>;
  setPrompt: (value: string | ((current: string) => string)) => void;
  openThemePicker: () => void;
  setAuthManualPrompt: (value: AuthManualPrompt | undefined) => void;
  openModelPicker: (query?: string) => void;
  setModelSelection: (selection: ModelSelection, reasoningLevel?: ReasoningLevel) => Promise<void>;
  openReasoningPicker: () => void;
  setReasoningLevel: (level: ReasoningLevel) => Promise<void>;
  setHideThinking: (hidden: boolean) => void;
  ensureOpenAICodexDefaultModel: () => Promise<void>;
  reloadSkills: () => Promise<void>;
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
}

interface AuthManualPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

const execFileAsync = promisify(execFile);
const PROMPT_MENU_MAX_ITEMS = 6;
const LOCAL_ITEM_TTL_MS = 4_000;

export function ChatShellApp(props: {
  client: HttpRuntimeClient;
  options: ChatShellOptions;
  onExit: () => void;
}) {
  const runtime = useChatRuntime({ client: props.client, options: props.options });
  const allTeams = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    sessionId: props.options.sessionId,
    limit: 48,
  });
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | undefined>(props.options.teamId ?? allTeams.selectedTeamId);
  const resolvedSelectedTeamId = props.options.teamId ?? validSelectedTeamId(allTeams, selectedTeamId);
  const model = teamLiveModel(runtime.runtimeView, {
    connection: runtime.connection,
    selectedTeamId: resolvedSelectedTeamId,
    sessionId: props.options.sessionId,
    limit: 64,
  });
  const skillSummaries = useSkillSummaries(props.options.cwd ?? process.cwd());

  useEffect(() => {
    if (props.options.teamId) {
      setSelectedTeamId(props.options.teamId);
      return;
    }
    if (!selectedTeamId || !allTeams.teams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(allTeams.selectedTeamId ?? allTeams.teams[0]?.id);
    }
  }, [allTeams.selectedTeamId, allTeams.teams, props.options.teamId, selectedTeamId]);

  return (
    <ChatShellSurface
      model={model}
      runtime={runtime}
      options={props.options}
      selectedTeamId={resolvedSelectedTeamId}
      selectedTeamLocked={Boolean(props.options.teamId)}
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
  onExit?: () => void;
  commands?: readonly SlashCommand[];
  clipboard?: ClipboardAccess | undefined;
  localMessageTtlMs?: number | undefined;
  skills?: readonly SkillSummary[] | undefined;
  allSkills?: readonly SkillSummary[] | undefined;
  onSkillsChanged?: (() => Promise<void> | void) | undefined;
}) {
  const dimensions = useTerminalDimensions();
  const { keyHandler } = useAppContext();
  const renderer = useRenderer() as ClipboardRenderer;
  const commands = useMemo(() => props.commands ?? createDefaultSlashCommands(), [props.commands]);
  const [view, setView] = useState<ShellView>("chat");
  const [promptParts, setPromptParts] = useState<PromptPart[]>([{ type: "text", text: "" }]);
  const [skillMentionBindings, setSkillMentionBindings] = useState<RuntimeSkillMention[]>([]);
  const [localItems, setLocalItems] = useState<LocalTranscriptItem[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [acceptedCompletionPrompt, setAcceptedCompletionPrompt] = useState<string | undefined>(undefined);
  const acceptedCompletionPromptRef = useRef<string | undefined>(undefined);
  const [themeId, setThemeId] = useState(() => initialTuiThemeId(props.options?.themeId));
  const [themePicker, setThemePicker] = useState<ThemePickerNavigation | undefined>(undefined);
  const modelCandidates = useMemo(
    () => (props.runtime.modelCandidates ?? []).filter((candidate) => candidate.available !== false),
    [props.runtime.modelCandidates],
  );
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | undefined>(undefined);
  const [reasoningLevel, setReasoningLevelState] = useState<ReasoningLevel | undefined>(undefined);
  const [modelPicker, setModelPicker] = useState<ModelPickerNavigation | undefined>(undefined);
  const [reasoningPicker, setReasoningPicker] = useState<ReasoningPickerNavigation | undefined>(undefined);
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [authManualPrompt, setAuthManualPromptState] = useState<AuthManualPrompt | undefined>(undefined);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [hideThinking, setHideThinkingState] = useState(false);
  const localMessageTtlMs = props.localMessageTtlMs ?? LOCAL_ITEM_TTL_MS;
  const localItemTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissLocalItem = useCallback((id: string) => {
    const timer = localItemTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    localItemTimersRef.current.delete(id);
    setLocalItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const appendLocalItem = useCallback<AppendLocalItem>((level, text) => {
    const item = localItem(level, text);
    setLocalItems((current) => [...current, item]);
    if (localMessageTtlMs <= 0) return;
    const timer = setTimeout(() => dismissLocalItem(item.id), localMessageTtlMs);
    localItemTimersRef.current.set(item.id, timer);
  }, [dismissLocalItem, localMessageTtlMs]);
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
  }, [
    props.runtime.modelConfig?.modelSelection?.provider,
    props.runtime.modelConfig?.modelSelection?.model,
    props.runtime.modelConfig?.reasoningLevel,
    props.runtime.modelConfig,
  ]);
  const scrollEstimateWidth = Math.max(24, dimensions.width - 8);
  const chatLineCount = useMemo(() => estimatedChatLineCount(props.runtime.chatView, localItems, showToolDetails, scrollEstimateWidth), [localItems, props.runtime.chatView, scrollEstimateWidth, showToolDetails]);
  const transcriptLineCount = useMemo(() => estimatedTranscriptLineCount(props.runtime.chatView.items, localItems, scrollEstimateWidth), [localItems, props.runtime.chatView.items, scrollEstimateWidth]);
  const previousChatLineCount = useRef<number | undefined>(undefined);
  const previousTranscriptLineCount = useRef<number | undefined>(undefined);
  const prompt = promptText(promptParts);
  const history = usePromptHistory();
  const authManualPromptRef = useRef<AuthManualPrompt | undefined>(undefined);
  const systemTheme = props.options?.systemTheme;
  const theme = resolveTuiTheme(themeId, undefined, { systemTheme });
  const themeOptions = selectableTuiThemeOptions;
  const systemThemeAvailable = Boolean(systemTheme);
  const cwd = props.options?.cwd ?? process.cwd();
  const slashContext = useMemo<SlashCommandContext>(() => ({
    model: props.model,
    cwd,
    ...(modelSelection ? { modelSelection } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    modelCandidates,
    skills: props.skills ?? [],
    allSkills: props.allSkills ?? props.skills ?? [],
  }), [cwd, modelCandidates, modelSelection, props.allSkills, props.model, props.skills, reasoningLevel]);
  const completionSuppressed = acceptedCompletionPrompt !== undefined && prompt === acceptedCompletionPrompt;
  const skillTrigger = activeSkillMentionTrigger(prompt);
  const skillCompletionItems = skillTrigger && !prompt.startsWith("/")
    ? skillCompletions(props.skills ?? [], skillTrigger.query)
    : [];
  const skillCompletionOpen = Boolean(skillTrigger && !prompt.startsWith("/"));
  const slashCompletionItems = prompt.startsWith("/") && !completionSuppressed
    ? slashCompletions(commands, slashContext, prompt)
    : [];
  const completions = skillCompletionOpen ? skillCompletionItems : slashCompletionItems;
  const resolvedSlashPrompt = prompt.startsWith("/") ? resolveSlashCommand(commands, prompt) : undefined;
  const slashInputActive = prompt.startsWith("/") && (prompt.trim() === "/" || completions.length > 0 || resolvedSlashPrompt !== undefined);
  const slashCompletionOpen = prompt.startsWith("/") && slashCompletionItems.length > 0;
  const selectedCompletionIndex = clampIndex(completionIndex, completions.length);
  const paletteItems = slashCompletions(commands, slashContext, "/", 10);
  const firstApproval = props.runtime.chatView.pendingApprovals[0];
  const setPrompt = useMemo(() => setPromptText(setPromptParts), []);
  const historyPromptValueRef = useRef<string | undefined>(undefined);
  const updateAcceptedCompletionPrompt = useCallback((value: string | undefined) => {
    acceptedCompletionPromptRef.current = value;
    setAcceptedCompletionPrompt(value);
  }, []);
  const appendPromptText = useCallback((value: string) => {
    updateAcceptedCompletionPrompt(undefined);
    historyPromptValueRef.current = undefined;
    history.resetNavigation();
    setPrompt((current) => `${current}${value}`);
  }, [history, setPrompt, updateAcceptedCompletionPrompt]);
  const handlePromptChange = useCallback((value: string) => {
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
  const setPromptFromHistory = useCallback((value: string) => {
    updateAcceptedCompletionPrompt(undefined);
    historyPromptValueRef.current = value;
    setPrompt(value);
  }, [setPrompt, updateAcceptedCompletionPrompt]);
  const setAuthManualPrompt = useCallback((value: AuthManualPrompt | undefined) => {
    authManualPromptRef.current = value;
    setAuthManualPromptState(value);
  }, []);
  const startNewChatSession = useCallback(async () => {
    setView("chat");
    setAuthManualPrompt(undefined);
    setPrompt("");
    history.clear();
    clearLocalItems();
    setMessageScrollOffset(0);
    setTranscriptScrollOffset(0);
    await props.runtime.startNewSession();
  }, [clearLocalItems, history, props.runtime, setAuthManualPrompt, setPrompt]);
  const submitAuthManualInput = useCallback(() => {
    const manual = authManualPromptRef.current;
    if (!manual) return false;
    const value = prompt.trim();
    if (!value) return true;
    manual.resolve(value);
    setAuthManualPrompt(undefined);
    setPrompt("");
    appendLocalItem("info", "Using pasted OpenAI authorization response...");
    return true;
  }, [appendLocalItem, prompt, setAuthManualPrompt, setPrompt]);
  const openThemePicker = useCallback(() => {
    const index = themeOptionIndex(themeOptions, themeId);
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
    setThemePicker(undefined);
    setModelPicker({ query, selectedIndex: index });
  }, [modelCandidates, modelSelection, props.runtime]);
  const closeModelPicker = useCallback(() => {
    setModelPicker(undefined);
  }, []);
  const openReasoningPicker = useCallback(() => {
    const selectedIndex = Math.max(0, REASONING_LEVELS.indexOf(reasoningLevel ?? DEFAULT_REASONING_LEVEL));
    setModelPicker(undefined);
    setThemePicker(undefined);
    setReasoningPicker({ selectedIndex });
  }, [reasoningLevel]);
  const closeReasoningPicker = useCallback(() => {
    setReasoningPicker(undefined);
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
    appendLocalItem("info", `Model: ${modelSelectionLabel(selection)}${reasoningText}`);
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
  const slashActions = useMemo<SlashActions>(() => ({
    cwd,
    setView,
    appendLocalItem,
    startNewChatSession,
    setPrompt,
    openThemePicker,
    setAuthManualPrompt,
    openModelPicker,
    setModelSelection,
    openReasoningPicker,
    setReasoningLevel,
    setHideThinking,
    ensureOpenAICodexDefaultModel,
    reloadSkills: async () => {
      await props.onSkillsChanged?.();
    },
  }), [appendLocalItem, cwd, ensureOpenAICodexDefaultModel, openModelPicker, openReasoningPicker, openThemePicker, props.onSkillsChanged, setAuthManualPrompt, setHideThinking, setModelSelection, setPrompt, setReasoningLevel, startNewChatSession]);
  const runSelectedSlashCompletion = useCallback(() => {
    if (!slashCompletionOpen) return false;
    const completion = slashCompletionItems[selectedCompletionIndex] ?? slashCompletionItems[0];
    if (!completion) return false;
    updateAcceptedCompletionPrompt(undefined);
    history.resetNavigation();
    setPrompt("");
    void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, slashActions);
    return true;
  }, [commands, history, props.model, props.runtime, selectedCompletionIndex, setPrompt, slashActions, slashCompletionItems, slashCompletionOpen, slashContext, updateAcceptedCompletionPrompt]);
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

  const selectorOpen = Boolean(modelPicker || reasoningPicker);
  const disabledReason = authManualPrompt
    ? undefined
    : modelPicker
    ? "Choose a model"
    : reasoningPicker
    ? "Choose thinking level"
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

  useEffect(() => {
    const previous = previousChatLineCount.current;
    previousChatLineCount.current = chatLineCount;
    if (previous === undefined) return;
    const delta = chatLineCount - previous;
    if (delta <= 0) return;
    setMessageScrollOffset((current) => current > 0 ? current + delta : current);
  }, [chatLineCount]);

  useEffect(() => {
    const previous = previousTranscriptLineCount.current;
    previousTranscriptLineCount.current = transcriptLineCount;
    if (previous === undefined) return;
    const delta = transcriptLineCount - previous;
    if (delta <= 0) return;
    setTranscriptScrollOffset((current) => current > 0 ? current + delta : current);
  }, [transcriptLineCount]);

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (view !== "chat" || promptDisabled) return;
      event.preventDefault();
      event.stopPropagation();
      const text = promptPasteBytes(event.bytes);
      if (text) appendPromptText(text);
    };
    keyHandler?.on("paste", handlePaste);
    return () => {
      keyHandler?.off("paste", handlePaste);
    };
  }, [appendPromptText, keyHandler, promptDisabled, view]);

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
    if (key.ctrl && key.name === "c" && !key.shift) {
      props.onExit?.();
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
    if (isPasteShortcut(key)) {
      key.preventDefault();
      key.stopPropagation();
      if (view !== "chat" || promptDisabled) return;
      void clipboard.readText().then((raw) => {
        if (raw === undefined) {
          appendLocalItem("error", "Clipboard paste is unavailable.");
          return;
        }
        const text = promptClipboardText(raw);
        if (!text) {
          appendLocalItem("error", "Clipboard is empty.");
          return;
        }
        appendPromptText(text);
      }).catch(() => {
        appendLocalItem("error", "Clipboard paste is unavailable.");
      });
      return;
    }
    if (view === "team") {
      if (isEscape(key)) setView("chat");
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
      setCompletionIndex((current) => clampIndex(current + delta, completions.length));
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
      if (view !== "chat") setView("chat");
      return;
    }
    if (view === "chat" && key.ctrl && key.name === "y") {
      setMessageScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "transcript" && key.ctrl && key.name === "y") {
      setTranscriptScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && (isPageUp(key) || (key.shift && isArrowUp(key)))) {
      setMessageScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "transcript" && (isPageUp(key) || (key.shift && isArrowUp(key)))) {
      setTranscriptScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && (isPageDown(key) || (key.shift && isArrowDown(key)))) {
      setMessageScrollOffset((current) => Math.max(0, current - scrollStep(dimensions.height)));
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
    if (view === "chat" && !prompt && firstApproval && isApproveAlwaysKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "persistent" });
      return;
    }
    if (view === "chat" && !prompt && firstApproval && isApproveSessionKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "session" });
      return;
    }
    if (view === "chat" && !prompt && firstApproval && isApproveOnceKey(key)) {
      void props.runtime.approveApproval(firstApproval.id, { scope: "once" });
      return;
    }
    if (view === "chat" && !prompt && firstApproval && isRejectApprovalKey(key)) {
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
    cwd,
    ...(gitBranch ? { gitBranch } : {}),
  };
  const modelPickerModel = modelPicker
    ? modelPickerView(modelPicker, modelCandidates, modelSelection)
    : undefined;
  const reasoningPickerModel = reasoningPicker
    ? reasoningPickerView(reasoningPicker, reasoningLevel ?? DEFAULT_REASONING_LEVEL)
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
          focused={view === "chat" && !paletteOpen && !themePicker && !disabledReason}
          onPromptChange={handlePromptChange}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedSlashCompletion()) return;
            void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, slashActions, history.record, skillMentionBindings, props.skills ?? []);
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
        />
      ) : (
        <SessionScreen
          width={dimensions.width}
          height={dimensions.height}
          view={view}
          prompt={prompt}
          focused={view === "chat" && !paletteOpen && !themePicker && !disabledReason}
          onPromptChange={handlePromptChange}
          onSubmit={() => {
            if (submitAuthManualInput()) return;
            if (runSelectedSkillCompletion()) return;
            if (runSelectedSlashCompletion()) return;
            setMessageScrollOffset(0);
            void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, slashActions, history.record, skillMentionBindings, props.skills ?? []);
          }}
          onMessageScroll={(event) => {
            const direction = event.scroll?.direction;
            if (direction !== "up" && direction !== "down") return;
            event.preventDefault();
            event.stopPropagation();
            const delta = Math.max(1, event.scroll?.delta ?? 1);
            const amount = Math.max(2, Math.ceil(delta * 3));
            if (direction === "up") {
              setMessageScrollOffset((current) => current + amount);
            } else {
              setMessageScrollOffset((current) => Math.max(0, current - amount));
            }
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
          localItems={localItems}
          messageScrollOffset={messageScrollOffset}
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
        />
      )}
    </box>
  );
}

function HomeScreen(props: {
  width: number;
  height: number;
  prompt: string;
  focused: boolean;
  onPromptChange: (value: string) => void;
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
}) {
  const promptWidth = Math.min(76, Math.max(42, props.width - 12));
  const compactBrand = props.width < 92 || props.height < 32;
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const selectorHeight = selectorPickerHeight(props.modelPicker, props.reasoningPicker);
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
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
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
  focused: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onMessageScroll: (event: MouseEvent) => void;
  onTranscriptScroll: (event: MouseEvent) => void;
  localItems: readonly LocalTranscriptItem[];
  messageScrollOffset: number;
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
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  const messageWidth = Math.max(24, props.width - 8);
  const approvalHeight = approvalDockHeight(props.runtime.chatView.pendingApprovals, messageWidth, props.theme);
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const selectorHeight = selectorPickerHeight(props.modelPicker, props.reasoningPicker);
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
  });
  const messagePaneHeight = Math.max(1, props.height - approvalHeight - themePickerHeight - selectorHeight - promptHeight - footerHeight);
  const transcriptChrome = props.height < 16 ? 6 : 3;
  const visibleLimit = Math.max(1, props.height - approvalHeight - themePickerHeight - selectorHeight - promptHeight - footerHeight - transcriptChrome);
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      onMouseScroll={(event) => {
        if (props.view === "chat") props.onMessageScroll(event);
        if (props.view === "transcript") props.onTranscriptScroll(event);
      }}
    >
      <box height={messagePaneHeight} flexDirection="column" paddingX={3} paddingY={1}>
        {props.view === "help" ? (
          <HelpView commands={props.commands} theme={props.theme} showToolDetails={props.showToolDetails} />
        ) : props.view === "status" ? (
          <StatusView model={props.model} runtime={props.runtime} options={props.options} theme={props.theme} showToolDetails={props.showToolDetails} hideThinking={props.hideThinking} transcriptActive={props.transcriptActive} />
        ) : props.view === "agents" ? (
          <AgentsView model={props.model} theme={props.theme} />
        ) : props.view === "transcript" ? (
          <TranscriptView
            chatView={props.runtime.chatView}
            localItems={props.localItems}
            width={messageWidth}
            visibleLimit={visibleLimit}
            scrollOffset={props.transcriptScrollOffset}
            theme={props.theme}
          />
        ) : (
          <MessageList
            chatView={props.runtime.chatView}
            localItems={props.localItems}
            width={messageWidth}
            visibleLimit={visibleLimit}
            scrollOffset={props.messageScrollOffset}
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
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
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

function estimatedChatLineCount(chatView: ChatSessionView, localItems: readonly LocalTranscriptItem[], showToolDetails: boolean, width: number): number {
  const displayItems = buildChatDisplayItems(chatView.items, {
    showToolDetails,
    sessionStatus: chatView.status,
    activeToolCount: chatView.activeTools.length,
  });
  const displayLineCount = displayItems.reduce((count, item) => count + estimatedDisplayItemLineCount(item, width), 0);
  const localLineCount = localItems.reduce((count, item) => count + roughTextLineCount(`${item.level}: ${item.text}`, width), 0);
  return displayLineCount + localLineCount;
}

function estimatedTranscriptLineCount(items: readonly ChatTranscriptItem[], localItems: readonly LocalTranscriptItem[], width: number): number {
  const transcriptLineCount = buildTranscriptLines(items).reduce((count, line) => count + roughTextLineCount(line.text, width), 0);
  const localLineCount = localItems.reduce((count, item) => count + roughTextLineCount(`${item.level}: ${item.text}`, width), 0);
  return transcriptLineCount + localLineCount;
}

function estimatedDisplayItemLineCount(item: ChatDisplayItem, width: number): number {
  if (item.kind === "user_text" || item.kind === "assistant_text" || item.kind === "summary") return roughTextLineCount(item.text, width);
  if (item.kind === "reasoning" || item.kind === "approval") return 1;
  if (item.kind === "tool_activity") return estimatedToolActivityLineCount(item.activity, width);
  return roughTextLineCount(item.label, width) + item.activities.reduce((count, activity) => {
    const detailLabel = activity.details.length > 0 ? 1 : 0;
    return count + detailLabel + estimatedToolActivityExtraLineCount(activity, width);
  }, 0);
}

function estimatedToolActivityLineCount(activity: ToolActivityDisplay, width: number): number {
  return roughTextLineCount(activity.label, width) + estimatedToolActivityExtraLineCount(activity, width);
}

function estimatedToolActivityExtraLineCount(activity: ToolActivityDisplay, width: number): number {
  let count = 0;
  if (activity.outputHint) count += roughTextLineCount(`  ${activity.outputHint}`, width);
  if (activity.compactErrorLines?.length) {
    count += roughTextLineCount("  error:", width);
    for (const line of activity.compactErrorLines) count += roughTextLineCount(`    ${line}`, width);
  }
  for (const detail of activity.details) {
    count += roughTextLineCount(`  ${detail.label}:`, width);
    for (const line of detail.lines) count += roughTextLineCount(`    ${line}`, width);
  }
  return count;
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

interface SkillMentionTrigger {
  start: number;
  query: string;
}

type SkillCompletion = SlashCompletion & { skill: SkillSummary };

function pickerHeight(itemCount: number): number {
  return itemCount + 3;
}

function selectorPickerHeight(modelPicker: ModelPickerModel | undefined, reasoningPicker: ReasoningPickerModel | undefined): number {
  if (modelPicker) return Math.min(modelPicker.items.length, 8) + 4;
  if (reasoningPicker) return reasoningPicker.items.length + 3;
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
        const suffix = item.current ? " *" : "";
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

function visiblePickerItems<T>(items: readonly T[], selectedIndex: number, maxVisible: number): Array<{ item: T; index: number }> {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)));
  return items.slice(start, start + maxVisible).map((item, offset) => ({ item, index: start + offset }));
}

function modelPickerDetail(model: ModelPickerModel): string {
  const selected = model.items[model.selectedIndex];
  if (!selected) return "  No matching models";
  const count = model.total > 1 ? ` (${model.selectedIndex + 1}/${model.total})` : "";
  const displayName = selected.displayName && selected.displayName !== selected.label ? ` ${selected.displayName}` : "";
  return `  ${modelSelectionLabel(selected.selection)}${displayName}${count}`;
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
    .sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath))
    .slice(0, 8)
    .map((skill) => ({
      value: `$${skill.name}`,
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
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Esc closes views. Ctrl+P opens commands. Ctrl+O toggles tool details (${detailsText}). Ctrl+T opens transcript. Ctrl+V pastes. Ctrl+Shift+C copies selection or latest reply.`}</text>
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
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
  onAccepted?: (text: string) => void,
  skillMentionBindings: readonly RuntimeSkillMention[] = [],
  skills: readonly SkillSummary[] = [],
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    const slashMatch = resolveSlashCommand(commands, trimmed);
    if (slashMatch) {
      actions.setPrompt("");
      await runResolvedSlashCommand(slashMatch, ctx, model, runtime, actions);
      return;
    }
    if (isSlashCommandCandidate(commands, ctx, trimmed)) {
      actions.appendLocalItem("error", `Unknown command: ${trimmed}`);
      return;
    }
  }
  if (!runtime.canSubmit) {
    actions.appendLocalItem("error", runtime.submitBlockedReason ?? "Session is not ready for another prompt.");
    return;
  }
  for (const warning of localSkillMentionWarnings(trimmed, skills, skillMentionBindings)) {
    actions.appendLocalItem("info", warning);
  }
  const accepted = await runtime.submitPrompt(trimmed, {
    ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
    ...(ctx.reasoningLevel ? { reasoningLevel: ctx.reasoningLevel } : {}),
    ...activeSkillMentionsOption(trimmed, skillMentionBindings),
  });
  if (accepted) {
    onAccepted?.(trimmed);
    actions.setPrompt("");
  }
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
  await applySlashResult(result, model, runtime, actions);
}

async function applySlashResult(
  result: SlashCommandResult,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  actions: SlashActions,
): Promise<void> {
  if (result.type === "open_view") {
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
  if (result.type === "new_session") {
    await actions.startNewChatSession();
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
  if (result.type === "sdk_action") {
    const action = actionForSlashResult(result, model);
    if (action) runtime.executeAction(action);
  }
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

function setPromptText(setPromptParts: (value: PromptPart[] | ((current: PromptPart[]) => PromptPart[])) => void) {
  return (value: string | ((current: string) => string)) => {
    setPromptParts((current) => {
      const currentText = promptText(current);
      const next = typeof value === "function" ? value(currentText) : value;
      return [{ type: "text", text: next }];
    });
  };
}

function promptText(parts: readonly PromptPart[]): string {
  return parts.map((part) => part.text).join("");
}

function localItem(level: "info" | "error", text: string): LocalTranscriptItem {
  return { id: `${Date.now()}:${level}:${text}`, kind: "local", level, text };
}

function clearLocalItemTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
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
