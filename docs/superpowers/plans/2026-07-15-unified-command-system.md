# Unified Command System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax so progress can be tracked precisely.

**Goal:** Replace Chili's incompatible TUI, CLI, and runtime slash-command implementations with one breaking, tree-shaped command system and a searchable keyboard-first TUI experience.

**Architecture:** `@chili/protocol` defines the recursive wire descriptor; `@chili/commands` owns command definitions, registration, parsing, resolution, ranking, completion, menu projection, runtime import, and the canonical built-in catalog. The server publishes reusable prompts as a `/prompt` subtree. TUI and CLI bind surface actions to shared command IDs and never own parallel parsers or registries.

**Tech Stack:** Bun, TypeScript ESM, React 19, OpenTUI, colocated Bun tests, project references.

## Global Constraints

- This is a breaking migration. Do not add aliases, compatibility adapters, legacy descriptor fields, or fallbacks to old paths.
- Follow red-green-refactor for every behavioral task: add or replace a focused test, run it and observe the expected failure, implement the smallest coherent slice, then rerun it.
- Keep protocol types serializable and dependency-free. `@chili/commands` may depend on `@chili/protocol`, never the reverse.
- Preserve unrelated user changes and do not rewrite unrelated TUI behavior.
- Use shared command IDs and shared resolution everywhere. Surface-specific action result unions are allowed; surface-specific command languages are not.
- Use canonical namespaces from the design spec, including `/session`, `/team`, `/memory`, `/prompt`, and `/app exit`.
- Remove legacy tests instead of weakening the new contract to satisfy them.

---

## Task 1: Introduce the recursive protocol and command kernel model

**Files:**

- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/commands/package.json`
- Modify: `packages/commands/tsconfig.json`
- Replace: `packages/commands/src/types.ts`
- Replace: `packages/commands/src/registry.ts`
- Replace: `packages/commands/src/registry.test.ts`
- Modify: `packages/commands/src/index.ts`

- [ ] **Step 1: Write failing registry and descriptor tests**

Cover recursive registration, stable IDs and canonical paths, duplicate sibling rejection, diagnostics that identify both origins, hidden filtering, availability, and descriptor serialization without executable functions or aliases.

Run: `bun test packages/commands/src/registry.test.ts`

Expected: FAIL because `RuntimeCommandNode`, recursive diagnostics, and serialization do not exist.

- [ ] **Step 2: Replace the flat protocol descriptor**

Add `RuntimeCommandNode`, `RuntimeCommandCatalog`, `RuntimeCommandDiagnostic`, and ID-based `RuntimeCommandInvocation`. Delete `RuntimePromptCommandDescriptor`, `RuntimePromptCommandList`, `RuntimePromptCommandSource`, and name-based invocation types.

- [ ] **Step 3: Replace command types and registry**

Define generic executable command nodes with `children`, `available`, `complete`, and `run`; normalize one token per node; derive canonical paths recursively; reject duplicates deterministically; retain diagnostics without making the usable tree disappear.

- [ ] **Step 4: Add protocol dependency and exports**

Add `@chili/protocol` to the workspace package and project reference, export new kernel types and helpers, and ensure there is no alias API.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test packages/commands/src/registry.test.ts && bun run --cwd packages/commands typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/runtime.ts packages/commands
git commit -m "feat(commands): add recursive command kernel"
```

## Task 2: Build exact resolution, completion, ranking, and menu projection

**Files:**

- Replace: `packages/commands/src/resolve.ts`
- Replace: `packages/commands/src/completion.ts`
- Add: `packages/commands/src/menu.ts`
- Replace: `packages/commands/src/registry.test.ts`
- Add: `packages/commands/src/menu.test.ts`
- Modify: `packages/commands/src/template.ts`
- Modify: `packages/commands/src/template.test.ts`
- Modify: `packages/commands/src/index.ts`

- [ ] **Step 1: Write failing parser and resolver tests**

Cover exact child traversal, incomplete parents, required arguments, preserved raw argument input, disabled commands, hidden commands, unknown command suggestions, absolute POSIX and Windows path discrimination, and the rule that probable slash typos are never prompts.

Run: `bun test packages/commands/src/registry.test.ts packages/commands/src/template.test.ts`

Expected: FAIL on the new result shapes and path rules.

- [ ] **Step 2: Implement the parser and resolver**

Return structured `matched`, `incomplete`, `unknown`, `disabled`, and `not_command` results. Recheck availability at resolution/execution boundaries. Resolve exact canonical segments only; do not execute a fuzzy match.

- [ ] **Step 3: Write failing completion and menu tests**

