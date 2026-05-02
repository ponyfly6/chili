import type { SlashCommand, SlashCommandContext, SlashCompletion } from "./types.js";
import {
  REASONING_LEVELS,
  defaultModelCandidates,
  isReasoningLevel,
  modelDescriptorSelection,
  modelSelectionLabel,
  parseModelCommand,
  type ReasoningLevel,
} from "../model-state.js";

export function createDefaultSlashCommands(): SlashCommand[] {
  return [
    {
      name: "team",
      description: "Open the team cockpit",
      category: "team",
      run: () => ({ type: "open_view", view: "team" }),
    },
    {
      name: "team run",
      description: "Start the selected team loop",
      category: "team",
      isSafeConcurrent: false,
      run: () => ({ type: "sdk_action", action: "team_run" }),
    },
    {
      name: "team merge",
      description: "Merge pending team work",
      category: "team",
      isSafeConcurrent: false,
      run: () => ({ type: "sdk_action", action: "team_merge" }),
    },
    {
      name: "theme",
      description: "Switch theme",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_theme_picker" }),
    },
    {
      name: "clear",
      description: "Start a fresh chat session",
      category: "session",
      isSafeConcurrent: true,
      run: () => ({ type: "new_session" }),
    },
    {
      name: "new",
      description: "Start a fresh chat session",
      category: "session",
      isSafeConcurrent: true,
      run: () => ({ type: "new_session" }),
    },
    {
      name: "help",
      aliases: ["commands"],
      description: "Show commands and shortcuts",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "help" }),
    },
    {
      name: "status",
      description: "Show session and team status",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "status" }),
    },
    {
      name: "agents",
      description: "Show agent activity",
      category: "team",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "agents" }),
    },
    {
      name: "login",
      aliases: ["auth login"],
      description: "Login to ChatGPT Codex",
      category: "auth",
      isSafeConcurrent: false,
      run: () => ({ type: "auth_action", action: "login", provider: "openai-codex" }),
    },
    {
      name: "logout",
      aliases: ["auth logout"],
      description: "Remove ChatGPT Codex credentials",
      category: "auth",
      isSafeConcurrent: false,
      run: () => ({ type: "auth_action", action: "logout", provider: "openai-codex" }),
    },
    {
      name: "auth",
      description: "Show ChatGPT Codex auth status",
      category: "auth",
      isSafeConcurrent: true,
      run: () => ({ type: "auth_action", action: "status", provider: "openai-codex" }),
    },
    {
      name: "skills",
      description: "List skills",
      category: "skills",
      isSafeConcurrent: true,
      run: () => ({ type: "insert_prompt", text: "$" }),
    },
    {
      name: "model",
      description: "Select model",
      category: "model",
      argumentHint: "[provider/model]",
      isSafeConcurrent: true,
      complete: modelCompletions,
      run: (ctx, args) => {
        const match = parseModelCommand(args, modelCandidates(ctx));
        if (match.selection) {
          return {
            type: "set_model",
            selection: match.selection,
            ...(match.reasoningLevel ? { reasoningLevel: match.reasoningLevel } : {}),
          };
        }
        return {
          type: "open_model_picker",
          ...(match.query ? { query: match.query } : {}),
        };
      },
    },
    {
      name: "thinking",
      aliases: ["reasoning"],
      description: "Set reasoning level",
      category: "model",
      argumentHint: "<off|minimal|low|medium|high|xhigh>",
      isSafeConcurrent: true,
      complete: reasoningCompletions,
      run: (_ctx, args) => {
        const level = args.trim().toLowerCase();
        if (!level) return { type: "open_reasoning_picker" };
        if (isReasoningLevel(level)) return { type: "set_reasoning", level };
        return {
          type: "local_message",
          level: "error",
          text: `Unknown reasoning level: ${args.trim() || "none"}`,
        };
      },
    },
  ];
}

