import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, MouseEvent, PasteEvent, Selection } from "@opentui/core";
import type { ChatTranscriptItem, HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { ApprovalId, TeamId } from "@chili/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanClipboardText, promptClipboardText, promptPasteBytes, systemClipboard, type ClipboardAccess } from "./clipboard.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import { teamLiveModel, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import { useChatRuntime, type ChatRuntimeState } from "./useChatRuntime.js";
import { findAction } from "./components/helpers.js";
import { ApprovalDock, approvalDockHeight } from "./chat/ApprovalDock.js";
import { BrandMark } from "./chat/BrandMark.js";
import { MessageList } from "./chat/MessageList.js";
import { PROMPT_INPUT_HEIGHT, PROMPT_PLACEHOLDER, PromptComposer, promptComposerHeight } from "./chat/PromptComposer.js";
import { StatusFooter, statusFooterHeight, type StatusFooterOptions } from "./chat/StatusFooter.js";
import { buildTranscriptText } from "./chat/transcript.js";
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

export interface ChatShellOptions extends TeamLiveTuiOptions {
  modelName?: string;
  providerName?: string;
  modeName?: string;
  gitBranch?: string;
  themeId?: string;
  systemTheme?: TuiTheme;
}

const execFileAsync = promisify(execFile);
const PROMPT_MENU_MAX_ITEMS = 5;

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
}) {
  const dimensions = useTerminalDimensions();
  const { keyHandler } = useAppContext();
  const renderer = useRenderer() as ClipboardRenderer;
  const commands = useMemo(() => props.commands ?? createDefaultSlashCommands(), [props.commands]);
  const [view, setView] = useState<ShellView>("chat");
  const [promptParts, setPromptParts] = useState<PromptPart[]>([{ type: "text", text: "" }]);
  const [localItems, setLocalItems] = useState<LocalTranscriptItem[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [acceptedCompletionPrompt, setAcceptedCompletionPrompt] = useState<string | undefined>(undefined);
  const acceptedCompletionPromptRef = useRef<string | undefined>(undefined);
  const [themeId, setThemeId] = useState(() => initialTuiThemeId(props.options?.themeId));
  const [themePicker, setThemePicker] = useState<ThemePickerNavigation | undefined>(undefined);
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const prompt = promptText(promptParts);
  const history = usePromptHistory();
  const systemTheme = props.options?.systemTheme;
  const theme = resolveTuiTheme(themeId, undefined, { systemTheme });
  const themeOptions = selectableTuiThemeOptions;
  const systemThemeAvailable = Boolean(systemTheme);
  const slashContext = useMemo<SlashCommandContext>(() => ({
    model: props.model,
    ...(props.options?.cwd ? { cwd: props.options.cwd } : {}),
  }), [props.model, props.options?.cwd]);
  const completionSuppressed = acceptedCompletionPrompt !== undefined && prompt === acceptedCompletionPrompt;
  const completions = prompt.startsWith("/") && !completionSuppressed
    ? slashCompletions(commands, slashContext, prompt)
    : [];
  const slashCompletionOpen = prompt.startsWith("/") && completions.length > 0;
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
  const setPromptFromHistory = useCallback((value: string) => {
    updateAcceptedCompletionPrompt(undefined);
    historyPromptValueRef.current = value;
    setPrompt(value);
  }, [setPrompt, updateAcceptedCompletionPrompt]);
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
  const bottomAnchor = useMemo(() => {
    const lastItem = props.runtime.chatView.items.at(-1);
    const lastStatus = lastItem?.kind === "tool"
      ? lastItem.displayStatus
      : lastItem?.kind === "approval"
        ? `${lastItem.status}:${lastItem.decision ?? ""}`
        : "";
    return `${props.runtime.chatView.items.length}:${lastItem?.kind ?? ""}:${lastItem?.id ?? ""}:${lastStatus}:${props.runtime.chatView.pendingApprovals.length}`;
  }, [props.runtime.chatView.items, props.runtime.chatView.pendingApprovals.length]);

  useEffect(() => {
    setMessageScrollOffset(0);
  }, [bottomAnchor]);

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

  const disabledReason = prompt.startsWith("/")
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
        setLocalItems((current) => [...current, localItem("error", "Nothing to copy yet.")]);
        return;
      }
      void copyClipboardText(source.text, clipboard, renderer).then((copied) => {
        setLocalItems((current) => [
          ...current,
          localItem(copied ? "info" : "error", copied ? `Copied ${source.label}.` : "Clipboard copy is unavailable."),
        ]);
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
          setLocalItems((current) => [...current, localItem("error", "Clipboard paste is unavailable.")]);
          return;
        }
        const text = promptClipboardText(raw);
        if (!text) {
          setLocalItems((current) => [...current, localItem("error", "Clipboard is empty.")]);
          return;
        }
        appendPromptText(text);
      }).catch(() => {
        setLocalItems((current) => [...current, localItem("error", "Clipboard paste is unavailable.")]);
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
        void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt, openThemePicker);
      }, () => setPaletteOpen(false));
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
    if (slashCompletionOpen && !key.shift && (isArrowUp(key) || isArrowDown(key))) {
      const delta = isArrowUp(key) ? -1 : 1;
      setCompletionIndex((current) => clampIndex(current + delta, completions.length));
      return;
    }
    if (slashCompletionOpen && isTab(key)) {
      const completion = completions[selectedCompletionIndex] ?? completions[0];
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
    if (view === "chat" && !promptDisabled && isPlainArrowUp(key) && !slashCompletionOpen) {
      const previous = history.previous(prompt);
      if (previous !== undefined) setPromptFromHistory(previous);
      return;
    }
    if (view === "chat" && !promptDisabled && isPlainArrowDown(key) && !slashCompletionOpen) {
      const next = history.next(prompt);
      if (next !== undefined) setPromptFromHistory(next);
      return;
    }
    if (!prompt && firstApproval && key.name === "a") {
      void props.runtime.approveApproval(firstApproval.id);
      return;
    }
    if (!prompt && firstApproval && key.name === "x") {
      void props.runtime.rejectApproval(firstApproval.id);
      return;
    }
  });

  const cwd = props.options?.cwd ?? process.cwd();
  const gitBranch = useGitBranch(cwd, props.options?.gitBranch);
  const shellOptions: StatusFooterOptions = {
    modeName: props.options?.modeName ?? "Build",
    modelName: props.options?.modelName ?? "auto",
    providerName: props.options?.providerName ?? "runtime",
    cwd,
    ...(gitBranch ? { gitBranch } : {}),
  };

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
          onSubmit={() => void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt, openThemePicker, history.record)}
          completions={completions}
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
            setMessageScrollOffset(0);
            void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt, openThemePicker, history.record);
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
          completionIndex={selectedCompletionIndex}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          showToolDetails={showToolDetails}
          transcriptActive={view === "transcript"}
          commands={commands}
          disabledReason={disabledReason}
          theme={theme}
          themePicker={themePicker ? {
            items: themeOptions,
            selectedIndex: themePicker.index,
            systemThemeAvailable,
          } : undefined}
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
}) {
  const promptWidth = Math.min(76, Math.max(42, props.width - 12));
  const compactBrand = props.width < 92 || props.height < 32;
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    approvalHeight: 0,
    themePickerHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completions.length > 0,
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
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onSubmit={props.onSubmit}
          completions={props.completions}
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
  completionIndex: number;
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: StatusFooterOptions;
  showToolDetails: boolean;
  transcriptActive: boolean;
  commands: readonly SlashCommand[];
  disabledReason?: string | undefined;
  theme: TuiTheme;
  themePicker?: ThemePickerModel | undefined;
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  const messageWidth = Math.max(24, props.width - 8);
  const approvalHeight = approvalDockHeight(props.runtime.chatView.pendingApprovals, messageWidth, props.theme);
  const feedback = currentFeedback(props.runtime);
  const footerHeight = statusFooterHeight(props.width);
  const themePickerHeight = props.themePicker ? pickerHeight(props.themePicker.items.length) : 0;
  const maxCommandItems = promptMenuItemLimit({
    height: props.height,
    footerHeight,
    approvalHeight,
    themePickerHeight,
    feedback: Boolean(feedback),
    menuOpen: props.paletteOpen || props.completions.length > 0,
  });
  const promptHeight = promptComposerHeight({
    completions: props.completions,
    paletteOpen: props.paletteOpen,
    paletteItems: props.paletteItems,
    feedback,
    maxCommandItems,
  });
  const messagePaneHeight = Math.max(1, props.height - approvalHeight - themePickerHeight - promptHeight - footerHeight);
  const transcriptChrome = props.height < 16 ? 6 : 3;
  const visibleLimit = Math.max(1, props.height - approvalHeight - themePickerHeight - promptHeight - footerHeight - transcriptChrome);
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
          <StatusView model={props.model} runtime={props.runtime} options={props.options} theme={props.theme} showToolDetails={props.showToolDetails} transcriptActive={props.transcriptActive} />
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
          />
        )}
      </box>
      <ApprovalDock
        approvals={props.runtime.chatView.pendingApprovals}
        width={messageWidth}
        onApprove={(approvalId: ApprovalId) => void props.runtime.approveApproval(approvalId)}
        onReject={(approvalId: ApprovalId) => void props.runtime.rejectApproval(approvalId)}
        theme={props.theme}
      />
      <box width="100%" alignItems="center" flexDirection="column">
        {props.themePicker ? <ThemePicker model={props.themePicker} theme={props.theme} /> : null}
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onSubmit={props.onSubmit}
          completions={props.completions}
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