Cover exact-name rank, token prefix, word prefix, fuzzy fallback only without strong matches, contextual children, async argument completion, grouped catalog order for empty queries, disabled reasons, current values, execution intent, and stable selection values.

Run: `bun test packages/commands/src/menu.test.ts`

Expected: FAIL because the shared menu model does not exist.

- [ ] **Step 4: Implement completion and menu projection**

Build presentation-neutral suggestions and menu rows with `execute`, `complete`, and `drilldown` intent. Ensure `/mo` does not mix distant fuzzy matches into strong model results.

- [ ] **Step 5: Run focused package tests**

Run: `bun test packages/commands/src && bun run --cwd packages/commands typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/commands
git commit -m "feat(commands): unify resolution and completion"
```

## Task 3: Define the breaking canonical built-in catalog

**Files:**

- Replace: `packages/commands/src/builtin.ts`
- Replace: `packages/commands/src/builtin.test.ts`
- Add: `packages/commands/src/catalog.ts`
- Add: `packages/commands/src/catalog.test.ts`
- Modify: `packages/commands/src/index.ts`

- [ ] **Step 1: Write a failing catalog contract test**

Assert the exact canonical tree from the design spec, including session/team/memory CLI capabilities, prompt namespaces, execution target, argument mode, selection mode, and concurrency policy. Assert old roots and aliases are absent.

Run: `bun test packages/commands/src/builtin.test.ts packages/commands/src/catalog.test.ts`

Expected: FAIL because the old catalog only contains `/init`.

- [ ] **Step 2: Implement metadata-first catalog creation**

Define stable command IDs and command specs once. Add a binding function that attaches handlers by ID and omits commands a surface cannot support without creating a second vocabulary.

- [ ] **Step 3: Move builtin init under `/prompt builtin init`**

