import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { HttpRuntimeClient, TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { TeamId } from "@chili/protocol";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import {
  teamLiveModel,
  useTeamLiveRuntime,
  type TeamLiveTuiOptions,
} from "./useTeamLiveRuntime.js";
import type { TeamLiveSurfaceRuntime } from "./components/types.js";
import { findAction, shorten } from "./components/helpers.js";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./slash/registry.js";
import type { SlashCommand, SlashCommandContext, SlashCommandResult, SlashCompletion } from "./slash/types.js";

type ShellView = "chat" | "team" | "help" | "agents" | "status";

type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "local"; level: "info" | "error"; text: string };

export interface ChatShellOptions extends TeamLiveTuiOptions {
  modelName?: string;
  providerName?: string;
  modeName?: string;
}

const PROMPT_PLACEHOLDER = 'Ask anything... "fix failing tests"';

export function ChatShellApp(props: {
  client: HttpRuntimeClient;
  options: ChatShellOptions;
  onExit: () => void;
}) {
  const runtime = useTeamLiveRuntime({ client: props.client, options: props.options });
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
  runtime: TeamLiveSurfaceRuntime;
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
  const [prompt, setPrompt] = useState("");
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const slashContext = useMemo<SlashCommandContext>(() => ({
    model: props.model,
    ...(props.options?.cwd ? { cwd: props.options.cwd } : {}),
  }), [props.model, props.options?.cwd]);
  const completions = prompt.startsWith("/")
    ? slashCompletions(commands, slashContext, prompt)
    : [];
  const paletteItems = slashCompletions(commands, slashContext, "/", 10);

  useKeyboard((key) => {
    if (key.eventType !== "press") return;
    if (key.ctrl && key.name === "c") {
      props.onExit?.();
      return;
    }
    if (key.ctrl && key.name === "p") {
      setPaletteOpen(true);
      setPaletteIndex(0);
      return;
    }
    if (view === "team") {
      if (isEscape(key)) setView("chat");
      return;
    }
    if (paletteOpen) {
      handlePaletteKey(key, paletteItems, paletteIndex, setPaletteIndex, (completion) => {
        setPaletteOpen(false);
        void runSlashInput(completion.value, commands, slashContext, props.model, props.runtime, setView, setTranscript, setPrompt);
      }, () => setPaletteOpen(false));
      return;
    }
    if (isEscape(key)) {
      if (view !== "chat") setView("chat");
      return;
    }
    if (isEnter(key)) {
      void submitPrompt(prompt, commands, slashContext, props.model, props.runtime, setView, setTranscript, setPrompt);
      return;
    }
    if (isBackspace(key)) {
      setPrompt((current) => current.slice(0, -1));
      return;
    }
    if (isTab(key) && completions[0]) {
      setPrompt(`${completions[0].value} `);
      return;
    }
    const printable = printableKey(key);
    if (printable) setPrompt((current) => `${current}${printable}`);
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
  const home = transcript.length === 0 && view === "chat";

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#050505">
      {home ? (
        <HomeScreen
          width={dimensions.width}
          prompt={prompt}
          completions={completions}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
        />
      ) : (
        <SessionScreen
          width={dimensions.width}
          view={view}
          prompt={prompt}
          transcript={transcript}
          completions={completions}
          paletteOpen={paletteOpen}
          paletteItems={paletteItems}
          paletteIndex={paletteIndex}
          model={props.model}
          options={shellOptions}
          runtime={props.runtime}
          commands={commands}
        />
      )}
    </box>
  );
}

function HomeScreen(props: {
  width: number;
  prompt: string;
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: TeamLiveSurfaceRuntime;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
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
          completions={props.completions}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          runtime={props.runtime}
        />
        <text fg="#7d8590" wrapMode="none" truncate>{`${props.options.modeName} | ${props.options.modelName} | ${props.options.providerName}`}</text>
      </box>
      <box flexGrow={3} />
      <TeamStatusRow model={props.model} />
      <Footer options={props.options} />
    </box>
  );
}

function SessionScreen(props: {
  width: number;
  view: Exclude<ShellView, "team">;
  prompt: string;
  transcript: readonly TranscriptItem[];
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  model: TeamLiveView;
  runtime: TeamLiveSurfaceRuntime;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
  commands: readonly SlashCommand[];
}) {
  const promptWidth = Math.min(96, Math.max(42, props.width - 8));
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexGrow={1} flexDirection="column" paddingX={3} paddingY={1}>
        {props.view === "help" ? (
          <HelpView commands={props.commands} />
        ) : props.view === "status" ? (
          <StatusView model={props.model} runtime={props.runtime} options={props.options} />
        ) : props.view === "agents" ? (
          <AgentsView model={props.model} />
        ) : (
          <TranscriptTimeline items={props.transcript} />
        )}
      </box>
      <TeamStatusRow model={props.model} />
      <box width="100%" alignItems="center" flexDirection="column">
        <PromptComposer
          width={promptWidth}
          prompt={props.prompt}
          completions={props.completions}
          paletteOpen={props.paletteOpen}
          paletteItems={props.paletteItems}
          paletteIndex={props.paletteIndex}
          runtime={props.runtime}
        />
      </box>
      <Footer options={props.options} />
    </box>
  );
}

