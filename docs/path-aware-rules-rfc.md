# Path-Aware Project Rules RFC

Status: design contract; **not implemented**.

This RFC defines the executable contract for activating `.chili/rules/*.md` files. It does not implement the contract. The v1 decision is intentionally narrower than general touched-file awareness: activation uses the runtime `cwd` plus caller-supplied, structured `contextPaths`. Chili never extracts paths from user-authored free text. Successful file-tool calls may contribute paths in v2, but not in v1.

## 1. Current Data Flow

The current implementation is unconditional even though it already parses path-related metadata.

1. [`resolveChiliMemoryPaths`](../packages/core/src/memory/project-instructions.ts) resolves `projectRoot` (normally with `git rev-parse --show-toplevel`) and absolute `cwd`. `projectInstructionDirs` produces directories from `projectRoot` through `cwd`, inclusive. If `cwd` is outside `projectRoot`, only `projectRoot` is used.
2. For every directory in that root-to-cwd order, `resolveProjectInstructionSources` adds `AGENTS.md`, then `CHILI.md`, then the results of [`projectRuleSources`](../packages/core/src/memory/project-rules.ts). Rule discovery is non-recursive within each `<dir>/.chili/rules`: only regular `.md` files immediately inside that directory are considered.
3. `projectRuleSources` reads each rule to call `parseProjectRuleMarkdown`, attaches parsed metadata to the source, and sorts rules in that one directory with `compareProjectRuleSources`. Explicit numeric priorities come first in ascending order; equal priorities use `path.localeCompare`; rules without a priority come after every explicitly prioritized rule and are path-sorted. The outer root-to-cwd directory order is not globally re-sorted.
4. [`parseProjectRuleMarkdown`](../packages/core/src/memory/project-rules.ts) recognizes a deliberately small frontmatter subset. Valid frontmatter can contain `paths`, `alwaysApply`, `description`, and `priority`; unknown fields are ignored. The current parser sets `alwaysApply` to `true` when it is omitted, including when non-empty `paths` are present. If delimiters or field types are malformed, the entire file, including apparent frontmatter, is treated as ordinary Markdown.
5. [`loadChiliMemoryContext`](../packages/core/src/memory/fragments.ts) loads user memory, project memory, and every discovered instruction/rule source in order. [`loadDocument`](../packages/core/src/memory/documents.ts) parses a rule again, removes valid frontmatter from its body, trims it, and clips each non-empty document independently at `DEFAULT_MAX_DOCUMENT_CHARS` (currently 32,000 characters in [`memory/constants.ts`](../packages/core/src/memory/constants.ts)). Missing and empty documents do not enter `documents`.
6. [`chiliMemoryPromptFragments`](../packages/core/src/memory/fragments.ts) emits memory mechanics as `developer/system`, then emits every loaded document as a fragment. A project rule is currently always `layer: "contextual_user"`, `trust: "project"`, `source: "project"`, and `lifecycle: "session"`. `memoryDocumentDebugMetadata` labels every rule `ruleType: "unconditional"`, even when its parsed `alwaysApply` is `false`.
7. [`buildCliPromptFragments`](../apps/cli/src/harness.ts) combines the base prompt, memory/project fragments, the skills catalog, and activated skill bodies. The root and child `RuntimeService` providers rebuild these fragments whenever `resolvePromptAssembly` runs. The separate `AgentRunnerSubagentRunner` provider receives no turn context and assembles its prompt once before its tool-use loop.
8. [`RuntimeService.resolvePromptAssembly`](../packages/core/src/runtime-service.ts) calls the fragment provider, adds goal and conversation fragments, then uses [`PromptAssembler`](../packages/core/src/prompt/assembler.ts). The assembler sorts by layer, numeric fragment priority, and insertion order. It does not enforce a character budget; [`buildPromptDebugManifest`](../packages/core/src/prompt/debug.ts) only reports rendered fragments and their total characters.
9. Normal submission in `RuntimeService.runReservedPrompt` passes a `RuntimePromptTurnContext` containing only `text` and optional `skillMentions` on every model turn in the tool-use loop. `runGoalContinuation` calls prompt assembly without a turn context. `RuntimePromptTurnContext`, `SubmitPromptInput`, and `InspectPromptInput` have no active/touched-path field today.
10. [`SingleAgentRuntime.runTurn`](../packages/core/src/single-agent-runtime.ts) includes system, developer, contextual-user fragments, and tool schemas in the fixed-input token estimate. When the selected model exposes request limits, [`ContextWindowBuilder`](../packages/core/src/context/window.ts) fails with `fixed_input_exceeds_window` rather than truncating fixed input. The CLI's `maxInputChars: 500_000` guard applies to conversation history, not as an aggregate fragment-character limit. If model limits are unavailable, there is no equivalent aggregate guard for fixed prompt fragments.
11. [`RuntimeService.inspectPrompt`](../packages/core/src/runtime-service.ts) drives [`prompt-debug.ts`](../apps/cli/src/prompt-debug.ts). It can show metadata and, with `--content`, rendered content, but it can only report fragments that were injected. There is currently no catalog of discovered-but-not-injected rules.

