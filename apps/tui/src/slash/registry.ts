import type { SlashCommand, SlashCommandContext, SlashCompletion } from "./types.js";

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
