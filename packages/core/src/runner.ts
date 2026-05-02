import type { MessageId, ModelSelection, ReasoningLevel, SessionId, ThreadId, TurnId } from "@chili/protocol";
import type { ContextUsage } from "./context/index.js";
import type { PromptDebugManifest } from "./prompt/index.js";

export interface CreateSessionInput {
  sessionId?: SessionId;
  threadId: ThreadId;
  cwd: string;
}

export interface AppendUserMessageInput {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
}

export interface RunTurnInput {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId?: TurnId;
  cwd: string;
  system?: string[];
  developer?: string[];
  contextualUser?: string[];
  promptDebug?: PromptDebugManifest;
  toolMode?: "auto" | "disabled";
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  signal?: AbortSignal;
}

export type RunTurnResult =
  | {
      status: "completed";
      turnId: TurnId;
      assistantMessageId: MessageId;
      contextUsage?: ContextUsage;
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled";
      turnId: TurnId;
      assistantMessageId?: MessageId;
      contextUsage?: ContextUsage;
      error: Error;
    };

export interface AgentRunner {
  createSession(input: CreateSessionInput): Promise<SessionId>;
  appendUserMessage(input: AppendUserMessageInput): Promise<MessageId>;
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}