Therefore, `alwaysApply: false` is metadata only today: its body is still loaded, rendered, counted in `totalChars`, and unconditionally sent to the model.

## 2. Activation Source Comparison

“First turn” below means that the selected rule body can be present in the first model request, not merely that the model can see a catalog entry.

| Source | Correctness | First turn | Determinism | Security risk | Complexity | Repository-root workflow |
| --- | --- | --- | --- | --- | --- | --- |
| `cwd` only | Correct when the working directory is the actual target subtree; incomplete for multi-area work | Yes | High | Low after containment validation | Low | Poor: root-scoped `cwd` does not identify a target such as `packages/core/src/x.ts` |
| Paths extracted from user free text | Both false positives and false negatives; pasted code, examples, URLs, and prose are ambiguous | Usually | Low; parser/model heuristics change outcomes | High: untrusted text can name paths solely to activate project instructions | Medium and permanently heuristic | Superficially better, but unsafe and unpredictable |
| Caller-supplied structured `contextPaths` | High when an editor, SDK, command, or orchestrator knows the target | Yes | High | Low-to-medium; requires type, length, and project-root containment checks | Medium | Good for root-located rules: explicit files/directories still match while `cwd` is root |
| Paths accumulated from successful file tools | High after a recognized file operation; misses intent before the first tool and requires a tool taxonomy | No; first affects the next model turn | High if taken only from validated tool arguments and successful results | Medium: tool schemas, aliases, moves, and directory operations must be classified; tool output must not be parsed | High because it adds run state and tool-result integration | Good after the first successful file tool, not on the first request |
| Model catalog plus `activate_rule` | Depends on the model selecting the right rule from metadata | No; activation occurs after a model/tool round trip | Medium; the tool call is explicit, but the choice is model-dependent | Medium: project-authored descriptions can influence selection; activation must never grant authority | High: bounded catalog, tool, state, and debug behavior are all required | Better after activation, but slower and less reliable than caller-known paths |

No source makes a project rule more authoritative. This comparison only decides whether a `contextual_user/project` body is present.

## 3. v1 Decision

v1 **must** use exactly these activation candidates:

1. `cwd`, represented as a directory candidate when it is inside or equal to `projectRoot`.
2. An optional caller-provided `contextPaths` list whose items have the shape:

   ```ts
   interface RuntimeContextPath {
     path: string;
     kind: "file" | "directory";
   }
   ```

`contextPaths` is added to `RuntimePromptTurnContext` and to the public submit/inspect inputs that create that context. The caller, not Chili's language model and not a text parser, is responsible for declaring that a path is relevant.

v1 never derives a path from `RuntimePromptTurnContext.text`, conversation messages, pasted content, tool output, rule descriptions, or model prose. `cwd` is a useful default candidate, but documentation and debug output must call it `cwd` context, not touched-file or active-file awareness.

