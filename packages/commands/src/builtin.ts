import { defineCommand } from "./registry.js";
import { expandPromptTemplate } from "./template.js";
import type { CommandDefinition } from "./types.js";

const INIT_ALLOWED_TOOLS = ["read", "glob", "grep", "git_status", "git_diff", "edit", "write", "apply_patch", "tool_search"] as const;
const INIT_WRITE_SCOPE = ["AGENTS.md"] as const;

const INIT_PROMPT = `You are running Chili's /init command for this repository.

Goal: create or update the repository agent instruction file. The default target artifact is AGENTS.md, and the document title must be exactly:

# Repository Guidelines

User focus arguments, if any: $ARGUMENTS

Instructions:
- Inspect the repository before writing. Use Chili's dedicated read-only repository tools for the survey: read, glob, grep, git_status, and git_diff. Do not use shell commands for repository discovery or file inspection.
- Verify facts from local files such as README*, package manifests, workspace configuration, lockfiles, build/test/lint/typecheck config, CI configuration, and existing instruction files including AGENTS.md, CHILI.md, CLAUDE.md, GEMINI.md, .cursor/rules, and .github/copilot-instructions.md.
- Prefer executable sources over prose when they conflict, for example package scripts, config files, CI jobs, and checked-in tests.
- Include only repo-specific, actionable guidance. Avoid generic advice that would apply to any repository.
- If user focus arguments are present, honor them while still keeping the file useful as general repository guidance.
- If AGENTS.md exists, improve it in place without blind overwrite. Preserve verified useful guidance, remove stale or generic claims, and keep unrelated user content that is still accurate.
- If AGENTS.md does not exist, create it only after you have inspected enough repository facts to write high-signal guidance. Do not pre-create an empty file or placeholder.
- Only write AGENTS.md. If a useful fact cannot be verified with the available read-only tools, mention that uncertainty instead of requesting broader tool permissions.
- Do not generate .chili/memory.md or .chili/rules by default.

Suggested sections:
- Project Structure & Module Organization
- Build, Test, and Development Commands
- Coding Style & Naming Conventions
- Testing Guidelines
- Agent Workflow Notes
- Security & Configuration Tips

After editing, summarize what you changed and mention any repository facts you could not verify.`;

export const initCommand: CommandDefinition = defineCommand({
  name: "init",
  category: "builtin",
  description: "Create or update AGENTS.md repository guidelines",
  source: "builtin",
  argumentHint: "[focus]",
  argumentMode: "optional",
  supportsNonInteractive: true,
  isSafeConcurrent: true,
  run: (_ctx, args) => ({
    type: "prompt",
    prompt: expandPromptTemplate(INIT_PROMPT, args),
    metadata: {
      commandName: "init",
      source: "builtin",
      allowedTools: INIT_ALLOWED_TOOLS,
      writeScope: INIT_WRITE_SCOPE,
    },
  }),
});

export const builtinCommands: readonly CommandDefinition[] = [initCommand];
