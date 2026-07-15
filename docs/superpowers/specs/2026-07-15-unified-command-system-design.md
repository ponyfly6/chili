# Unified Command System Design

## Summary

Chili will replace its independent CLI, TUI, and runtime slash-command implementations with one shared command system. This is a breaking redesign. Existing command names, aliases, completion behavior, and runtime descriptor shapes are not compatibility constraints.

The new system must make commands predictable to discover, complete, execute, and extend. It must not retain legacy adapters or hidden compatibility branches after migration.

## Goals

- Make `@chili/commands` the single command kernel used by the CLI, TUI, and server.
- Define one tree-shaped command language with one parser, resolver, completion engine, conflict policy, and availability model.
- Replace the TUI's static slash list and non-searchable `Ctrl+P` menu with a coherent keyboard-first command experience.
- Remove duplicate command vocabulary and aliases instead of preserving them.
- Carry complete command metadata through the runtime protocol.
- Make execution behavior explicit: complete, descend, open a picker, execute, or reject with a reason.
- Preserve ordinary prompts that begin with absolute paths without allowing misspelled commands to fall through to the model.

## Non-goals

- Compatibility with existing slash-command names or aliases.
- Compatibility with the old flat runtime command descriptor.
- A migration shim for custom command invocations.
- A second command registry owned by an application surface.
- Mouse-first interaction or a graphical command editor.

## Command Language

The built-in vocabulary becomes:

```text
/help
/status
/theme
/permissions

/model
/model select <provider/model>
/model service <standard|fast>

/thinking
/thinking effort <off|minimal|low|medium|high|xhigh>
/thinking traces <show|hide>

/session
/session new
/session list
/session resume [session]
/session rename [title]
/session compact [focus]
/session revert <snapshot-id>

/goal
/goal show
/goal set [--budget <tokens>] <objective>
/goal pause
/goal resume
/goal clear

/team
/team agents
/team mailbox
/team tasks
/team task <task-id>
/team recover
/team run
/team merge

/memory
/memory show [--user|--project|--all]
/memory add [--user|--project] <text>
/memory reload [--user|--project|--all]

/auth
/auth status
/auth login
/auth logout

/skills
/skills browse
/skills enable [--user|--project] <name>
/skills disable [--user|--project] <name>
/skills reload

/mcp
/mcp status [server]
/mcp tools <server>
/mcp reload
/mcp add <name> --url <url> [options]
/mcp remove <server>
/mcp auth <server> [options]
/mcp logout <server>

/commands
/commands reload
/commands diagnostics

/app exit

/prompt builtin init [focus]
/prompt project <name> [arguments]
/prompt user <name> [arguments]
/prompt mcp <server> <name> [arguments]
```

Parent commands open their primary browser or picker when executed directly. Tab or Right Arrow descends into their children. The old `/clear`, `/new`, `/sessions`, `/resume`, `/rename`, `/compact`, `/revert`, `/agents`, `/mailbox`, `/tasks`, `/task`, `/recover-tasks`, `/commands`-as-help behavior, `/approvals`, `/login`, `/logout`, `/hide-thinking`, `/show-thinking`, `/reasoning`, `/fast`, `/exit`, `/quit`, and root-level custom prompt commands are removed. The surviving capabilities are available only at the canonical paths listed above.

Reusable prompts are deliberately isolated under `/prompt`. Project, user, builtin, and MCP prompts therefore cannot collide with built-in control commands or with each other.

## Shared Architecture

### Protocol descriptor

`@chili/protocol` owns the serializable wire shape because it is the lowest-level workspace package. A `RuntimeCommandNode` contains:

- stable `id`;
- single-token `name` and full canonical `path`;
- `title`, `description`, `group`, and `source`;
- `argumentMode` and `argumentHint`;
- `selectionMode`: `execute`, `complete`, or `drilldown`;
- `concurrency`: `allow` or `deny`;
- `hidden`, `enabled`, and optional `disabledReason`;
- `executionTarget`: `client`, `runtime`, or `prompt`;
- recursive `children`.

Aliases are not part of the new type.

### Command kernel

`@chili/commands` imports the protocol descriptor and adds executable bindings:

```ts
interface CommandDefinition<TContext, TResult> extends RuntimeCommandNode {
  available?: (context: TContext) => CommandAvailability;
  complete?: (context: TContext, input: CommandCompletionInput) => readonly CommandSuggestion[];
  run?: (context: TContext, input: CommandRunInput) => TResult | Promise<TResult>;
  children: readonly CommandDefinition<TContext, TResult>[];
}
```

The package owns:

- `CommandRegistry`, including recursive registration and deterministic conflict diagnostics;
- `parseCommandInput` and absolute-path discrimination;
- `resolveCommand` with exact tree traversal;
- `completeCommands` with command-level and argument-level completion;
- `commandMenuModel` for presentation-neutral grouping, ranking, disabled state, and selection intent;
- descriptor serialization and runtime-tree import;
- the canonical built-in command catalog.

Matching order is exact name, token prefix, word prefix, then fuzzy fallback only when no strong match exists. Empty queries preserve catalog order within semantic groups. Results never silently disappear because of a collision.

### Execution adapters