Rule discovery remains the current project-root-to-cwd, non-recursive discovery process. `contextPaths` participates in activation only; it does not discover additional nested `AGENTS.md`, `CHILI.md`, or `.chili/rules` directories. Thus, root startup plus `contextPaths` fixes matching for scoped rules discovered at the root, but does not discover a rule stored under an otherwise undiscovered nested `.chili/rules`. A caller that needs that nested instruction hierarchy must use the nested `cwd`. This limitation is explicit v1 behavior, not an unspecified edge case.

v2 may accumulate `activePaths` from the structured arguments of successful, recognized file tools and apply them beginning with the next model turn. Failed, denied, cancelled, read-only metadata-only, unknown, or non-file tools do not add paths. Tool output and free-form command output are never parsed for paths. v2 state is outside this RFC's implementation scope.

## 4. Frontmatter Contract

The parser remains a small, purpose-built parser; this RFC does not introduce general YAML.

| Declaration | Effective v1 behavior |
| --- | --- |
| No frontmatter | Legacy unconditional rule |
| `alwaysApply: true` | Always active. If `paths` also exists, `alwaysApply` wins; paths are validated for diagnostics but are not consulted for activation |
| Non-empty `paths`, no explicit `alwaysApply` | Scoped rule; active when any valid pattern matches any candidate |
| `alwaysApply: false` plus non-empty `paths` | Scoped rule; active when any valid pattern matches any candidate |
| `alwaysApply: false` with absent or empty `paths` | Inactive, with an `inactive_no_paths` diagnostic |
| No explicit `alwaysApply`, with absent or empty `paths` | Unconditional for compatibility; an explicitly present empty `paths` value also produces an `empty_paths` warning |

The parsed representation must preserve whether `alwaysApply` was declared. The current required `ChiliProjectRuleMetadata.alwaysApply: boolean` default loses that information and cannot implement the table above; v1 must store the declared value as optional (or store equivalent explicitness separately) and expose both declared and effective modes in debug data.

Compatibility and validation are fixed as follows:

- A file that does not start with a frontmatter opening delimiter remains legacy unconditional.
- A file that starts with `---` but has an unterminated block, malformed syntax, duplicate/invalid field type, non-finite priority, or another parser error remains unconditional and keeps the apparent frontmatter in its body, matching current compatibility behavior. It also emits a `malformed_frontmatter_legacy` warning. A malformed block must never be partially interpreted as scoped.
- Unknown fields are ignored and produce `unknown_frontmatter_field` warnings naming the fields. Known valid fields continue to work; unknown fields do not make the block malformed.
- `paths: []`, a blank `paths:`, and a list containing no non-empty entries are empty paths. Empty entries are not silently removed before diagnostics.
- `description` is debug/catalog metadata only and never activates a rule.
- `priority` is a finite number used only for ordering. It never changes activation or authority.
- For a scoped rule, any invalid pattern invalidates the whole rule for activation. Valid siblings are not partially used; status is `not_injected` with reason `invalid_pattern`. This avoids a typo silently broadening or narrowing application.
- For `alwaysApply: true`, invalid patterns produce diagnostics but do not deactivate the rule because `alwaysApply` has precedence.

## 5. Path and Glob Semantics

### 5.1 Candidate representation and normalization

All matching is lexical and relative to `projectRoot`; no candidate requires the path to exist.

- `cwd` is resolved as an absolute directory and then made project-root-relative. A root `cwd` is represented internally as `.`. An outside-root `cwd` is omitted and diagnosed as `outside_project_root`; it is not replaced with the root candidate.
- A relative `contextPaths[].path` is interpreted relative to `projectRoot`, never relative to `cwd`. An absolute candidate is accepted only when it is lexically inside or equal to `projectRoot`, then converted to a relative form. POSIX absolute paths, Windows drive paths, and UNC paths are recognized on their applicable platform.
- A relative candidate containing a `..` segment is rejected before simplification, even if later segments would return inside the root. An absolute candidate outside the root is rejected. Symlinks are not resolved in v1.
- Backslashes are converted to `/`; repeated separators and `.` segments are removed; a trailing separator is removed. Internal matching always uses POSIX `/` regardless of host OS.
- Empty candidates, candidates containing NUL/control characters, and normalized candidates longer than 4,096 UTF-16 code units are rejected with diagnostics. Invalid candidates do not fail otherwise valid candidates.
- Candidate kind is explicit and is never inferred from a trailing slash, filename extension, or filesystem `stat`. Both files and directories use the same normalized path string; `kind` remains available for debug and future semantics.
- Candidates are evaluated in deterministic order: `cwd` first, then caller `contextPaths` in input order. Exact duplicates of normalized `path` plus `kind` are removed after the first occurrence.
- v1 accepts at most 256 caller `contextPaths`. Exceeding the limit is a blocking input error; Chili must not truncate the list.

