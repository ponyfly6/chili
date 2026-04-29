import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, MouseEvent } from "@opentui/core";
import type { HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { ApprovalId, TeamId } from "@chili/protocol";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import { teamLiveModel, type TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";
import { useChatRuntime, type ChatRuntimeState } from "./useChatRuntime.js";
import { findAction } from "./components/helpers.js";
import { ApprovalDock } from "./chat/ApprovalDock.js";
import { CommandList } from "./chat/CommandList.js";
import { MessageList } from "./chat/MessageList.js";
import { PROMPT_PLACEHOLDER, PromptComposer } from "./chat/PromptComposer.js";
import { StatusFooter, TeamStatusRow } from "./chat/StatusFooter.js";
import type { LocalTranscriptItem, PromptPart } from "./chat/types.js";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./slash/registry.js";
import type { SlashCommand, SlashCommandContext, SlashCommandResult, SlashCompletion } from "./slash/types.js";

type ShellView = "chat" | "team" | "help" | "agents" | "status";

export interface ChatShellOptions extends TeamLiveTuiOptions {
  modelName?: string;
  providerName?: string;
  modeName?: string;
}

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
}) {
  const dimensions = useTerminalDimensions();
  const commands = useMemo(() => props.commands ?? createDefaultSlashCommands(), [props.commands]);
  const [view, setView] = useState<ShellView>("chat");
  const [promptParts, setPromptParts] = useState<PromptPart[]>([{ type: "text", text: "" }]);
  const [localItems, setLocalItems] = useState<LocalTranscriptItem[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);
  const prompt = promptText(promptParts);
  const slashContext = useMemo<SlashCommandContext>(() => ({
    model: props.model,
    ...(props.options?.cwd ? { cwd: props.options.cwd } : {}),
  }), [props.model, props.options?.cwd]);
  const completions = prompt.startsWith("/")
    ? slashCompletions(commands, slashContext, prompt)
    : [];
  const paletteItems = slashCompletions(commands, slashContext, "/", 10);
  const firstApproval = props.runtime.chatView.pendingApprovals[0];
  const setPrompt = useMemo(() => setPromptText(setPromptParts), []);

  useKeyboard((key) => {
    if (key.eventType !== "press") return;
    if (key.ctrl && key.name === "c") {
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
    if (view === "chat" && key.ctrl && key.name === "y") {
      setMessageScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && key.ctrl && key.name === "v") {
      setMessageScrollOffset((current) => Math.max(0, current - scrollStep(dimensions.height)));
      return;
    }
    if (view === "team") {
      if (isEscape(key)) setView("chat");
      return;
    }
    if (paletteOpen) {
      handlePaletteKey(key, paletteItems, paletteIndex, setPaletteIndex, (completion) => {
        setPaletteOpen(false);
        void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt);
      }, () => setPaletteOpen(false));
      return;
    }
    if (isEscape(key)) {
      if (view !== "chat") setView("chat");
      return;
    }
    if (view === "chat" && (isPageUp(key) || (key.shift && isArrowUp(key)))) {
      setMessageScrollOffset((current) => current + scrollStep(dimensions.height));
      return;
    }
    if (view === "chat" && (isPageDown(key) || (key.shift && isArrowDown(key)))) {
      setMessageScrollOffset((current) => Math.max(0, current - scrollStep(dimensions.height)));
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
    if (isTab(key) && completions[0]) {
      setPrompt(`${completions[0].value} `);
      return;
    }
  });

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

  const shellOptions = {
    modeName: props.options?.modeName ?? "Build",
    modelName: props.options?.modelName ?? "auto",
    providerName: props.options?.providerName ?? "runtime",
    cwd: props.options?.cwd ?? process.cwd(),
  };
  const home = props.runtime.chatView.items.length === 0
    && localItems.length === 0
    && props.runtime.chatView.pendingApprovals.length === 0
    && view === "chat";
  const disabledReason = prompt.startsWith("/")
    ? undefined
    : props.runtime.chatView.pendingApprovals.length > 0
      ? "Resolve approval to continue"
      : props.runtime.chatView.status === "running"
        ? "Session running - ctrl+x interrupt"
        : !props.runtime.canSubmit
          ? "Waiting for runtime"
          : undefined;

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#050505">
      {home ? (
        <HomeScreen
          width={dimensions.width}
          prompt={prompt}
          focused={view === "chat" && !paletteOpen && !disabledReason}
          onPromptChange={setPrompt}
          onSubmit={() => void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt)}
          completions={completions}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          disabledReason={disabledReason}
        />
      ) : (
        <SessionScreen
          width={dimensions.width}
          height={dimensions.height}
          view={view}
          prompt={prompt}
          focused={view === "chat" && !paletteOpen && !disabledReason}
          onPromptChange={setPrompt}
          onSubmit={() => {
            setMessageScrollOffset(0);
            void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, setView, setLocalItems, setPrompt);
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
          localItems={localItems}
          messageScrollOffset={messageScrollOffset}
          completions={completions}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          commands={commands}
          disabledReason={disabledReason}
        />
      )}
    </box>
  );
}