interface ThemePickerNavigation {
  previousThemeId: string;
  index: number;
}

interface ThemePickerModel {
  items: readonly TuiThemeOption[];
  selectedIndex: number;
  systemThemeAvailable: boolean;
}

function pickerHeight(itemCount: number): number {
  return itemCount + 3;
}

function promptMenuItemLimit(input: {
  height: number;
  footerHeight: number;
  approvalHeight: number;
  themePickerHeight: number;
  feedback: boolean;
  menuOpen: boolean;
}): number {
  if (!input.menuOpen) return PROMPT_MENU_MAX_ITEMS;
  const reserved = input.footerHeight
    + input.approvalHeight
    + input.themePickerHeight
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
  transcriptActive: boolean;
}) {
  const selected = props.model.selected;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Status"}</text>
      <box height={1} />
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`connection: ${props.model.connection.status}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`session: ${props.runtime.activeSessionId ?? "none"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`thread: ${props.runtime.activeThreadId ?? "none"}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`mode: ${props.options.modeName}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`model: ${props.options.modelName}`}</text>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`provider: ${props.options.providerName}`}</text>
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
  setView: (view: ShellView) => void,
  setLocalItems: (update: (current: LocalTranscriptItem[]) => LocalTranscriptItem[]) => void,
  setPrompt: (value: string | ((current: string) => string)) => void,
  openThemePicker: () => void,
  onAccepted?: (text: string) => void,
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    setPrompt("");
    await runSlashInput(trimmed, commands, ctx, model, runtime, setView, setLocalItems, setPrompt, openThemePicker);
    return;
  }
  if (!runtime.canSubmit) {
    setLocalItems((current) => [...current, localItem("error", runtime.submitBlockedReason ?? "Session is not ready for another prompt.")]);
    return;
  }
  const accepted = await runtime.submitPrompt(trimmed);
  if (accepted) {
    onAccepted?.(trimmed);
    setPrompt("");
  }
}