### 5.2 Pattern normalization and validation

Patterns are also project-root-relative POSIX paths.

- Backslashes are treated as separators and converted to `/`, so `packages\\core\\**` and `packages/core/**` are equivalent. Repeated separators, `.` segments, and a trailing separator are normalized away.
- Absolute patterns are invalid, including `/foo`, `C:\\foo`, and UNC forms. A pattern containing any `..` segment is invalid, even when lexical normalization could bring it back under the root.
- An empty pattern, a pattern containing NUL/control characters, or a normalized pattern over 512 UTF-16 code units is invalid.
- A rule may declare at most 128 pattern entries. Exceeding the limit makes a scoped rule invalid; the list is not truncated.
- Only literal characters, `*`, `?`, and `**` are supported. `*` matches zero or more UTF-16 code units other than `/`. `?` matches exactly one UTF-16 code unit other than `/`. `**` is valid only as an entire path segment and matches zero or more complete segments.
- Leading `!` negation, brace expansion (`{a,b}`), extglob (`@(a)`, `+(a)`, `?(a)`, `*(a)`, `!(a)`), character classes (`[ab]`), and a `**` embedded in another segment are invalid, not literal alternate syntaxes.
- Multiple patterns are OR. Pattern order is preserved for debug; the first pattern/candidate pair in the deterministic iteration order is reported as the match.
- Matching is case-sensitive on every platform, including default case-insensitive macOS and Windows filesystems. This makes repository behavior portable and does not depend on filesystem lookup.

### 5.3 File and directory matches

The candidate's normalized string is matched directly; directories do not implicitly expand to all descendants.

- `foo` matches the file or directory candidate `foo` exactly.
- `foo/*` matches `foo/bar` but not `foo`, `foo/bar/baz`, or a root candidate.
- `foo/**` matches `foo` itself and every descendant. This special zero-segment behavior is required.
- `**/*.ts` matches both `a.ts` and `src/a.ts`.
- `**` matches the root directory candidate `.` and every non-root candidate.
- `.` matches only the project-root directory candidate.

The matcher must not compile patterns to a backtracking regular expression. Pattern validation/compilation is linear in pattern length, and matching a compiled pattern is worst-case linear in candidate length with bounded matcher state. Implementations that can exhibit exponential or input-dependent catastrophic backtracking are non-conforming.

Across one assembly, at most 1,024 rule files and 4,096 total pattern entries may be processed. Exceeding either limit is a blocking `project_rules_limit_exceeded` error, not truncation.

## 6. Lifecycle and State Machine

v1 path state belongs to one prompt run. It is not long-term memory and is not reconstructed from conversation text.

| Scenario | Context paths visible to activation |
| --- | --- |
| Current user prompt, first model turn | Valid `cwd` directory plus that submission's explicit `contextPaths` |
| Consecutive model turns caused by tool use | The same frozen `cwd` and explicit `contextPaths` as the first turn; tool calls add nothing in v1 |
| Goal continuation executed synchronously as part of the same `submitPrompt` run | The same frozen `cwd` and explicit `contextPaths`, even though skill-mention text need not be replayed |
| Standalone persistent-goal continuation started later | Its new run's `cwd`; no prior `contextPaths` unless the caller explicitly supplies new ones |
| Resume/reopen of a session or task | The resumed run's `cwd` and newly supplied `contextPaths`; previous run paths are not restored from events or messages |
| Child `RuntimeService` task | Child `cwd` plus context paths explicitly supplied on the child submission; parent paths are not inherited |
| `AgentRunnerSubagentRunner` local subagent | Subagent `cwd` plus paths explicitly present in its structured run input; absent support means cwd-only, never parent inheritance or task-text extraction |

