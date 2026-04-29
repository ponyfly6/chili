import type { ApprovalId, MessageId, SessionId, ThreadId, TurnId } from "./ids.js";

export type RuntimeSessionStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "cancelled"
  | "failed";

export type RuntimeCommand =
  | RuntimeCreateSessionCommand
  | RuntimeSubmitPromptCommand
  | RuntimeInterruptCommand
  | RuntimeResolveApprovalCommand
  | RuntimeArchiveSessionCommand;

export interface RuntimeCreateSessionCommand {
  type: "session.create";
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd: string;
}

export interface RuntimeSubmitPromptCommand {
  type: "session.prompt";
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  maxTurns?: number;
  system?: string[];
}

export interface RuntimeInterruptCommand {
  type: "session.interrupt";
  sessionId: SessionId;
  reason?: string;
}

export interface RuntimeResolveApprovalCommand {
  type: "approval.resolve";
  approvalId: ApprovalId;
  decision: "allow_once" | "allow_always" | "deny";
  feedback?: string;
}

export interface RuntimeArchiveSessionCommand {
  type: "session.archive";
  sessionId: SessionId;
}

export interface RuntimeStatusPayload {
  sessionId: SessionId;
  status: RuntimeSessionStatus;
  turnId?: TurnId;
  reason?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export interface ModelMetadataPayload {
  turnId: TurnId;
  provider?: string;
  model?: string;
  responseId?: string;
  usage?: ModelUsage;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface RuntimeSessionRef {
  sessionId: SessionId;
  threadId: ThreadId;
}

export interface RuntimePromptAccepted {
  status: "accepted";
  sessionId: SessionId;
  threadId: ThreadId;
}

export interface RuntimeInterruptResult {
  interrupted: boolean;
}

export interface RuntimeApprovalResolveResult {
  resolved: boolean;
}

export type RuntimePromptResult =
  | {
      status: "completed";
      turns: RuntimeTurnResult[];
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled" | "max_turns";
      turns: RuntimeTurnResult[];
      error?: RuntimeError;
      finishReason?: string;
    };

export type RuntimeTurnResult =
  | {
      status: "completed";
      turnId: TurnId;
      assistantMessageId: MessageId;
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled";
      turnId: TurnId;
      assistantMessageId?: MessageId;
      error: RuntimeError;
    };

export interface RuntimeError {
  name: string;
  message: string;
}
