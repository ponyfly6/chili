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
: Runtime rules and control-plane context, such as delegation and execution review instructions. These are instructions about how Chili should operate, not user-authored project facts.

`contextual_user`
: Background material that should inform the turn but must not override the user request or higher layers. The standard Host uses it for the skills catalog and activated skill bodies. Explicit library callers can still supply other material.

`conversation`
: The real session history, tool calls, tool results, and compaction summaries. This is carried by the runtime and providers, not by hand-written prompt text.

`tool_schema`
: Tool schemas stay as schemas. Do not paste tool definitions into prompt fragments.

## Memory And Project Context

The standard Host does not automatically load Memory bodies, `AGENTS.md`,
`CHILI.md`, or `.chili/rules/*.md`. The base prompt explains the available
capabilities and Memory directory paths; the Agent decides when to inspect
relevant files with ordinary file tools or Bash under existing execution policy.

Memory bodies are ordinary Markdown under `<profile>/memory/personal` and
`<profile>/memory/projects/<projectId>`. There is no dedicated Memory model tool,
database body, pagination API, or entry ID/revision protocol. Normal file
observations enter tool history and use the same context budget and request-source
recording as other results. Main and child Agents use the same directory resolver
for their respective execution cwd, with their own session history.

User Memory belongs to the active profile; project Memory belongs to the current
project in that profile. Memory may be stale; current user corrections take
precedence. Writes, updates and deletion use ordinary file operations.
Automatic extraction and scheduled consolidation are not enabled. See the
[Memory contract](../packages/core/src/memory/README.md) for directory ownership,
file freshness and existing permission boundaries.

The former combined Memory/project-rule loader is removed. CLI Memory inspection
reads current Markdown directly; it does not import or migrate older storage.

## Skills Flow

Skills live in:

```text
~/.chili/skills/<name>/SKILL.md
<cwd>/.chili/skills/<name>/SKILL.md
```

Compatibility aliases under `.agents/skills` are loaded by default and can be disabled by loader options.

The skills catalog is a lightweight `contextual_user` fragment:

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

`--content` prints rendered fragment content. Actual request inspection can also
include Memory and project instructions previously read through tools. The
record describes the shared model-adapter input, not provider HTTP bytes.

Useful fragment ids:

```text
chili.base
chili.skills.catalog
chili.skill.<name>
chili.skill_mentions.warnings
```

## Design Boundaries

Keep these boundaries unless there is a deliberate architecture change:

- Keep Memory directory guidance in the base prompt; read and edit Memory with ordinary file tools or Bash.
- Do not inject every skill body by default.
- Do not use prompt text for tool schemas.
- Do not make hidden or disabled skills visible in catalogs.
- Do not let ambiguous plain `$skill` mentions silently pick one skill.
- Prefer debug manifest metadata over ad hoc logging when adding new prompt sources.

The older [path-aware rules RFC](path-aware-rules-rfc.md) is a historical proposal
for automatic loading. That direction and its loader have been retired.