function HomeScreen(props: {
  width: number;
  prompt: string;
  focused: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
  disabledReason?: string | undefined;
}) {
  const promptWidth = Math.min(76, Math.max(42, props.width - 12));
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexGrow={2} />
      <box width="100%" flexDirection="column" alignItems="center">
        <text fg="#f8f8f2" wrapMode="none" truncate>{"Chili"}</text>
        <text fg="#8f9baa" wrapMode="none" truncate>{"coding agent"}</text>
        <box height={1} />
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onSubmit={props.onSubmit}
          completions={props.completions}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={currentFeedback(props.runtime)}
        />
        <text fg="#7d8590" wrapMode="none" truncate>{`${props.options.modeName} | ${props.options.modelName} | ${props.options.providerName}`}</text>
      </box>
      <box flexGrow={3} />
      <TeamStatusRow model={props.model} />
      <StatusFooter options={props.options} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} />
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
  localItems: readonly LocalTranscriptItem[];
  messageScrollOffset: number;
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
  commands: readonly SlashCommand[];
  disabledReason?: string | undefined;
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      onMouseScroll={(event) => {
        if (props.view === "chat") props.onMessageScroll(event);
      }}
    >
      <box flexGrow={1} flexDirection="column" paddingX={3} paddingY={1}>
        {props.view === "help" ? (
          <HelpView commands={props.commands} />
        ) : props.view === "status" ? (
          <StatusView model={props.model} runtime={props.runtime} options={props.options} />
        ) : props.view === "agents" ? (
          <AgentsView model={props.model} />
        ) : (
          <MessageList
            chatView={props.runtime.chatView}
            localItems={props.localItems}
            width={Math.max(24, props.width - 8)}
            visibleLimit={Math.max(4, props.height - 14)}
            scrollOffset={props.messageScrollOffset}
          />
        )}
      </box>
      <ApprovalDock
        approvals={props.runtime.chatView.pendingApprovals}
        onApprove={(approvalId: ApprovalId) => void props.runtime.approveApproval(approvalId)}
        onReject={(approvalId: ApprovalId) => void props.runtime.rejectApproval(approvalId)}
      />
      <TeamStatusRow model={props.model} />
      <box width="100%" alignItems="center" flexDirection="column">
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          disabled={Boolean(props.disabledReason)}
          disabledReason={props.disabledReason}
          focused={props.focused}
          onPromptChange={props.onPromptChange}
          onSubmit={props.onSubmit}
          completions={props.completions}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          feedback={currentFeedback(props.runtime)}
        />
      </box>
      <StatusFooter options={props.options} chatView={props.runtime.chatView} canSubmit={props.runtime.canSubmit} />
    </box>
  );
}

function HelpView(props: { commands: readonly SlashCommand[] }) {
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg="#f8f8f2" wrapMode="none" truncate>{"Commands"}</text>
      <box height={1} />
      {props.commands.filter((command) => !command.hidden).map((command) => (
        <text key={command.name} fg="#d8dee9" wrapMode="none" truncate>
          {`/${command.name.padEnd(12)} ${command.description}`}
        </text>
      ))}
      <box height={1} />
      <text fg="#7d8590" wrapMode="none" truncate>{"Esc closes views. Ctrl+P opens commands. Tab accepts the first slash completion."}</text>
    </box>
  );
}

function StatusView(props: {
  model: TeamLiveView;
  runtime: ChatRuntimeState;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
}) {
  const selected = props.model.selected;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg="#f8f8f2" wrapMode="none" truncate>{"Status"}</text>
      <box height={1} />
      <text fg="#d8dee9" wrapMode="none" truncate>{`connection: ${props.model.connection.status}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`session: ${props.runtime.activeSessionId ?? "none"}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`thread: ${props.runtime.activeThreadId ?? "none"}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`mode: ${props.options.modeName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`model: ${props.options.modelName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`provider: ${props.options.providerName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`cwd: ${props.options.cwd}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`team: ${selected?.team.name ?? selected?.team.id ?? "none"}`}</text>
    </box>
  );
}

function AgentsView(props: { model: TeamLiveView }) {
  const members = props.model.selected?.members ?? [];
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg="#f8f8f2" wrapMode="none" truncate>{"Agents"}</text>
      <box height={1} />
      {members.length === 0 ? (
        <text fg="#7d8590" wrapMode="none" truncate>{"No active agents yet."}</text>
      ) : (
        members.slice(0, 10).map((member) => (
          <text key={member.id} fg="#d8dee9" wrapMode="none" truncate>
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
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    setPrompt("");
    await runSlashInput(trimmed, commands, ctx, model, runtime, setView, setLocalItems, setPrompt);
    return;
  }
  if (!runtime.canSubmit) {
    setLocalItems((current) => [...current, localItem("error", "Session is not ready for another prompt.")]);
    return;
  }
  const accepted = await runtime.submitPrompt(trimmed);
  if (accepted) setPrompt("");
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
): Promise<void> {
  const match = resolveSlashCommand(commands, input);
  if (!match) {
    setLocalItems((current) => [...current, localItem("error", `Unknown command: ${input}`)]);
    return;
  }
  const result = await match.command.run(ctx, match.args);
  applySlashResult(result, model, runtime, setView, setLocalItems, setPrompt);
}

function applySlashResult(
  result: SlashCommandResult,
  model: TeamLiveView,
  runtime: ChatRuntimeState,
  setView: (view: ShellView) => void,
  setLocalItems: (update: (current: LocalTranscriptItem[]) => LocalTranscriptItem[]) => void,
  setPrompt: (value: string | ((current: string) => string)) => void,
): void {
  if (result.type === "open_view") {
    setView(result.view);
    return;
  }
  if (result.type === "close_view") {
    setView("chat");
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

function isArrowUp(key: KeyEvent): boolean {
  return key.name === "up" || key.name === "arrow_up";
}

function isArrowDown(key: KeyEvent): boolean {
  return key.name === "down" || key.name === "arrow_down";
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
