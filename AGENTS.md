# Repository Guidelines

## Project Structure & Module Organization

Chili is a Bun + TypeScript workspace. Runtime applications live in `apps/`: `apps/cli` contains the command-line entry point and harness, and `apps/tui` contains the OpenTUI React interface. Shared libraries live in `packages/`, including `protocol`, `core`, `tools`, `store`, `mcp`, `providers`, `server`, `skills`, `commands`, `sdk`, and `policy`. Source files are under each workspace's `src/` directory. Tests are colocated as `*.test.ts` or `*.test.tsx`. Brand assets are in `assets/brand`, docs in `docs/`, and smoke/probe scripts in `scripts/`.

## Build, Test, and Development Commands

- `bun install`: install workspace dependencies using the pinned Bun package manager.
- `bun run typecheck` or `bun run check`: run `tsc -b` across workspaces.
- `bun test`: run colocated unit tests with Bun.
- `bun run chili -- "summarize this repo"`: run the CLI locally.
- `bun run tui`: start the terminal UI.
- `bun run smoke:all`: run the complete fake-model smoke gate used by CI and before commits.
- `bun run smoke` or another individual `smoke:*` command: run a focused suite during local development.
- `bun run test:index`: list available smoke scripts and grouped test files.

## Coding Style & Naming Conventions

Use TypeScript ESM with explicit `.js` extensions for relative runtime imports. Keep strict typing enabled; avoid `any` unless a boundary requires it. Use 2-space indentation, double quotes, semicolons, and named exports for shared modules. Import across packages through `@chili/*` workspace aliases. Name React/OpenTUI components in `PascalCase`, hooks as `useSomething`, and regular files in existing lower-case or kebab-case patterns, such as `user-model-state.ts`.

## Testing Guidelines

Add focused tests next to changed code using the `*.test.ts` or `*.test.tsx` convention. Prefer behavioral tests for parsers, state transitions, render models, and tool adapters. Run `bun test`, `bun run typecheck`, and the complete `bun run smoke:all` gate before submitting. Use individual smoke commands such as `bun run smoke:cli` for focused development feedback.
For team parallel scheduling changes, run `bun run smoke:p3-team-model` and `bun run smoke:p3-team-parallel`.

## Commit & Pull Request Guidelines

Commit history mostly uses concise imperative subjects with optional Conventional Commit scopes, for example `feat(tui): add multi-click text selection` or `fix(cli): remember user selected model`. Prefer that style and keep subjects under roughly 72 characters. Pull requests should include a short problem/solution summary, tests run, linked issues when applicable, and screenshots or terminal captures for visible TUI changes.

## Security & Configuration Tips

Do not commit secrets from `.env.local`, `~/.chili/auth.json`, or provider API keys. Use fake-model smoke tests when possible; only run provider probes such as `bun run probe:minimax` with local credentials.