The catalog contains metadata and stable command IDs. Each surface supplies bindings for those IDs:

- the TUI maps IDs to `SlashCommandResult`-style local actions;
- the CLI maps IDs to REPL operations and output;
- the server maps `/prompt` leaves to prompt expansion and runtime actions.

The action-result union may remain surface-specific. Parsing, discovery, completion, availability, and command identity may not.

### Runtime composition

The server publishes a complete `/prompt` subtree through the runtime API. The TUI imports that tree through `@chili/commands`, attaches one runtime proxy binding to its executable leaves, and registers it alongside the shared built-in catalog. The old `RuntimePromptCommandDescriptor` list and TUI custom-command adapter are deleted.

## Conflict Policy

- Built-in control paths are reserved.
- Reusable prompts are separated by source under `/prompt`, so source collisions are structurally impossible.
- Duplicate paths inside the same source are rejected, not overwritten.
- Registry diagnostics include both command IDs and origins.
- A registry with rejected commands remains usable, but `/commands diagnostics` exposes every rejection and command loading reports it immediately.

## TUI Interaction

### Slash completion

Typing `/` opens a composer-aligned command menu. It shows contextual groups rather than raw registration order. Each row includes the canonical segment, concise description, source or current value, and disabled state. The menu footer shows active keys and the current result window.

- Up/Down moves selection consistently and wraps.
- Tab or Right Arrow completes the selected segment and keeps the menu open at the next command level.
- Enter executes an enabled complete command. For a command that still requires arguments, Enter completes the path and keeps the menu open.
- Escape dismisses the menu without changing the draft.
- Backspace naturally moves back through the typed command path.

Argument completion uses the same menu for models, reasoning effort, skills, MCP servers, sessions, and prompt names. Dedicated pickers remain appropriate when a parent command is executed without arguments.

### Command palette

`Ctrl+P` opens a separate global command palette with its own query buffer. It preserves the composer draft. Printable input, Backspace, and Delete edit the palette query; Up/Down selects; Tab or Right Arrow descends; Enter runs; Escape closes.

The palette searches command names, descriptions, groups, sources, and current values. It uses the shared menu model but not the composer text.

### Help and diagnostics

`/help` opens the same command browser in browse mode. It is searchable and scrollable. `/commands diagnostics` shows loading errors and conflicts. The old fixed-height list is removed.

### Busy and destructive states

Availability is evaluated before both display and execution. Commands with `concurrency: deny` remain visible but disabled while a session is running, with a reason. Execution rechecks availability to prevent stale-menu races.

Destructive actions such as starting a new session, clearing a goal, removing an MCP server, and logging out require an explicit confirmation result from the surface adapter.

## CLI Interaction

The REPL deletes its manual `if (line === "/...")` dispatch chain. It builds the same catalog and calls the shared resolver. Help output is generated from the command tree. Unsupported surface commands remain visible only when the CLI adapter supplies an implementation; there is no application-specific parallel registry.

CLI input that begins with a slash and names no command is an error unless the first token is recognized as an absolute path. It is never submitted to the model as a probable typo.

## Custom Prompt Loading

Markdown command files continue to provide prompt content, but invocation paths are derived from source and file path under `/prompt`. Legacy root-level names and frontmatter aliases are removed.

The supported frontmatter is limited to behavior that affects prompt execution: description, argument hint, model, allowed tools, write scope, execute scope, subtask, and hidden state. Category is derived from the command source and is no longer configurable.

## Error Handling

- Unknown command: show the unknown canonical token and the strongest suggestions.
- Incomplete command: keep the menu open or print the available children in non-interactive contexts.
- Missing arguments: return structured usage information from the resolver before calling a binding.
- Disabled command: show `disabledReason`; never call the binding.
- Ambiguous dynamic argument: show candidates instead of choosing by registration order.
- Runtime tree failure: retain built-in commands and surface a persistent command diagnostic.

## Testing

Tests proceed from the shared kernel outward:

1. `@chili/commands` unit tests cover tree registration, conflicts, parsing, path discrimination, strong/fuzzy ranking, child traversal, argument completion, availability, and run-input preservation.
2. Protocol and server tests cover recursive descriptor serialization, `/prompt` namespacing, reload diagnostics, and runtime execution.
3. CLI tests cover registry-based REPL dispatch and generated help.
4. TUI unit tests cover menu models and adapter bindings.
5. OpenTUI keyboard tests cover slash descent, searchable palette input, draft preservation, selection behavior, disabled commands, narrow frames, help browsing, and absolute paths.
6. Repository gates run `bun test`, `bun run typecheck`, `bun run smoke:all`, `bun run smoke:p3-team-model`, and `bun run smoke:p3-team-parallel`.

## Deletion Plan

The migration is complete only when these legacy structures are gone:

- `apps/tui/src/slash/types.ts`;
- `apps/tui/src/slash/registry.ts`;
- `apps/tui/src/slash/custom.ts`;
- the CLI REPL slash-command conditional chain;
- `RuntimePromptCommandDescriptor` and the flat `RuntimePromptCommandList.commands` contract;
- alias support in the command registry and custom command loader;
- tests asserting legacy names or legacy Tab suppression.

No compatibility wrappers remain after the final task.
