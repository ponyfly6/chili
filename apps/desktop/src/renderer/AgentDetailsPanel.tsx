import { useId, useMemo, useRef, useState } from "react";
import type { RuntimeInputQueue } from "@chili/protocol";
import type { RuntimeAgentRecord } from "@chili/sdk";
import {
  AGENT_RECEIPT_PAGE_SIZE,
  AGENT_TREE_PAGE_SIZE,
  agentDetailsScopeKey,
  agentListPage,
  agentStateLabel,
  buildAgentDetailsModel,
  visibleAgentRows,
  type AgentDetailsNode,
} from "./agent-details-model.js";
import "./agent-details-panel.css";

interface AgentControls {
  onStop?: ((agentId: string) => Promise<void>) | undefined;
  onResume?: ((agentId: string) => Promise<void>) | undefined;
  onSend?: ((agentId: string, text: string, mode: "queue" | "steer") => Promise<void>) | undefined;
}

export interface AgentDetailsPanelProps extends AgentControls {
  projectId: string | undefined;
  sessionId: string | undefined;
  agents?: readonly RuntimeAgentRecord[] | undefined;
  inputQueues?: Readonly<Record<string, RuntimeInputQueue>> | undefined;
}

/** Remount at the scope boundary, before any previous selection can render. */
export function AgentDetailsPanel(props: AgentDetailsPanelProps) {
  return <ScopedAgentDetailsPanel key={agentDetailsScopeKey(props.projectId, props.sessionId)} {...props} />;
}

