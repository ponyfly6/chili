# Prompt and Skills Architecture

This document is the maintainer-facing map for Chili prompt assembly, memory/project context, and skills. The short rule is:

```text
base -> developer -> contextual_user -> conversation -> tool_schema
```

Each runtime turn assembles `PromptFragment[]` through `PromptAssembler`. The assembler sorts by layer, then priority, then insertion order. Providers receive structured prompt channels where they can, and provider fallbacks preserve the layer markers as closely as possible.

## Prompt Layers

`base`
: Stable Chili identity and core behavior. This is owned by core and should stay compact. It lives in `chiliBasePromptFragment()`.

`developer`
: Runtime rules and control-plane context. Examples are memory mechanics, task follow-up policy, and the available skills catalog. These are instructions about how Chili should operate, not user-authored project facts.

`contextual_user`
: Background material that should inform the turn but must not override the user request or higher layers. Examples are `AGENTS.md`, `CHILI.md`, `.chili/memory.md`, `.chili/rules/*.md`, and activated skill bodies.

`conversation`
: The real session history, tool calls, tool results, and compaction summaries. This is carried by the runtime and providers, not by hand-written prompt text.

`tool_schema`
: Tool schemas stay as schemas. Do not paste tool definitions into prompt fragments.

## Memory And Project Context

Memory mechanics are injected as a `developer` fragment:

```text
chili.memory.mechanics
```

Memory documents and project instructions are injected as `contextual_user` fragments:

```text
~/.chili/memory.md
<project>/.chili/memory.md
AGENTS.md
CHILI.md
.chili/rules/*.md
```

Project instructions are loaded from `projectRoot` toward `cwd`, so nearer project files appear later and can refine broader context. `.chili/rules/*.md` are unconditional today. Future path-aware rules should remain `contextual_user` unless they become runtime policy.

Memory is intentionally low priority. It can be stale and should never override current user intent, base instructions, developer instructions, or tool results.

## Skills Flow

Skills live in:

```text
~/.chili/skills/<name>/SKILL.md
<cwd>/.chili/skills/<name>/SKILL.md
```

Compatibility aliases under `.agents/skills` are loaded by default and can be disabled by loader options.

The skills catalog is a lightweight `developer` fragment:

```text
chili.skills.catalog
```

It lists names, descriptions, and `when_to_use` hints. It does not include full skill bodies.

Full skill instructions are loaded only when a skill is activated for the current turn:

```text
chili.skill.<name>
```

Activated skill bodies are `contextual_user` fragments with `lifecycle: "turn"`. They include:

- skill metadata
- full `SKILL.md` body
- a bounded `<skill_files>` listing with paths and byte sizes

Skill resource file contents are not injected automatically. They are hints for follow-up inspection.

## User Experience

CLI:

```bash
bun run chili -- skills
bun run chili -- skills list --json
bun run chili -- skills disable reviewer
bun run chili -- skills enable --user reviewer
bun run chili -- prompt-debug --text 'use $reviewer'
bun run chili -- prompt-debug --text 'use $reviewer' --content
```

TUI:

```text
/skills
/skills disable reviewer
/skills enable reviewer
$reviewer
```

`/skills` inserts `$` and opens the skill picker. Picker selection binds the exact `SKILL.md` path so duplicate skill names can still resolve deterministically. Manual `$unknown` or ambiguous `$same` mentions produce local warnings and still submit the prompt.

Disabled skills are hidden from the catalog, picker, lookup, and skill body injection. Disabled names are stored in:

```text
~/.chili/skills.json
<cwd>/.chili/skills.json
```

## Debugging

Use prompt debug first when a prompt behavior looks wrong:

```bash
bun run chili -- prompt-debug --cwd <repo>
bun run chili -- prompt-debug --cwd <repo> --text 'use $reviewer'
bun run chili -- prompt-debug --cwd <repo> --text 'use $reviewer' --content
bun run chili -- prompt-debug --cwd <repo> --json
```

Default output shows the manifest only:

```text
id layer source trust lifecycle chars metadata
```

`--content` prints rendered fragment content. Use it carefully because it can contain memory, project instructions, and skill bodies.

Useful fragment ids:

```text
chili.base
chili.memory.mechanics
chili.context.<kind>.<index>
chili.skills.catalog
chili.skill.<name>
chili.skill_mentions.warnings
```

## Design Boundaries

Keep these boundaries unless there is a deliberate architecture change:

- Do not put memory or project instructions back into `base` or `developer`.
- Do not inject every skill body by default.
- Do not use prompt text for tool schemas.
- Do not make hidden or disabled skills visible in catalogs.
- Do not let ambiguous plain `$skill` mentions silently pick one skill.
- Prefer debug manifest metadata over ad hoc logging when adding new prompt sources.

## Next Extensions

The next natural extensions are:

- path-aware `.chili/rules/*.md` frontmatter
- a model-driven skill activation tool path
- retrieval memory and memory write/delete policy
- MCP/deferred tool discovery once tool counts become large