At submission, normalization produces an immutable ordered candidate set for the run. Every prompt assembly in that run reevaluates discovered rules against that set so results are stable across tool-use turns. Active project-rule fragments use `lifecycle: "turn"` in v1 because their presence is run-context-dependent; project instructions and memories retain their existing lifecycles.

No `contextPaths` or derived activation set is written to memory, goal state, session events, compaction summaries, or the transcript in v1. A host may retain its own editor state and explicitly resubmit it, but Chili does not silently persist it.

## 7. Injection and Security Boundaries

Every injected project rule, whether legacy, always, cwd-matched, or context-path-matched, must remain:

```text
layer=contextual_user
trust=project
```

Activation must never:

- promote content to `developer` or `system`/`base`;
- add, remove, or reinterpret tool permissions;
- change approval decisions or approval policy;
- change sandbox mode or filesystem/network access;
- treat a priority value as authority.

The existing memory mechanics remain applicable: project context cannot override the current user request, developer/base instructions, or tool results.

Free-text path extraction is prohibited because user text is an instruction-bearing, attacker-controlled channel. A pasted log, code sample, quoted issue, web content, or prompt injection could name a sensitive path and cause an otherwise irrelevant project rule body to enter fixed input. Requiring structured caller context separates application state from language content.

Glob denial-of-service protection is mandatory: 256 context paths, 1,024 discovered rules, 128 patterns per rule, 4,096 patterns total, 512 code units per pattern, and 4,096 code units per candidate. Limit violations are explicit diagnostics or blocking errors as defined above. Matching must use the non-backtracking linear algorithm required by section 5.

## 8. Context Budget Contract

Non-matching, inactive, and invalid scoped rule bodies must not enter `ChiliMemoryDocument[]`, `PromptFragment[]`, any rendered prompt channel, `PromptDebugManifest.totalChars`, the fixed-input token estimate, or `--content` output. Their metadata and activation diagnostics may appear in the separate debug catalog described below. Reading the bounded frontmatter during discovery is allowed; retaining or rendering the body is not required.

Matching and unconditional rules keep the existing per-document 32,000-character clipping behavior. Truncation remains explicit through `truncated`, `truncatedAfter`, and the rendered truncation marker, and therefore is not silent.

The current “32k per file, unlimited number of rules” behavior is unsafe: many rules can create arbitrarily large fixed input, `PromptAssembler` only counts it, and the model-aware guard can only reject the request after all fixed input has been assembled. It also offers no aggregate protection when model request limits are unavailable.

v1 adopts an aggregate active-rule budget:

- `MAX_ACTIVE_PROJECT_RULE_PROMPT_CHARS = 128_000` UTF-16 code units.
- The measured value is the sum of `renderChiliMemoryDocument(document).length` for active project rules after per-file clipping and including document wrappers/truncation markers.
- Budget is checked after activation and body loading but before any project-rule fragment is added.
- If the sum exceeds the limit, normal prompt submission fails before the model with `project_rules_budget_exceeded`, including the limit, total, and active rule paths/sizes.
- There is no greedy selection, priority-based dropping, or partial rule injection. `prompt-debug` returns a blocking diagnostic and marks all otherwise-active rules `status: "error", reason: "budget_exceeded"`; it does not inject a partial set.

This explicit all-or-nothing failure prevents silent omission of a rule that the author may consider important. Active rules still count toward and remain subject to the existing model context-window fixed-input guard; the 128k rule budget does not guarantee that the complete prompt fits a particular model.

## 9. Debug Contract

`PromptDebugManifest` gains a machine-readable `projectRules` array separate from `fragments`. A non-injected rule must never be represented as a fake zero-content fragment, because fragments are model input.

Each entry has this minimum shape:

