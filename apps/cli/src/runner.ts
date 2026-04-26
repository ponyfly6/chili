import type { SessionId, ThreadId } from "@chili/protocol";
import type { CliHarness } from "./harness.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are Chili, a terminal-first coding agent working inside a real repository.",
  "Use tools for repository inspection, glob/grep search, shell commands, writes, edits, patch application, and git diffs.",
  "Read existing files fully before editing or overwriting them. Prefer small, precise edits. Keep final responses concise.",
  "When you use tools, continue after tool results until the user request is genuinely handled.",
].join("\n");

export interface RunPromptOptions {
  harness: CliHarness;
  sessionId: SessionId;
  threadId: ThreadId;
  prompt: string;
  maxTurns: number;
  signal?: AbortSignal;
}

export async function runPrompt(options: RunPromptOptions): Promise<void> {
  const input = {
    sessionId: options.sessionId,
    threadId: options.threadId,
    text: options.prompt,
    maxTurns: options.maxTurns,
    system: [DEFAULT_SYSTEM_PROMPT],
  };
  const result = await options.harness.service.submitPrompt(
    options.signal ? { ...input, signal: options.signal } : input,
  );

  console.log("");
  if (result.status === "failed" || result.status === "cancelled") {
    console.error(`[turn:${result.status}] ${result.error?.message ?? "unknown error"}`);
    return;
  }

  if (result.status === "max_turns") {
    console.error("[warning] stopped after max continuation turns");
    return;
  }

  if (result.finishReason === "max_tokens") {
    console.error("[warning] model stopped at max_tokens");
  }
}
