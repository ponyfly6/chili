import { useCallback, useMemo, useRef } from "react";

const DEFAULT_PROMPT_HISTORY_LIMIT = 50;

export interface PromptHistory {
  record: (text: string) => void;
  previous: (currentDraft: string) => string | undefined;
  next: (currentDraft: string) => string | undefined;
  resetNavigation: () => void;
}

export function usePromptHistory(limit = DEFAULT_PROMPT_HISTORY_LIMIT): PromptHistory {
  const entriesRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  const resetNavigation = useCallback(() => {
    historyIndexRef.current = -1;
    draftRef.current = "";
  }, []);

  const record = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const entries = entriesRef.current;
    if (entries.at(-1) === trimmed) {
      resetNavigation();
      return;
    }

    entriesRef.current = [...entries, trimmed].slice(-limit);
    resetNavigation();
  }, [limit, resetNavigation]);

  const previous = useCallback((currentDraft: string) => {
    const entries = entriesRef.current;
    if (entries.length === 0) return undefined;

    if (historyIndexRef.current === -1) {
      draftRef.current = currentDraft;
      historyIndexRef.current = entries.length - 1;
      return entries[historyIndexRef.current];
    }

    historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
    return entries[historyIndexRef.current];
  }, []);

  const next = useCallback((_currentDraft: string) => {
    const entries = entriesRef.current;
    if (entries.length === 0 || historyIndexRef.current === -1) return undefined;

    if (historyIndexRef.current >= entries.length - 1) {
      historyIndexRef.current = -1;
      const draft = draftRef.current;
      draftRef.current = "";
      return draft;
    }

    historyIndexRef.current = Math.min(entries.length - 1, historyIndexRef.current + 1);
    return entries[historyIndexRef.current];
  }, []);

  return useMemo(() => ({
    record,
    previous,
    next,
    resetNavigation,
  }), [next, previous, record, resetNavigation]);
}
