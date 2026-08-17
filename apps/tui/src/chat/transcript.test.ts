import { expect, test } from "bun:test";
import type { MessageId, PartId, ToolCallId } from "@chili/protocol";
import type { ChatToolExecutionContext, ChatTranscriptItem } from "@chili/sdk";
import { buildTranscriptText } from "./transcript.js";

test("diagnostic transcript labels every assistant text phase explicitly", () => {
  const items: ChatTranscriptItem[] = [{
    id: "message_transcript_phases" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_transcript_commentary" as PartId, text: "Checking.", phase: "commentary" },
      { type: "text", id: "part_transcript_final" as PartId, text: "Done.", phase: "final_answer" },
      { type: "text", id: "part_transcript_unclassified" as PartId, text: "Provider text." },
    ],
  }];

  const transcript = buildTranscriptText(items);

  expect(transcript).toContain("part text part_transcript_commentary phase=commentary:");
  expect(transcript).toContain("part text part_transcript_final phase=final_answer:");
  expect(transcript).toContain("part text part_transcript_unclassified phase=unclassified:");
});

test("diagnostic transcript does not label user text with an assistant phase", () => {
  const items: ChatTranscriptItem[] = [{
    id: "message_transcript_user" as MessageId,
    kind: "message",
    role: "user",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_transcript_user" as PartId, text: "Hello." },
    ],
  }];

  const transcript = buildTranscriptText(items);

  expect(transcript).toContain("part text part_transcript_user:");
  expect(transcript).not.toContain("part_transcript_user phase=");
});

test("diagnostic transcript exposes only controlled tool execution context", () => {
  const callId = "tool_transcript_execution" as ToolCallId;
  const executionContext = {
    executionMode: "unsandboxed",
    sandbox: "none",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    signal: null,
    internalMetadata: "must not leak",
  } satisfies ChatToolExecutionContext & { internalMetadata: string };
  const items: ChatTranscriptItem[] = [
    {
      id: "message_transcript_execution" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [{
        type: "tool_result",
        id: "part_transcript_execution" as PartId,
        callId,
        output: "ok",
        executionContext,
      }],
    },
    {
      id: callId,
      kind: "tool",
      toolName: "bash",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 2,
      inputSummary: { title: "bash", command: "echo ok" },
      executionContext,
    },
  ];

  const transcript = buildTranscriptText(items);

  expect(transcript).toContain("executionContext:");
  expect(transcript).toContain("executionMode: unsandboxed");
  expect(transcript).toContain("sandbox: none");
  expect(transcript).toContain("exitCode: 0");
  expect(transcript).toContain("timedOut: false");
  expect(transcript).toContain("aborted: false");
  expect(transcript).toContain("signal: null");
  expect(transcript).not.toContain("internalMetadata");
  expect(transcript).not.toContain("must not leak");
});
