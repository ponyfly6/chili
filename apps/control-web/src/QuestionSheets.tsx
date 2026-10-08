import { useEffect, useRef, useState } from "react";
import { InputRequestCard, type InputAnswerDraft } from "./InputRequestCard.js";
import { Sheet } from "./Sheet.js";
import type { RemoteInputRequest } from "./view-model.js";

export interface QuestionSheetsProps {
  sessionId: string | null;
  requests: RemoteInputRequest[];
  openRequestId: string | null;
  onOpenChange: (id: string | null) => void;
  disabled: boolean;
  pendingId: string | null;
  unknownInputIds: readonly string[];
  onAnswer: (inputId: string, answers: Record<string, string[]>) => Promise<void> | void;
}

interface SavedDraft {
  signature: string;
  draft: InputAnswerDraft;
}

function requestSignature(request: RemoteInputRequest): string {
  return JSON.stringify([request.createdAt, request.questions]);
}

/** Mount once for the paired workspace, including while another task is shown. */
export function QuestionSheets(props: QuestionSheetsProps) {
  const { sessionId, requests, openRequestId, onOpenChange, disabled, pendingId, unknownInputIds } = props;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, SavedDraft>>(() => new Map());
  const [submitting, setSubmitting] = useState<{ sessionId: string; requestId: string } | null>(null);
  const submitPendingRef = useRef(false);
  const latestRef = useRef(props);
  latestRef.current = props;

  useEffect(() => {
    if (openRequestId !== null && (sessionId === null || !requests.some((request) => request.id === openRequestId))) {
      onOpenChange(null);
    }
  }, [sessionId, requests, openRequestId, onOpenChange]);

  useEffect(() => {
    if (sessionId === null) return;
    setDrafts((previous) => {
      let next: Map<string, SavedDraft> | undefined;
      for (const request of requests) {
        const key = JSON.stringify([sessionId, request.id]);
        const saved = previous.get(key);
        if (saved && saved.signature !== requestSignature(request)) {
          next ??= new Map(previous);
          next.delete(key);
        }
      }
      return next ?? previous;
    });
  }, [sessionId, requests]);

  if (sessionId === null) return null;
  const activeSessionId = sessionId;

  function isCurrentRequest(request: RemoteInputRequest, signature: string) {
    const current = latestRef.current;
    return current.sessionId === activeSessionId
      && current.requests.some((candidate) => candidate.id === request.id && requestSignature(candidate) === signature);
  }

  async function answer(request: RemoteInputRequest, signature: string, answers: Record<string, string[]>) {
    const current = latestRef.current;
    if (!isCurrentRequest(request, signature) || current.disabled || current.pendingId !== null
      || current.unknownInputIds.includes(request.id) || submitPendingRef.current) return;
    submitPendingRef.current = true;
    setSubmitting({ sessionId: activeSessionId, requestId: request.id });
    try {
      await current.onAnswer(request.id, answers);
    } finally {
      submitPendingRef.current = false;
      setSubmitting(null);
    }
  }

  return <>{requests.map((request) => {
    const key = JSON.stringify([sessionId, request.id]);
    const signature = requestSignature(request);
    const savedDraft = drafts.get(key);
    const draft = savedDraft?.signature === signature ? savedDraft.draft : {};
    const unknown = unknownInputIds.includes(request.id);
    const pending = pendingId === request.id || (submitting?.sessionId === sessionId && submitting.requestId === request.id);
    return (
      <Sheet key={key} open={openRequestId === request.id} title="需要你的回答" onClose={() => onOpenChange(null)}>
        <div className="question-sheet" data-request-id={request.id}>
          <p className="question-sheet-intro">回答以下问题，让任务继续。暂时关闭会保留已填写的回答。</p>
          {unknown && <p className="question-sheet-notice" role="alert">这次回答的送达结果尚未确认。请读取任务或回到电脑核对后继续。</p>}
          <InputRequestCard
            key={signature}
            request={request}
            draft={draft}
            onDraftChange={(nextDraft) => {
              if (!isCurrentRequest(request, signature)) return;
              setDrafts((previous) => new Map(previous).set(key, { signature, draft: nextDraft }));
            }}
            disabled={disabled || unknown || pendingId !== null || submitting !== null}
            pending={pending}
            onAnswer={(answers) => answer(request, signature, answers)}
          />
        </div>
      </Sheet>
    );
  })}</>;
}
