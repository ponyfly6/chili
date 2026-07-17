import { expect, test } from "bun:test";
import type { MessageId, PartId } from "@chili/protocol";
import type { ChatTranscriptItem } from "@chili/sdk";
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