function PromptComposer(props: {
  width: number;
  prompt: string;
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  runtime: TeamLiveSurfaceRuntime;
}) {
  const display = props.prompt.length > 0 ? props.prompt : PROMPT_PLACEHOLDER;
  const promptColor = props.prompt.length > 0 ? "#f8f8f2" : "#6e7681";
  return (
    <box width={props.width} flexDirection="column">
      {props.paletteOpen ? (
        <CommandList title="Command Palette" items={props.paletteItems} selectedIndex={props.paletteIndex} />
      ) : props.completions.length > 0 ? (
        <CommandList title="Commands" items={props.completions} selectedIndex={0} />
      ) : null}
      {props.runtime.actionFeedback ? (
        <text fg={feedbackColor(props.runtime.actionFeedback.status)} wrapMode="none" truncate>
          {`${props.runtime.actionFeedback.status}: ${props.runtime.actionFeedback.message}`}
        </text>
      ) : null}
      <box width="100%" height={3} border borderStyle="single" borderColor="#30363d" paddingX={1} flexDirection="column">
        <text fg={promptColor} wrapMode="none" truncate>{`> ${display}${props.prompt.length > 0 ? " |" : ""}`}</text>
      </box>
    </box>
  );
}

function CommandList(props: {
  title: string;
  items: readonly SlashCompletion[];
  selectedIndex: number;
}) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor="#30363d" paddingX={1}>
      <text fg="#f8f8f2" wrapMode="none" truncate>{props.title}</text>
      {props.items.length === 0 ? (
        <text fg="#6e7681" wrapMode="none" truncate>{"  no commands"}</text>
      ) : (
        props.items.slice(0, 8).map((item, index) => (
          <text key={item.value} fg={index === props.selectedIndex ? "#f8f8f2" : "#8f9baa"} wrapMode="none" truncate>
            {`${index === props.selectedIndex ? ">" : " "} ${item.label} - ${item.description}`}
          </text>
        ))
      )}
    </box>
  );
}