Keep its prompt behavior and execution metadata but remove root `/init` completely.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/commands/src/builtin.test.ts packages/commands/src/catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/commands
git commit -m "feat(commands): define canonical command catalog"
```

## Task 4: Namespace filesystem and MCP prompts under `/prompt`

**Files:**

- Replace: `packages/commands/src/project-loader.test.ts`
- Modify: `packages/commands/src/project-loader.ts`
- Replace: `packages/commands/src/mcp-prompts.test.ts`
- Modify: `packages/commands/src/mcp-prompts.ts`
- Modify: `packages/commands/src/template.test.ts`

- [ ] **Step 1: Write failing project and user prompt tests**

Assert nested files derive child nodes beneath `/prompt project` or `/prompt user`, source-local duplicates produce diagnostics, removed frontmatter fields such as category and aliases produce an unsupported-field diagnostic, and prompt expansion preserves arguments.

Run: `bun test packages/commands/src/project-loader.test.ts`

Expected: FAIL because files still load as root-level flat names.

- [ ] **Step 2: Implement namespaced filesystem loading**

Build source subtrees, derive group/source metadata, remove configurable category and alias handling, and return command-kernel diagnostics.

- [ ] **Step 3: Write failing MCP prompt tests**

Assert MCP prompts derive `/prompt mcp <server> <name>`, have stable IDs, validate required arguments, and preserve rendered prompt metadata.

Run: `bun test packages/commands/src/mcp-prompts.test.ts`

Expected: FAIL on the new path and descriptor shape.

- [ ] **Step 4: Implement MCP prompt nodes and rerun**

Run: `bun test packages/commands/src/project-loader.test.ts packages/commands/src/mcp-prompts.test.ts packages/commands/src/template.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/commands
git commit -m "feat(commands): namespace reusable prompts"
```

## Task 5: Publish and execute the recursive runtime command catalog

**Files:**

- Replace: `packages/server/src/commands.test.ts`
- Replace: `packages/server/src/commands.ts`
- Modify: `packages/server/src/runtime-http.test.ts`
- Modify: `packages/server/src/runtime-http.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/projection.test.ts`
- Modify: `apps/cli/src/mcp-control.test.ts`
- Modify: `apps/cli/src/mcp-control.ts`
- Modify: `apps/cli/src/harness.ts`

- [ ] **Step 1: Write failing server control tests**

Assert `list` and `reload` return `RuntimeCommandCatalog.roots`, `/prompt project`, `/prompt user`, `/prompt builtin`, and `/prompt mcp` compose without collision, diagnostics survive reload, and `run` addresses a leaf by stable command ID.

Run: `bun test packages/server/src/commands.test.ts`

Expected: FAIL because the control still returns a flat descriptor list and executes by name.

- [ ] **Step 2: Implement recursive server composition**

Serialize prompt nodes, merge source namespaces, include filesystem and MCP diagnostics, clone recursive catalogs safely, and execute only registered prompt leaves by ID.

- [ ] **Step 3: Update HTTP and SDK contracts test-first**

Change `/commands`, `/commands/reload`, and command submission payloads to the new catalog and invocation types. Replace every fixture that uses the flat legacy shape.

Run: `bun test packages/server/src/runtime-http.test.ts packages/sdk/src/projection.test.ts apps/cli/src/mcp-control.test.ts`

Expected after implementation: PASS.

- [ ] **Step 4: Run affected typechecks**

Run: `bun run --cwd packages/server typecheck && bun run --cwd packages/sdk typecheck && bun run --cwd apps/cli typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server packages/sdk apps/cli/src/mcp-control.ts apps/cli/src/mcp-control.test.ts apps/cli/src/harness.ts
git commit -m "feat(server): publish recursive prompt commands"
```

## Task 6: Add TUI command bindings and pure menu state

**Files:**

- Modify: `apps/tui/package.json`
- Modify: `apps/tui/tsconfig.json`
- Add: `apps/tui/src/commands/types.ts`
- Add: `apps/tui/src/commands/catalog.ts`
- Add: `apps/tui/src/commands/catalog.test.ts`
- Add: `apps/tui/src/commands/menu-state.ts`
- Add: `apps/tui/src/commands/menu-state.test.ts`
- Modify: `apps/tui/src/model-state.ts`

- [ ] **Step 1: Write failing TUI binding tests**

Cover every supported canonical command ID, exact result actions for model/thinking/session/goal/team/auth/skills/MCP/view actions, runtime prompt proxies by ID, concurrency-based availability, and confirmation actions for destructive commands.

Run: `bun test apps/tui/src/commands/catalog.test.ts`

Expected: FAIL because the TUI command adapter does not exist.

- [ ] **Step 2: Implement TUI bindings on the shared catalog**

Move the result union out of `slash/`, attach TUI handlers by stable ID, import the runtime prompt tree through `@chili/commands`, and add the workspace dependency/reference.

- [ ] **Step 3: Write failing pure menu-state tests**

Cover opening slash/palette/help modes, independent palette query, draft preservation, wrapped selection, reset on query change, Tab/Right descent, Enter intent, Escape, Backspace path ascent, and disabled selection.

Run: `bun test apps/tui/src/commands/menu-state.test.ts`

Expected: FAIL because the menu reducer does not exist.

- [ ] **Step 4: Implement the pure state reducer and rerun**

Run: `bun test apps/tui/src/commands/catalog.test.ts apps/tui/src/commands/menu-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/tui/package.json apps/tui/tsconfig.json apps/tui/src/commands apps/tui/src/model-state.ts
git commit -m "feat(tui): bind unified command catalog"
```

## Task 7: Replace the TUI command UI and keyboard interaction

**Files:**

- Replace: `apps/tui/src/chat/CommandList.tsx`
- Modify: `apps/tui/src/chat/PromptComposer.tsx`
- Modify: `apps/tui/src/chat/PromptComposer.test.tsx`
- Modify: `apps/tui/src/ChatShellApp.tsx`
- Modify: `apps/tui/src/opentui-keyboard.test.tsx`
- Modify: `apps/tui/src/opentui-render.test.tsx`
- Modify: `apps/tui/src/useChatRuntime.ts`
- Delete: `apps/tui/src/slash/types.ts`
- Delete: `apps/tui/src/slash/registry.ts`
- Delete: `apps/tui/src/slash/registry.test.ts`
- Delete: `apps/tui/src/slash/custom.ts`
- Delete: `apps/tui/src/slash/custom.test.ts`

- [ ] **Step 1: Replace legacy keyboard assertions with failing new behavior tests**

Cover slash contextual groups, Tab/Right keeping the next level open, Enter completing incomplete paths, searchable `Ctrl+P`, palette draft preservation, Backspace/Delete query edits, wrapped navigation, disabled busy commands, help browse/search/scroll, narrow frames, typo errors, and absolute paths as ordinary prompts.

Run the focused new test names with: `bun test apps/tui/src/opentui-keyboard.test.tsx`

Expected: FAIL on the new interactions.

- [ ] **Step 2: Build the command menu component**

Render group headings, canonical segment/path, description, source/current value, disabled state/reason, selection marker, result window, and key footer. Keep height accounting deterministic for short terminals.

- [ ] **Step 3: Integrate the shared menu into the composer and shell**

Replace `acceptedCompletionPrompt`, static palette items, slash-specific resolution, and fixed help view with shared menu state and command execution. Recheck availability immediately before a binding runs. Keep skill `$` completion separate.

- [ ] **Step 4: Switch runtime command state to `RuntimeCommandCatalog`**

Import recursive prompt nodes directly, use ID-based runtime submission, and show reload/conflict diagnostics through `/commands diagnostics`.

- [ ] **Step 5: Delete the legacy slash subsystem and tests**

Ensure `rg -n "SlashCommand|slashCompletions|resolveSlashCommand|acceptedCompletionPrompt|RuntimePromptCommand" apps/tui/src packages` returns no legacy implementation references.

- [ ] **Step 6: Run focused TUI suites and typecheck**

Run: `bun test apps/tui/src/commands apps/tui/src/chat/PromptComposer.test.tsx apps/tui/src/opentui-keyboard.test.tsx apps/tui/src/opentui-render.test.tsx && bun run --cwd apps/tui typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/tui
git commit -m "feat(tui): redesign command discovery and execution"
```

## Task 8: Replace CLI manual slash dispatch with the shared resolver

**Files:**

- Add: `apps/cli/src/repl-commands.ts`
- Add: `apps/cli/src/repl-commands.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/cli/src/harness.ts`
- Modify: `apps/cli/tsconfig.json`

- [ ] **Step 1: Write failing CLI dispatch tests**

Cover generated help, `/session list|compact|revert`, `/team agents|mailbox|tasks|task|recover`, `/memory show|add|reload`, `/prompt ...`, `/app exit`, incomplete/unknown errors, and removal of every old root path.

Run: `bun test apps/cli/src/repl-commands.test.ts`

Expected: FAIL because dispatch is embedded as a manual `if` chain.

- [ ] **Step 2: Implement CLI bindings and dispatcher**

Build the shared catalog with CLI handlers, merge runtime prompt nodes, resolve input through `@chili/commands`, generate help from the tree, and return a structured exit result for `/app exit`.

- [ ] **Step 3: Replace the REPL chain**

Make the read loop call the dispatcher once for slash input. Submit only `not_command` absolute paths as prompts; print structured errors for unknown, incomplete, disabled, or missing-argument results.

- [ ] **Step 4: Prove the chain and old paths are gone**

Run: `rg -n 'line === "/|line\.startsWith\("/' apps/cli/src/index.ts`

Expected: no slash dispatch matches.

- [ ] **Step 5: Run focused CLI tests and typecheck**

Run: `bun test apps/cli/src/repl-commands.test.ts apps/cli/src/index.test.ts && bun run --cwd apps/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): dispatch canonical slash commands"
```

## Task 9: Delete residual compatibility contracts and update repository tests

**Files:**

- Modify: affected `*.test.ts` and `*.test.tsx` fixtures across `apps/`, `packages/`, and `scripts/`
- Modify: any smoke fixture that invokes an old command path
- Delete: obsolete legacy-only helper files discovered by `rg`

- [ ] **Step 1: Audit for forbidden legacy symbols and paths**

Run:

```bash
rg -n "RuntimePromptCommand|SlashCommand|aliases:|acceptedCompletionPrompt|/clear|/new|/sessions|/compact|/recover-tasks|/hide-thinking|/show-thinking|/reasoning|/fast" apps packages scripts --glob '!**/dist/**'
```

Classify every hit. Delete compatibility code; update only intentional prose/error fixtures.

- [ ] **Step 2: Run the full unit suite to expose stale contracts**

Run: `bun test`

Expected initially: FAIL only where fixtures still use removed types/paths.

- [ ] **Step 3: Update tests and fixtures to the new single contract**

Do not restore deleted fields to make fixtures compile. Ensure all runtime catalogs are recursive and all prompt invocations use IDs.

- [ ] **Step 4: Run typecheck and unit tests**

Run: `bun run typecheck && bun test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps packages scripts
git commit -m "refactor: remove legacy slash command contracts"
```

## Task 10: Full verification, self-review, and completion audit

**Files:**

- Modify only files required by failures or review findings.

- [ ] **Step 1: Run all required gates from a clean command output window**

Run:

```bash
bun test
bun run typecheck
bun run smoke:all
bun run smoke:p3-team-model
bun run smoke:p3-team-parallel
```

Expected: all exit 0.

- [ ] **Step 2: Review the diff against the design spec**

Check command vocabulary, protocol recursion, ranking semantics, TUI keyboard behavior, CLI dispatch, runtime composition, disabled/destructive handling, and deletion checklist. Search again for legacy symbols and aliases.

- [ ] **Step 3: Fix review findings test-first and rerun affected gates**

Any behavioral fix starts with a reproducing test. Rerun the focused test and then all five repository gates.

- [ ] **Step 4: Inspect final repository state**

Run: `git status --short && git log --oneline -12`

Expected: only intentional changes, preferably a clean worktree.

- [ ] **Step 5: Report the result**

Summarize the new interaction model, breaking removals, key files, exact verification commands, and any intentionally unsupported surface bindings.