export function resolveSlashCommand(
  commands: readonly SlashCommand[],
  input: string,
): { command: SlashCommand; args: string } | undefined {
  const body = normalizeInput(input);
  if (!body) return undefined;
  const matches = commands
    .flatMap((command) => commandNames(command).map((name) => ({ command, name })))
    .filter(({ name }) => body === name || body.startsWith(`${name} `))
    .sort((left, right) => right.name.length - left.name.length);
  const match = matches[0];
  if (!match) return undefined;
  return {
    command: match.command,
    args: body.slice(match.name.length).trimStart(),
  };
}

export function slashCompletions(
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  input: string,
  limit = 8,
): SlashCompletion[] {
  const body = normalizeInput(input);
  const custom = commands.flatMap((command) => command.complete?.(ctx, body) ?? []);
  const registry = commands
    .filter((command) => !command.hidden)
    .filter((command) => commandNames(command).some((name) => matchesCommand(name, body)))
    .map((command) => ({
      value: `/${command.name}`,
      label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      description: command.description,
      category: command.category,
    }));

  return uniqueCompletions([...custom, ...registry]).slice(0, limit);
}

function normalizeInput(input: string): string {
  return input.replace(/^\//, "").trimStart().replace(/\s+/g, " ").toLowerCase();
}

function commandNames(command: SlashCommand): string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

function matchesCommand(name: string, input: string): boolean {
  if (!input) return true;
  if (name.startsWith(input)) return true;
  return fuzzyMatch(name, input);
}

function fuzzyMatch(value: string, query: string): boolean {
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function uniqueCompletions(completions: readonly SlashCompletion[]): SlashCompletion[] {
  const seen = new Set<string>();
  const output: SlashCompletion[] = [];
  for (const completion of completions) {
    if (seen.has(completion.value)) continue;
    seen.add(completion.value);
    output.push(completion);
  }
  return output;
}

function modelCompletions(ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const query = commandArgument(input, "model");
  if (query === undefined) return [];

  const candidates = modelCandidates(ctx);
  const normalized = query.trim().toLowerCase();
  const matches = candidates
    .filter((model) => !normalized || fuzzyMatch(`${model.provider} ${model.model} ${model.provider}/${model.model} ${model.displayName ?? ""}`.toLowerCase(), normalized))
    .slice(0, 8);
  return matches.flatMap((model) => {
    const selection = modelDescriptorSelection(model);
    const canonical = modelSelectionLabel(selection);
    const description = model.provider;
    return [
      {
        value: `/model ${canonical}`,
        label: canonical,
        description,
        category: "model" as const,
      },
      {
        value: `/model ${model.model}`,
        label: model.model,
        description: `${description} model id`,
        category: "model" as const,
      },
    ];
  });
}

function reasoningCompletions(_ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const thinkingQuery = commandArgument(input, "thinking");
  const reasoningQuery = commandArgument(input, "reasoning");
  const query = thinkingQuery ?? reasoningQuery;
  if (query === undefined) return [];
  const command = thinkingQuery !== undefined ? "thinking" : "reasoning";
  const normalized = query.trim().toLowerCase();
  return REASONING_LEVELS
    .filter((level) => !normalized || level.startsWith(normalized) || fuzzyMatch(level, normalized))
    .map((level) => ({
      value: `/${command} ${level}`,
      label: level,
      description: reasoningDescription(level),
      category: "model" as const,
    }));
}

function commandArgument(input: string, command: string): string | undefined {
  if (input === `${command} `) return "";
  if (input.startsWith(`${command} `)) return input.slice(command.length + 1);
  return undefined;
}

function modelCandidates(ctx: SlashCommandContext) {
  return ctx.modelCandidates ?? defaultModelCandidates();
}

function reasoningDescription(level: ReasoningLevel): string {
  switch (level) {
    case "off":
      return "No reasoning";
    case "minimal":
      return "Very brief reasoning";
    case "low":
      return "Light reasoning";
    case "medium":
      return "Moderate reasoning";
    case "high":
      return "Deep reasoning";
    case "xhigh":
      return "Maximum reasoning";
  }
}