```ts
interface ProjectRuleDebugEntry {
  path: string;                  // absolute source path
  projectRelativePath: string;   // normalized POSIX path
  status: "injected" | "not_injected" | "error";
  reason:
    | "legacy_unconditional"
    | "always"
    | "cwd_match"
    | "context_path_match"
    | "no_match"
    | "invalid_pattern"
    | "inactive"
    | "budget_exceeded";
  layer: "contextual_user";
  trust: "project";
  declaredAlwaysApply: boolean | null;
  effectiveMode: "always" | "scoped" | "inactive";
  paths: readonly string[];
  priority: number | null;
  description: string | null;
  matchedPattern?: string;
  matchedPath?: string;
  matchedPathKind?: "file" | "directory";
  matchedSource?: "cwd" | "context_path";
  bodyChars: number | null;
  promptChars: number;           // exactly 0 unless injected
  diagnostics: readonly ProjectRuleDiagnostic[];
}
```

Reason precedence is deterministic:

1. No frontmatter or malformed legacy-compatible frontmatter: `legacy_unconditional` (malformed content also has a diagnostic).
2. Effective always mode: `always`.
3. Effective inactive mode: `inactive`.
4. A scoped rule with any invalid pattern: `invalid_pattern`.
5. First matching candidate: `cwd_match` or `context_path_match`.
6. Otherwise: `no_match`.

Warnings such as `empty_paths`, `unknown_frontmatter_field`, `malformed_frontmatter_legacy`, invalid candidates, or ignored invalid paths on an always rule live in `diagnostics`; they do not replace an applicable higher-precedence activation reason.

Human-readable `prompt-debug` adds a `[project-rules]` section with one line per discovered rule containing status, reason, relative path, declared/effective mode, priority, match source/path/pattern when present, `bodyChars`, `promptChars`, and diagnostic codes. JSON emits the complete objects. Existing `[fragments]` remains the authoritative list of model input. `--content` prints content only for actual fragments and never prints the body of a `not_injected` or `error` rule.

The CLI debug surface accepts repeatable `--context-file <path>` and `--context-dir <path>` options and converts them to structured entries. It does not accept a generic untyped path flag. If the active-rule budget blocks assembly, prompt-debug still returns the manifest and blocking error metadata and exits non-zero; normal submission does not call the model.

## 10. Ordering and Conflict Proximity

Activation filters the current source sequence without reordering survivors.

1. Directory hierarchy is primary: sources from `projectRoot` come first, followed by each directory toward `cwd`. A deeper directory is later regardless of any priority in an ancestor. `contextPaths` do not add discovery branches in v1.
2. Within one directory, existing project instruction order remains `AGENTS.md`, `CHILI.md`, then that directory's active rules.
3. Within one `.chili/rules` directory, rules with explicit priority come before rules without priority. Explicit priorities sort numerically ascending, so a larger numeric priority is later. Equal explicit priorities use stable normalized project-relative POSIX path order. Unprioritized rules are last and use the same stable path order.
4. Stable path order means ascending comparison by UTF-16 code units, not locale-sensitive `localeCompare`, host path separators, filesystem enumeration order, or absolute checkout prefix.
5. `chiliMemoryPromptFragments` assigns fragment priority from the resulting document order. `PromptAssembler` then preserves it through numeric priority and insertion order.

Consequently, among conflicting project rules, a deeper-directory rule is closer to the final prompt; within the same directory, an unprioritized rule is after every explicitly prioritized rule, otherwise the larger explicit priority is later, and equal cases are resolved by path. “Later” means closer in the `contextual_user` sequence, not stronger than the user, developer, base, or tool-result layers.

## 11. Executable Test Matrix

Unless stated otherwise, `projectRoot=/repo`, the rule is at `/repo/.chili/rules/rule.md`, `alwaysApply` is omitted, and debug must agree with fragment presence.

