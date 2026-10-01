import { useId, useState, type ReactNode } from "react";
import type { RuntimeSessionSummary } from "@chili/sdk";

export const SESSION_PAGE_SIZE = 5;

export function SessionList({ sessions, selectedId, initialLimit = SESSION_PAGE_SIZE, children }: {
  sessions: readonly RuntimeSessionSummary[];
  selectedId: string | undefined;
  initialLimit?: number;
  children: (session: RuntimeSessionSummary) => ReactNode;
}) {
  const [limit, setLimit] = useState(initialLimit);
  const listId = useId();
  const visible = sessions.slice(0, limit);
  // Keep an older, selected conversation visible without growing the initial list.
  const selected = sessions.find((session) => session.id === selectedId);
  if (selected && !visible.some((session) => session.id === selectedId)) visible.splice(-1, 1, selected);
  const remaining = sessions.length - visible.length;
  return <>
    <div className="session-list" id={listId}>{visible.map(children)}</div>
    {remaining > 0 || limit > SESSION_PAGE_SIZE && sessions.length > SESSION_PAGE_SIZE ? <div className="session-list-controls">
      {remaining > 0 ? <button className="session-list-more" type="button" aria-controls={listId}
        onClick={() => setLimit((value) => value + SESSION_PAGE_SIZE)}>展开更多会话<span>{remaining}</span></button> : null}
      {limit > SESSION_PAGE_SIZE ? <button className="session-list-less" type="button" aria-controls={listId}
        onClick={() => setLimit(SESSION_PAGE_SIZE)}>收起更多会话</button> : null}
    </div> : null}
  </>;
}
