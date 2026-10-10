import { useMemo, useState, type ReactNode } from "react";
import { buildProgressModel, progressStateLabel, type ProgressItem, type ProgressModelInput } from "./progress-model.js";
import "./progress-panel.css";

export interface ProgressPanelProps extends ProgressModelInput {
  renderHistory?: ((agentId: string) => ReactNode) | undefined;
  projectId: string | undefined;
  onStop?: ((agentId: string) => Promise<void>) | undefined;
  onResume?: ((agentId: string) => Promise<void>) | undefined;
}
export function ProgressPanel(props: ProgressPanelProps) {
  return <ScopedProgressPanel key={JSON.stringify([props.projectId ?? null, props.sessionId ?? null])} {...props} />;
}
function ScopedProgressPanel({ renderHistory, onStop, onResume, ...input }: ProgressPanelProps) {
  const [selected, setSelected] = useState<string>();
  const model = useMemo(() => buildProgressModel(input), [input.agents, input.inputQueues, input.runtime, input.sessionId, input.workItems, input.pendingQuestions]);
  const task = model.tasks.find((item) => item.id === selected);
  if (task) return <section className="progress-panel is-detail" aria-label="子任务详情">
    <button className="progress-back" onClick={() => setSelected(undefined)}>‹ 返回子任务</button>
    <div className={`progress-detail progress-${task.state}`}><h3>{task.title}</h3><TaskMeta item={task} /><p>{task.detail}</p>
      <TaskControl item={task} onStop={onStop} onResume={onResume} /></div>
    {renderHistory ? <div className="agent-history-timeline">{renderHistory(task.id)}</div> : null}
  </section>;
  const groups = [
    { title: "需要回应", items: model.tasks.filter((item) => ["attention", "failed", "paused", "stopped"].includes(item.state)) },
    { title: "进行中", items: model.tasks.filter((item) => ["running", "queued"].includes(item.state)) },
    { title: "已结束", items: model.tasks.filter((item) => item.state === "completed") },
    { title: "待安排", items: model.tasks.filter((item) => item.state === "waiting") },
  ];
  return <section className="progress-panel" aria-label="工作进展">
    {model.primary ? <p className={`progress-primary progress-${model.primary.state}`}><span className="progress-dot" />主任务 · {progressStateLabel(model.primary.state)}</p> : null}
    {groups.filter((group) => group.items.length).map((group) => <section key={group.title} className="progress-group"><h3>{group.title}</h3>
      <ul className="progress-list">{group.items.map((item) => <li key={item.id}>
        <button className={`progress-entry progress-${item.state}`} onClick={() => setSelected(item.id)}>
          <span className="progress-dot" aria-hidden="true" /><span className="progress-entry-copy"><strong>{item.title}</strong>
            <TaskMeta item={item} /><span className="progress-result">{item.detail}</span></span><span className="progress-chevron" aria-hidden="true">›</span>
        </button>
      </li>)}</ul>
    </section>)}
    {!model.tasks.length ? <p className="progress-empty">{model.primary ? model.primary.title === "当前工作" ? model.primary.detail : model.primary.title : "选择一个对话，查看工作进展。"}</p> : null}
  </section>;
}
function TaskMeta({ item }: { item: ProgressItem }) {
  return <span className="progress-meta">{[item.agentName, progressStateLabel(item.state), item.duration].filter(Boolean).join(" · ")}</span>;
}
function TaskControl({ item, onStop, onResume }: Pick<ProgressPanelProps, "onStop" | "onResume"> & { item: ProgressItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const control = item.control === "pause" ? onStop : item.control === "resume" ? onResume : undefined;
  return <>{control ? <button className="secondary" disabled={busy} onClick={() => {
    setBusy(true); setError(undefined); void control(item.id).catch(() => setError("操作未成功，请重试。")).finally(() => setBusy(false));
  }}>{busy ? "正在处理…" : item.control === "pause" ? "停止这项工作" : "继续这项工作"}</button> : null}{error ? <p role="alert">{error}</p> : null}</>;
}