| Case | Rule/input | Expected result |
| --- | --- | --- |
| Windows separators | `paths: [packages\\core\\**]`; context file `packages\\core\\src\\x.ts` | Injected, `context_path_match`; normalized match is `packages/core/src/x.ts` |
| Root cwd alone | `paths: [packages/core/**]`; `cwd=/repo`; no context paths | Not injected, `no_match`; root `.` does not match |
| Root cwd plus file | Same rule/cwd; context file `packages/core/src/x.ts` | Injected, `context_path_match` on first model turn |
| Directory itself | `paths: [packages/core/**]`; context directory `packages/core` | Injected; `foo/**` zero-segment behavior matches `foo` |
| Child path | Same rule; context file `packages/core/src/x.ts` | Injected |
| One-level wildcard | `paths: [packages/core/*]`; directory `packages/core` | Not injected; with file `packages/core/x.ts`, injected; with `packages/core/src/x.ts`, not injected |
| Root globstar | `paths: [**]`; `cwd=/repo` | Injected, `cwd_match` |
| Multiple patterns | `paths: [docs/*.md, packages/core/**]`; file `packages/core/x.ts` | Injected by the second pattern; patterns are OR |
| Case sensitivity | `paths: [Docs/**]`; file `docs/x.md` | Not injected on every OS |
| Relative traversal candidate | context file `packages/core/../../secret` | Candidate rejected and diagnosed; cannot activate |
| Outside absolute candidate | context file `/tmp/x.ts` | Candidate rejected and diagnosed; cannot activate |
| Invalid absolute pattern | `paths: [/repo/packages/**]` | Not injected, `invalid_pattern` |
| Invalid/valid pattern mix | `paths: [../outside/**, packages/core/**]`; matching core file | Entire scoped rule not injected, `invalid_pattern` |
| `alwaysApply: true` only | Any cwd/paths | Injected, `always` |
| `alwaysApply: true` plus invalid paths | `paths: [../bad]` | Injected, `always`, with invalid-pattern diagnostic |
| Paths only | non-empty `paths`, no `alwaysApply` | Scoped, not defaulted to always |
| `alwaysApply: false` plus paths | Matching and non-matching candidates | Injected only for match; otherwise `no_match` |
| `alwaysApply: false` without paths | No `paths` or `paths: []` | Not injected, `inactive`, with `inactive_no_paths` |
| Empty paths without explicit always | `paths: []` | Injected, `always`, with `empty_paths` compatibility warning |
| No frontmatter | Plain Markdown | Injected, `legacy_unconditional` |
| Malformed frontmatter | Unterminated block, bad indentation, or wrong known-field type | Injected as raw legacy body, `legacy_unconditional`, with `malformed_frontmatter_legacy` |
| Unknown field | Valid known fields plus `owner: team` | Known semantics apply; `unknown_frontmatter_field` warning |
| Priority within directory | priority `1`, priority `10`, then unset; equal values have `a.md`, `b.md` | Order is `1`, `10/a.md`, `10/b.md`, unset; only active survivors appear |
| Hierarchy versus priority | root rule priority `999`; child-dir rule priority `-999`; nested cwd | Root rule is still earlier; hierarchy wins |
| Non-match budget exclusion | Scoped body of 20,000 chars does not match | No fragment; `promptChars=0`; `PromptDebugManifest.totalChars` and fixed-input chars are unchanged by that body |
| Active aggregate overflow | Five rendered active rules total more than 128,000 chars | No project-rule subset injected; blocking `project_rules_budget_exceeded`; normal model call count is zero |
| Pattern/rule limits | 129 patterns in one scoped rule, 1,025 files, or 4,097 total patterns | Explicit invalid/blocking diagnostics as specified; never truncation |
| Tool-use continuation | Explicit context file matches; first model calls a tool | The same rule is injected on the next model turn; tool arguments add no new v1 paths |
| Same-run goal continuation | Explicit context file matches and active goal continues | The same rule remains injected |
| Later goal/resume | Previous run had context files; new run supplies none | Only new `cwd` candidate is visible; previous paths are absent |
| Child runtime | Parent has matching path; child gets none | Child does not inherit it. Supplying the same structured child path activates the child rule |
| Local subagent | Task text names a matching file but structured subagent input has none | No text extraction; cwd-only activation |
| Debug body boundary | Non-matching rule with unique secret marker and `--content` | Metadata/reason is visible; marker is absent from all content and prompt chars |

Tests must exercise both the memory/fragment API and prompt-debug output. Runtime tests must assert the exact `contextualUser` arrays passed to the fake model, not only debug metadata.

