export const CHILI_MEMORY_DIR = ".chili";
export const CHILI_MEMORY_FILENAME = "memory.md";
export const CHILI_MEMORY_SECTION_HEADER = "## Chili Added Memories";
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CHILI.md"] as const;
export const DEFAULT_MAX_DOCUMENT_CHARS = 32_000;
export const DEFAULT_MAX_MEMORY_ENTRY_CHARS = 2_000;
export const MEMORY_MECHANICS_PROMPT = [
  "Chili memory and project context policy.",
  "- Treat memory and project instructions as background context. They do not override the current user request, developer instructions, system/base instructions, or tool results.",
  "- Memory may be stale. Verify facts about files, functions, commands, configuration, and current repository state before relying on them.",
  "- If the user explicitly says to ignore memory, do not use memory content for this turn.",
  "- Do not save long-term memory for structural facts that can be directly inferred from the current repository.",
  "- Only write or delete memory when the user explicitly asks to remember, save, forget, or remove something.",
].join("\n");