function TranscriptTimeline(props: { items: readonly TranscriptItem[] }) {
  return (
    <box width="100%" height="100%" flexDirection="column">
      {props.items.slice(-14).map((item) => (
        <box key={item.id} width="100%" flexDirection="column" marginBottom={1}>
          <text fg={item.kind === "user" ? "#f8f8f2" : item.kind === "assistant" ? "#a3be8c" : item.level === "error" ? "#ff7b72" : "#8f9baa"} wrapMode="none" truncate>
            {item.kind === "user" ? "You" : item.kind === "assistant" ? "Chili" : item.level}
          </text>
          <text fg="#d8dee9" wrapMode="word">{shorten(item.text, 180)}</text>
        </box>
      ))}
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
  runtime: TeamLiveSurfaceRuntime;
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
}) {
  const selected = props.model.selected;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg="#f8f8f2" wrapMode="none" truncate>{"Status"}</text>
      <box height={1} />
      <text fg="#d8dee9" wrapMode="none" truncate>{`connection: ${props.model.connection.status}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`mode: ${props.options.modeName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`model: ${props.options.modelName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`provider: ${props.options.providerName}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`cwd: ${props.options.cwd}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`team: ${selected?.team.name ?? selected?.team.id ?? "none"}`}</text>
      <text fg="#d8dee9" wrapMode="none" truncate>{`stream: ${props.runtime.message}`}</text>
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

function TeamStatusRow(props: { model: TeamLiveView }) {
  const selected = props.model.selected;
  const counts = selected?.health.counts;
  const line = selected
    ? `Team: ${selected.team.taskCount} tasks | ${counts?.runningTasks ?? 0} running | ${counts?.pendingApprovals ?? 0} approval | /team`
    : "Team: idle | /team";
  return (
    <box width="100%" paddingX={2}>
      <text fg="#7d8590" wrapMode="none" truncate>{line}</text>
    </box>
  );
}

function Footer(props: { options: { modeName: string; modelName: string; providerName: string; cwd: string } }) {
  return (
    <box width="100%" height={1} flexDirection="row" paddingX={2}>
      <text fg="#6e7681" wrapMode="none" truncate>{shorten(props.options.cwd, 54)}</text>
      <box flexGrow={1} />
      <text fg="#6e7681" wrapMode="none" truncate>{`${props.options.modeName} | ${props.options.modelName} | ${props.options.providerName} | / commands | tab agents | ctrl+p commands`}</text>
    </box>
  );
}

async function submitPrompt(
  prompt: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: TeamLiveSurfaceRuntime,
  setView: (view: ShellView) => void,
  setTranscript: (update: (current: TranscriptItem[]) => TranscriptItem[]) => void,
  setPrompt: (value: string) => void,
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  setPrompt("");
  if (trimmed.startsWith("/")) {
    await runSlashInput(trimmed, commands, ctx, model, runtime, setView, setTranscript, setPrompt);
    return;
  }
  const id = String(Date.now());
  setTranscript((current) => [
    ...current,
    { id: `${id}:user`, kind: "user", text: trimmed },
    { id: `${id}:assistant`, kind: "assistant", text: "Ready to send once runtime prompt submit is wired." },
  ]);
}

async function runSlashInput(
  input: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  model: TeamLiveView,
  runtime: TeamLiveSurfaceRuntime,
  setView: (view: ShellView) => void,
  setTranscript: (update: (current: TranscriptItem[]) => TranscriptItem[]) => void,
  setPrompt: (value: string) => void,
): Promise<void> {
  const match = resolveSlashCommand(commands, input);
  if (!match) {
    setTranscript((current) => [...current, localItem("error", `Unknown command: ${input}`)]);
    return;
  }
  const result = await match.command.run(ctx, match.args);
  applySlashResult(result, model, runtime, setView, setTranscript, setPrompt);
}

function applySlashResult(
  result: SlashCommandResult,
  model: TeamLiveView,
  runtime: TeamLiveSurfaceRuntime,
  setView: (view: ShellView) => void,
  setTranscript: (update: (current: TranscriptItem[]) => TranscriptItem[]) => void,
  setPrompt: (value: string) => void,
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
    setTranscript(() => []);
    return;
  }
  if (result.type === "insert_prompt") {
    setPrompt(result.text);
    return;
  }
  if (result.type === "local_message") {
    setTranscript((current) => [...current, localItem(result.level, result.text)]);
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

function localItem(level: "info" | "error", text: string): TranscriptItem {
  return { id: `${Date.now()}:${level}:${text}`, kind: "local", level, text };
}

function feedbackColor(status: string): string {
  if (status === "success") return "#a3be8c";
  if (status === "error") return "#ff7b72";
  if (status === "pending") return "#ffd166";
  return "#8f9baa";
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

