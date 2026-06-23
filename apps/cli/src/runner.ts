import type { ModelSelection, ReasoningLevel, ServiceTier, SessionId, ThreadId } from "@chili/protocol";
import type { CliHarness } from "./harness.js";

export interface RunPromptOptions {
  harness: CliHarness;
  sessionId: SessionId;
  threadId: ThreadId;
  prompt: string;
  maxTurns: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  signal?: AbortSignal;
}

export async function runPrompt(options: RunPromptOptions): Promise<void> {
  const input = {
    sessionId: options.sessionId,
    threadId: options.threadId,
    text: options.prompt,
    maxTurns: options.maxTurns,
  };
  if (options.modelSelection) Object.assign(input, { modelSelection: options.modelSelection });
  if (options.reasoningLevel !== undefined) Object.assign(input, { reasoningLevel: options.reasoningLevel });
  if (options.serviceTier !== undefined) Object.assign(input, { serviceTier: options.serviceTier });
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
