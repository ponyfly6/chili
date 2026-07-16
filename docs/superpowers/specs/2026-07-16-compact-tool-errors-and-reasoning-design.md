# Compact Tool Errors and Reasoning Design

## Goal

Keep Chili's main TUI timeline readable during long agent runs without hiding failures. Read/search/list activity should remain a semantic summary, while raw tool diagnostics and full reasoning content stay available through the existing `Ctrl+O` details mode.

## Chosen Approach

Use a hybrid of Claude Code's grouped exploration summary, OpenCode's visible failed-action context, and Codex's separated reasoning sections.

- Consecutive read/search/list calls remain one exploration group.
- The compact group reports an exact failed count, the first semantic failure, and the number of additional failures.
- Raw errors, absolute diagnostic paths, inputs, and outputs render only when details are enabled.
- Reasoning summary sections remain separate from provider stream through protocol projection.
- Compact reasoning renders one Markdown-clean subject line; details mode renders the complete Markdown summary.
- Tool previews use head/tail truncation and a visual-row budget so one long line cannot consume the viewport.

## Compact Exploration UI

A completed group without failures remains unchanged:

```text
Explored 14 files, searched 3 patterns
```

A failed group renders:

```text
Explored 14 files, searched 3 patterns · 3 failed
  ↳ File not found: app/Services/GeoFlow/ContentCategoryClassifier.php
  ↳ +2 more failures (Ctrl+O for details)
```

Only the first failed target is shown in compact mode. A single failure appends `(Ctrl+O for details)` to its semantic line. The compact group must never contain raw `ENOENT`, stack traces, or repeated `error:` blocks.

## Semantic Tool Errors

Read/search/list renderers own their compact failure copy. They derive the target from structured tool input summaries, not from parsing an exception string.

- `ENOENT` or `no such file or directory` becomes `File not found: <display path>`.
- `EACCES`, `EPERM`, or `permission denied` becomes `Permission denied: <display path>`.
- Timeout failures become `<Action> timed out: <display target>`.
- Other failures become `<Action> failed: <display target>`.

Display paths are relative to the session working directory when possible, use `~` for paths under the home directory, and middle-elide long paths while preserving the filename. The original error remains unchanged in details mode.

Non-exploration tools keep their existing renderer-specific behavior in this change, except that their preview rows use the shared visual-row budget.

## Reasoning Sections

OpenAI Codex Responses events identify summary sections with `summary_index`. Chili currently substitutes `output_index` and the core runtime appends every delta to one reasoning part. Model reasoning events already carry an optional `index`, so the fix gives that existing field the section identity it was intended to preserve:

1. The Codex provider maps each `(reasoning item, summary_index)` pair to a stable stream-local `index`.
2. The core runtime keeps one `ReasoningPart` ID per reasoning event `index`; providers without an index continue using one default part.
3. Protocol storage and SDK projection already support multiple reasoning parts and require no schema change.

This prevents adjacent section headers from becoming `**first****second**`.

## Thinking UI

Compact mode renders one line per reasoning part:

```text
Thinking: Inspecting migration and legacy schema
```

The subject is the first visible Markdown-rendered line, so formatting markers never appear literally. While streaming, the same line updates in place through the existing stable part identity.

With `Ctrl+O` details enabled, the complete reasoning part is rendered through Chili's Markdown line renderer with `Thinking: ` on the first line. The independent hide-thinking control continues to replace reasoning with the existing bubble indicator.

## Preview Truncation

Tool detail previews are budgeted after terminal wrapping, not only by source line count. A preview keeps its first and last visible rows with a middle omission marker. The default content budget is five terminal rows; live output may use its existing larger details budget. Compact omission copy points to `Ctrl+O` only when more detail is actually available.

## Error Handling and Compatibility

- Failed, rejected, and cancelled statuses remain distinct at the activity level. The group `N failed` count includes only actual failed activities.
- Pending activity still takes precedence for `Exploring`; a simultaneous failure does not erase the active hint.
- Existing tool details continue to expose original input, error, and output values.
- Providers that omit `index` retain today's single reasoning part behavior.
- Existing stored sessions remain readable because no persisted protocol field changes.

## Tests

Add test-first coverage for:

1. Three failed exploration calls produce one semantic failure plus `+2 more`, with no raw `ENOENT` or absolute diagnostic path in compact mode.
2. Details mode shows all three failed activities and their original errors.
3. Workspace-relative, home-relative, and middle-elided display paths are stable.
4. The Codex provider preserves distinct `summary_index` sections through stable reasoning event indexes.
5. The core runtime creates separate reasoning parts for separate event indexes and appends deltas within one part.
6. Compact Thinking strips Markdown markers and details mode renders the full summary body.
7. Wrapped tool previews stay within their visual-row budget and preserve both head and tail.

## Success Criteria

- The screenshot's repeated multi-line `ENOENT` wall becomes at most two compact failure lines for an exploration group.
- Users can see that failures occurred and which target failed first without opening details.
- `Ctrl+O` still reveals the original diagnostics for every failed call.
- Adjacent Codex reasoning sections are stored and rendered independently.
- Compact Thinking never displays raw `**`, `****`, or concatenated section headings.
- All focused TUI, provider, core runtime, typecheck, and smoke tests remain green.
