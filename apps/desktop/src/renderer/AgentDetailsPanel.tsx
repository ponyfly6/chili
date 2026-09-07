import { useEffect, useId, useMemo, useState } from "react";
import type { RuntimeAgentTaskRecord, RuntimeAgentTreeSnapshot } from "@chili/sdk";
import {
  AGENT_HISTORY_LIMIT,
  AGENT_TREE_PAGE_SIZE,
  agentDetailsScopeKey,
  agentDuration,
  agentListPage,
  agentStatusLabel,
  agentTaskRun,
  agentTextPreview,
  agentTextPage,
  buildAgentDetailsModel,
  visibleAgentRows,
  type AgentDetailsNode,
} from "./agent-details-model.js";
import "./agent-details-panel.css";

export interface AgentDetailsPanelProps {
  projectId: string | undefined;
  sessionId: string | undefined;
  tree: RuntimeAgentTreeSnapshot | undefined;
  tasks?: readonly RuntimeAgentTaskRecord[];
}

/** Remount at the scope boundary, before any previous selection can render. */
export function AgentDetailsPanel(props: AgentDetailsPanelProps) {
  return <ScopedAgentDetailsPanel key={agentDetailsScopeKey(props.projectId, props.sessionId)} {...props} />;
}

function ScopedAgentDetailsPanel({ tree, tasks, sessionId }: AgentDetailsPanelProps) {
  const model = useMemo(() => buildAgentDetailsModel(tree, tasks), [tree, tasks]);
  const [selection, setSelection] = useState<string>();
  // Roots are open by default, while nested delegated work stays compact.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [treePage, setTreePage] = useState(0);
  const openPaths = new Set([...model.roots.filter((path) => !collapsedRoots.has(path)), ...expanded]);
  const rows = visibleAgentRows(model, openPaths);
  const visibleRows = agentListPage(rows, treePage, AGENT_TREE_PAGE_SIZE);
  const selected = selection ? model.nodes.get(selection) : undefined;
  const titleId = useId();

  function toggle(path: string) {
    if (model.roots.includes(path)) {
      setCollapsedRoots((current) => toggleSet(current, path));
    } else {
      setExpanded((current) => toggleSet(current, path));
    }
  }

  return <section className="inspector-section agent-details-panel" aria-labelledby={titleId}>
    <div className="section-heading compact">
      <p className="eyebrow" id={titleId}>Delegated agents</p><span>{model.counts.total}</span>
    </div>
    {model.counts.total > 0 ? <div className="agent-details-counts" aria-label="Agent status counts">
      {(["running", "pending", "completed", "failed", "incomplete", "cancelled"] as const).map((status) => model.counts[status] > 0
        ? <span key={status} className={`agent-details-status agent-details-${status}`}>{model.counts[status]} {status}</span> : null)}
    </div> : null}
    {rows.length > 0 ? <ul className="agent-details-tree" aria-label="Delegated agent hierarchy">
      {visibleRows.items.map(({ node, depth }) => <li key={node.path} className={`agent-details-row${selected?.path === node.path ? " is-selected" : ""}`} style={{ paddingLeft: `${Math.min(depth, 6) * 12}px` }}>
        {node.children.length > 0 ? <button type="button" className="agent-details-toggle" aria-label={`${openPaths.has(node.path) ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={openPaths.has(node.path)} onClick={() => toggle(node.path)}>
          <span aria-hidden="true">{openPaths.has(node.path) ? "▾" : "▸"}</span>
        </button> : <span className="agent-details-toggle-spacer" />}
        <button type="button" className="agent-details-select" aria-pressed={selected?.path === node.path} onClick={() => setSelection(node.path)} title={node.path}>
          <span className={`agent-details-dot agent-details-${node.status}`} aria-hidden="true" />
          <span className="agent-details-row-copy"><strong>{node.name}</strong><span>{agentStatusLabel(node.status)}{node.children.length > 0 ? ` · ${node.children.length} nested` : ""}</span></span>
        </button>
      </li>)}
    </ul> : <p className="empty-copy">{!sessionId ? "Select a task to inspect delegated work." : !tree ? "Loading delegated agents…" : "No agents delegated yet."}</p>}
    <AgentPagination label="Agent tree" page={visibleRows.page} total={visibleRows.total} onChange={setTreePage} />
    {selected ? <AgentDetail key={selected.path} node={selected} onClose={() => setSelection(undefined)} /> : rows.length > 0 ? <p className="agent-details-hint">Select an agent to inspect its task and result.</p> : null}
  </section>;
}

function AgentDetail({ node, onClose }: { node: AgentDetailsNode; onClose: () => void }) {
  const [taskId, setTaskId] = useState<string>();
  const [taskPage, setTaskPage] = useState(0);
  const visibleTasks = agentListPage(node.tasks, taskPage, AGENT_HISTORY_LIMIT);
  const task = visibleTasks.items.find((item) => item.id === taskId) ?? visibleTasks.items[0];
  const run = agentTaskRun(node, task);
  const now = useAgentClock(node.status === "running" || node.status === "pending");
  const titleId = useId();
  const queued = node.mailbox.filter((message) => message.status === "queued" || message.status === "delivering").length;

  return <section className="agent-details-card" aria-labelledby={titleId}>
    <div className="agent-details-heading"><strong id={titleId}>{node.name}</strong><button type="button" className="agent-details-close" aria-label="Close agent details" onClick={onClose}>×</button></div>
    <p className="agent-details-path">{node.path}</p>
    <span className={`agent-details-status agent-details-${node.status}`}>{agentStatusLabel(node.status)}</span>
    <dl className="agent-details-facts">
      <div><dt>Runs</dt><dd>{node.runs.length}</dd></div>
      <div><dt>Tasks</dt><dd>{node.tasks.length}</dd></div>
      <div><dt>Nested agents</dt><dd>{node.children.length}</dd></div>
      <div><dt>Pending messages</dt><dd>{queued}</dd></div>
    </dl>
    {node.tasks.length > 1 ? <label className="agent-details-task-picker">Task history
      <select value={task?.id ?? ""} onChange={(event) => setTaskId(event.currentTarget.value)}>
        {visibleTasks.items.map((item, index) => <option key={item.id} value={item.id}>{index === 0 && visibleTasks.page === 0 ? "Latest · " : ""}{agentTextPreview(item.taskName, 50)} · {agentStatusLabel(item.status)}</option>)}
      </select>
    </label> : null}
    <AgentPagination label="Task history" page={visibleTasks.page} total={visibleTasks.total} onChange={(page) => { setTaskPage(page); setTaskId(undefined); }} />
    {task ? <div key={`${task.id}:${task.generation}`} className="agent-details-task">
      <dl className="agent-details-facts agent-details-times">
        <div><dt>Task status</dt><dd>{agentStatusLabel(task.status)}</dd></div>
        <div><dt>Generation</dt><dd>{task.generation}</dd></div>
        <div><dt>Created</dt><dd><AgentTime value={task.createdAt} /></dd></div>
        <div><dt>Updated</dt><dd><AgentTime value={task.updatedAt} /></dd></div>
        {task.completedAt !== undefined ? <div><dt>Finished</dt><dd><AgentTime value={task.completedAt} /></dd></div> : null}
        {run ? <div><dt>Run duration</dt><dd>{run.completedAt !== undefined || run.status === "running" || task.completedAt !== undefined ? agentDuration(run.createdAt, run.completedAt ?? (run.status === "running" ? undefined : task.completedAt), now) : "Unavailable"}{run.status === "running" ? " · running" : ""}</dd></div> : null}
        {task.mode ? <div><dt>Mode</dt><dd>{task.mode}</dd></div> : null}
      </dl>
      {task.prompt ? <AgentTextDisclosure label="Task instructions" text={task.prompt} /> : <p className="agent-details-hint">Task instructions are unavailable in this snapshot.</p>}
      {task.summary ? <AgentTextDisclosure label="Result" text={task.summary} previewLimit={240} /> : <p className="agent-details-hint">{task.status === "pending" || task.status === "running" ? "The result will appear when the agent reports back." : "No result was recorded."}</p>}
      {task.error ? <AgentTextDisclosure label="Error" text={task.error} error /> : null}
    </div> : <p className="agent-details-hint">{node.children.length > 0 ? "Expand this agent to inspect delegated tasks." : "No task details were included in this snapshot."}</p>}
    {node.runs.length > 0 ? <AgentRunHistory node={node} now={now} /> : null}
  </section>;
}

export function AgentTextDisclosure({ label, text, previewLimit = 160, error = false }: { label: string; text: string; previewLimit?: number; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ source: text, starts: [0], page: 0 });
  const current = position.source === text ? position : { source: text, starts: [0], page: 0 };
  const contentId = useId();
  const section = open ? agentTextPage(text, current.starts[current.page] ?? 0) : undefined;
  return <div className={`agent-details-disclosure${error ? " agent-details-error" : ""}`}>
    <button type="button" className="agent-details-disclosure-toggle" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? "▾" : "▸"}</span>{label}</button>
    {section ? <div id={contentId}><pre key={section.start} role="region" tabIndex={0} aria-label={`${label} text`}>{section.text}</pre>{section.hasNext || current.page > 0 ? <>
      <div className="agent-details-pagination" aria-label={`${label} sections`}>
        <button type="button" disabled={current.page === 0} onClick={() => setPosition({ ...current, page: current.page - 1 })} aria-label={`Previous ${label.toLowerCase()} section`}>Previous</button>
        <span aria-live="polite">Section {current.page + 1}</span>
        <button type="button" disabled={!section.hasNext} onClick={() => setPosition({ source: text, starts: [...current.starts.slice(0, current.page + 1), section.end], page: current.page + 1 })} aria-label={`Next ${label.toLowerCase()} section`}>Next</button>
      </div><p className="agent-details-hint">Long text is split into sections. Continue to read the full recorded text.</p>
    </> : null}</div> : <p className="agent-details-preview">{agentTextPreview(text, previewLimit)}</p>}
  </div>;
}

function AgentRunHistory({ node, now }: { node: AgentDetailsNode; now: number }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const runs = agentListPage(node.runs, page, AGENT_HISTORY_LIMIT);
  const historyId = useId();
  return <div className="agent-details-disclosure">
    <button type="button" className="agent-details-disclosure-toggle" aria-expanded={open} aria-controls={historyId} onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? "▾" : "▸"}</span>Run history <span className="agent-details-history-count">{node.runs.length}</span></button>
    {open ? <div id={historyId} className="agent-details-run-history"><ol>
      {runs.items.map((run) => <li key={run.id}>
        <div><span className={`agent-details-status agent-details-${run.status}`}>{agentStatusLabel(run.status)}</span><span>{run.completedAt !== undefined || run.status === "running" ? agentDuration(run.createdAt, run.completedAt, now) : "Duration unavailable"}</span></div>
        <AgentTime value={run.createdAt} />
        <code>{run.id}</code>
      </li>)}
    </ol><AgentPagination label="Run history" page={runs.page} total={runs.total} onChange={setPage} /></div> : null}
  </div>;
}

function AgentPagination({ label, page, total, onChange }: { label: string; page: number; total: number; onChange: (page: number) => void }) {
  return total > 1 ? <nav className="agent-details-pagination" aria-label={`${label} pages`}>
    <button type="button" disabled={page === 0} aria-label={`Previous ${label.toLowerCase()} page`} onClick={() => onChange(page - 1)}>Previous</button>
    <span aria-live="polite">{page + 1} / {total}</span>
    <button type="button" disabled={page + 1 === total} aria-label={`Next ${label.toLowerCase()} page`} onClick={() => onChange(page + 1)}>Next</button>
  </nav> : null;
}

function AgentTime({ value }: { value: number }) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : <>Unavailable</>;
}

function useAgentClock(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