function ScopedAgentDetailsPanel({ agents, inputQueues, sessionId, onStop, onResume, onSend }: AgentDetailsPanelProps) {
  const model = useMemo(() => buildAgentDetailsModel(agents), [agents]);
  const [selection, setSelection] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [treePage, setTreePage] = useState(0);
  const openAgents = new Set([...model.roots.filter((agentId) => !collapsedRoots.has(agentId)), ...expanded]);
  const rows = visibleAgentRows(model, openAgents);
  const visibleRows = agentListPage(rows, treePage, AGENT_TREE_PAGE_SIZE);
  const selected = selection ? model.nodes.get(selection) : undefined;
  const titleId = useId();

  function toggle(agentId: string) {
    if (model.roots.includes(agentId)) {
      setCollapsedRoots((current) => toggleSet(current, agentId));
    } else {
      setExpanded((current) => toggleSet(current, agentId));
    }
  }

  return <section className="inspector-section agent-details-panel" aria-labelledby={titleId}>
    <div className="section-heading compact">
      <p className="eyebrow" id={titleId}>Agents</p><span>{model.counts.total}</span>
    </div>
    {model.counts.total > 0 ? <div className="agent-details-counts" aria-label="Agent state counts">
      {(["running", "idle", "paused"] as const).map((state) => model.counts[state] > 0
        ? <span key={state} className={`agent-details-status agent-details-${state}`}>{model.counts[state]} {state}</span> : null)}
    </div> : null}
    {rows.length > 0 ? <ul className="agent-details-tree" aria-label="Agent hierarchy">
      {visibleRows.items.map(({ node, depth }) => <li key={node.agentId} className={`agent-details-row${selected?.agentId === node.agentId ? " is-selected" : ""}`} style={{ paddingLeft: `${Math.min(depth, 6) * 12}px` }}>
        {node.children.length > 0 ? <button type="button" className="agent-details-toggle" aria-label={`${openAgents.has(node.agentId) ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={openAgents.has(node.agentId)} onClick={() => toggle(node.agentId)}>
          <span aria-hidden="true">{openAgents.has(node.agentId) ? "▾" : "▸"}</span>
        </button> : <span className="agent-details-toggle-spacer" />}
        <button type="button" className="agent-details-select" aria-pressed={selected?.agentId === node.agentId} onClick={() => setSelection(node.agentId)} title={`${node.path}\n${node.agentId}`}>
          <span className={`agent-details-dot agent-details-${node.state}`} aria-hidden="true" />
          <span className="agent-details-row-copy"><strong>{node.name}</strong><span>{agentStateLabel(node.state)}{node.children.length > 0 ? ` · ${node.children.length} nested` : ""}</span></span>
        </button>
      </li>)}
    </ul> : <p className="empty-copy">{!sessionId ? "Select a session to inspect its agents." : !agents ? "Loading agents…" : "No agents created yet."}</p>}
    <AgentPagination label="Agent tree" page={visibleRows.page} total={visibleRows.total} onChange={setTreePage} />
    {selected ? <AgentDetailsCard key={selected.agentId} node={selected} inputQueue={inputQueues?.[selected.agentId]} onClose={() => setSelection(undefined)} onStop={onStop} onResume={onResume} onSend={onSend} /> : rows.length > 0 ? <p className="agent-details-hint">Select an agent to inspect its identity and input receipts.</p> : null}
  </section>;
}

export function AgentDetailsCard({ node, inputQueue, onClose, onStop, onResume, onSend }: AgentControls & {
  node: AgentDetailsNode;
  inputQueue?: RuntimeInputQueue | undefined;
  onClose: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const modeId = useId();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [pending, setPending] = useState<"pause" | "resume" | "send">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const actionPending = useRef(false);
  const paused = node.state === "paused";
  const control = paused ? onResume : onStop;

  async function act(action: "pause" | "resume" | "send", callback: () => Promise<void>, success: string) {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(action);
    setError(undefined);
    setNotice(undefined);
    try {
      await callback();
      if (action === "send") setText("");
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionPending.current = false;
      setPending(undefined);
    }
  }

  return <section className="agent-details-card" aria-labelledby={titleId} aria-busy={pending !== undefined}>
    <div className="agent-details-heading"><strong id={titleId}>{node.name}</strong><button type="button" className="agent-details-close" aria-label="Close agent details" onClick={onClose}>×</button></div>
    <p className="agent-details-path">{node.path}</p>
    <span className={`agent-details-status agent-details-${node.state}`}>{agentStateLabel(node.state)}</span>
    <dl className="agent-details-facts">
      <div><dt>Agent ID</dt><dd>{node.agentId}</dd></div>
      {node.parentAgentId ? <div><dt>Parent agent ID</dt><dd>{node.parentAgentId}</dd></div> : null}
      <div><dt>Nested agents</dt><dd>{node.children.length}</dd></div>
    </dl>
    {control ? <div className="agent-details-actions"><button type="button" disabled={pending !== undefined} onClick={() => void act(paused ? "resume" : "pause", () => control(node.agentId), paused ? "Continue requested." : "Pause requested.")}>
      {pending === "resume" ? "Continuing…" : pending === "pause" ? "Pausing…" : paused ? "Continue agent" : "Pause agent"}
    </button></div> : null}
    {onSend ? <form className="agent-details-message" onSubmit={(event) => {
      event.preventDefault();
      if (text.trim()) void act("send", () => onSend(node.agentId, text.trim(), mode), "Message submitted.");
    }}>
      <label htmlFor={messageId}>Message</label>
      <textarea id={messageId} value={text} onChange={(event) => setText(event.currentTarget.value)} disabled={pending !== undefined} rows={3} />
      <div className="agent-details-message-controls">
        <label htmlFor={modeId}>Send mode</label>
        <select id={modeId} value={mode} onChange={(event) => setMode(event.currentTarget.value === "steer" ? "steer" : "queue")} disabled={pending !== undefined}>
          <option value="queue">Queue</option><option value="steer">Steer</option>
        </select>
        <button type="submit" disabled={pending !== undefined || !text.trim()}>{pending === "send" ? "Sending…" : "Send message"}</button>
      </div>
    </form> : null}
    {error ? <p className="agent-details-action-error" role="alert">{error}</p> : null}
    {notice ? <p className="agent-details-hint" role="status">{notice}</p> : null}
    <AgentInputReceipts queue={inputQueue} />
  </section>;
}

function AgentInputReceipts({ queue }: { queue: RuntimeInputQueue | undefined }) {
  const [page, setPage] = useState(0);
  const receipts = agentListPage(queue?.items ?? [], page, AGENT_RECEIPT_PAGE_SIZE);
  const titleId = useId();
  return <section className="agent-details-receipts" aria-labelledby={titleId}>
    <div className="agent-details-receipts-heading"><strong id={titleId}>Input receipts</strong>{queue ? <span>{queue.pendingCount} pending</span> : null}</div>
    {receipts.items.length > 0 ? <ol>
      {receipts.items.map((input) => <li key={input.inputId}>
        <code>{input.inputId}</code>
        <span>{input.state} · {input.mode}{input.outcome ? ` · ${input.outcome}` : ""}</span>
        {input.error ? <p className="agent-details-action-error">{input.error}</p> : null}
      </li>)}
    </ol> : <p className="agent-details-hint">{queue ? "No queued input receipts." : "Input receipts are unavailable."}</p>}
    <AgentPagination label="Input receipts" page={receipts.page} total={receipts.total} onChange={setPage} />
  </section>;
}

function AgentPagination({ label, page, total, onChange }: { label: string; page: number; total: number; onChange: (page: number) => void }) {
  return total > 1 ? <nav className="agent-details-pagination" aria-label={`${label} pages`}>
    <button type="button" disabled={page === 0} aria-label={`Previous ${label.toLowerCase()} page`} onClick={() => onChange(page - 1)}>Previous</button>
    <span aria-live="polite">{page + 1} / {total}</span>
    <button type="button" disabled={page + 1 === total} aria-label={`Next ${label.toLowerCase()} page`} onClick={() => onChange(page + 1)}>Next</button>
  </nav> : null;
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