## 12. Follow-up Implementation Plan

The implementation should be split into four independently revertible commits.

### Commit A: parser metadata and pure matcher

- Allowed files: `packages/core/src/memory/project-rules.ts`, `packages/core/src/memory/types.ts`, a new `packages/core/src/memory/project-rule-matcher.ts`, `packages/core/src/memory/index.ts`, and `packages/core/src/memory.test.ts`.
- Tests: all frontmatter combinations; malformed/unknown/empty fields; POSIX and Windows normalization; file/directory, `*`, `**`, `?`, traversal, case, pattern limits, and linear-adversarial inputs.
- Rollback point: reverting this commit restores parsing types with no loader/runtime behavior change.
- Non-goals: fragment filtering, runtime plumbing, prompt-debug UI, tool-derived paths.

### Commit B: discovery, activation filtering, budget, and debug model

- Allowed files: `packages/core/src/memory/project-rules.ts`, `packages/core/src/memory/project-instructions.ts`, `packages/core/src/memory/documents.ts`, `packages/core/src/memory/fragments.ts`, `packages/core/src/memory/types.ts`, `packages/core/src/prompt/debug.ts`, `packages/core/src/prompt/index.ts`, and `packages/core/src/memory.test.ts`.
- Tests: active bodies only enter documents/fragments; aggregate 128k all-or-nothing error; discovered-rule and total-pattern limits; exact status/reason schema; ordering and prompt-char exclusion.
- Rollback point: revert to unconditional document loading without changing caller/runtime input types.
- Non-goals: CLI flags, runtime state propagation, text extraction, tool-call accumulation, memory CRUD.

### Commit C: runtime and child/subagent context propagation

- Allowed files: `packages/core/src/runtime-service.ts`, `packages/core/src/subagent.ts`, `packages/core/src/runner.ts`, `packages/core/src/agent-runner.test.ts`, `packages/core/src/subagent.test.ts`, `apps/cli/src/harness.ts`, and `apps/cli/src/harness.test.ts`.
- Tests: first turn, consecutive tool turns, same-run goal continuation, later goal continuation, resume, child runtime, local subagent non-inheritance, and zero model calls on blocking budget error.
- Rollback point: remove the optional `contextPaths` plumbing while leaving the pure matcher and diagnostics unused.
- Non-goals: deriving paths from tools, persisting paths in events/goals, permissions/approval/sandbox changes.

### Commit D: prompt-debug surface and maintainer documentation

- Allowed files: `apps/cli/src/prompt-debug.ts`, `apps/cli/src/args.ts`, `apps/cli/src/args.test.ts`, `apps/cli/src/index.ts`, `apps/cli/src/harness.test.ts`, `docs/path-aware-rules-rfc.md`, and `docs/prompt-skills.md`.
- Tests: repeated `--context-file`/`--context-dir`, JSON schema, human statuses, `--content` exclusion, non-zero budget-error behavior, `bun run typecheck`, `bun test`, and canonical smoke gates.
- Rollback point: remove the CLI flags/output section without changing runtime matching.
- Non-goals: a rule catalog activation tool, UI path guessing, retrieval, or unrelated documentation cleanup.

Each commit must preserve `layer=contextual_user` and `trust=project` assertions. No stage should combine this work with unrelated memory or policy changes.

## 13. Non-goals

This documentation-only change and the v1 implementation do not include:

- natural-language or regex-based path extraction from prompts, conversation, pasted content, or tool output;
- vector retrieval or semantic rule selection;
- permission, approval, sandbox, or policy rules;
- a general YAML parser;
- model-driven rule catalog/`activate_rule` activation;
- tool-call `activePaths` accumulation or persistence (reserved for v2);
- persistence of `contextPaths` across runs, resume, goals, parent/child boundaries, or compaction;
- memory CRUD changes;
- additional rule discovery branches derived from `contextPaths`;
- dependency additions, runtime prototypes, or unrelated TODO cleanup in this RFC change.

An implementation is conforming only if another engineer can reproduce activation, normalization, ordering, debug reasons, lifecycle, and failure behavior from this document without choosing an unspecified core semantic.