async function runSlashInput(
  input: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  setView: (view: ShellView) => void,
  setLocalItems: (update: (current: LocalTranscriptItem[]) => LocalTranscriptItem[]) => void,
  setPrompt: (value: string | ((current: string) => string)) => void,
  openThemePicker: () => void,
): Promise<void> {
  const match = resolveSlashCommand(commands, input);
  if (!match) {
    setLocalItems((current) => [...current, localItem("error", `Unknown command: ${input}`)]);
    return;
  }
  const result = await match.command.run(ctx, match.args);
  applySlashResult(result, model, runtime, setView, setLocalItems, setPrompt, openThemePicker);
}

function applySlashResult(
  result: SlashCommandResult,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  setView: (view: ShellView) => void,
  setLocalItems: (update: (current: LocalTranscriptItem[]) => LocalTranscriptItem[]) => void,
  setPrompt: (value: string | ((current: string) => string)) => void,
  openThemePicker: () => void,
): void {
  if (result.type === "open_view") {
    setView(result.view);
    return;
  }
  if (result.type === "close_view") {
    setView("chat");
    return;
  }
  if (result.type === "open_theme_picker") {
    openThemePicker();
    return;
  }
  if (result.type === "clear_transcript") {
    setLocalItems(() => []);
    return;
  }
  if (result.type === "insert_prompt") {
    setPrompt(result.text);
    return;
  }
  if (result.type === "local_message") {
    setLocalItems((current) => [...current, localItem(result.level, result.text)]);
    return;
  }
  const action = actionForSlashResult(result, model);
  if (action) runtime.executeAction(action);
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
