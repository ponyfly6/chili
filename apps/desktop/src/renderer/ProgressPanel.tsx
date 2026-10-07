import { useMemo, useRef, useState } from "react";
import { buildProgressModel, progressStateLabel, type ProgressItem, type ProgressModelInput } from "./progress-model.js";
import "./progress-panel.css";

export interface ProgressPanelProps extends ProgressModelInput {
  projectId: string | undefined;
  onStop?: ((agentId: string) => Promise<void>) | undefined;
  onResume?: ((agentId: string) => Promise<void>) | undefined;
}

export function ProgressPanel(props: ProgressPanelProps) {
  return <ScopedProgressPanel key={JSON.stringify([props.projectId ?? null, props.sessionId ?? null])} {...props} />;
}

function ScopedProgressPanel({ onStop, onResume, ...input }: ProgressPanelProps) {
  const model = useMemo(() => buildProgressModel(input), [input.agents, input.inputQueues, input.runtime, input.sessionId, input.workItems, input.pendingQuestions]);
  return <section className="progress-panel" aria-label="工作进展">
    {model.primary ? <>
      <div className="progress-overview"><p>当前进展</p><ProgressEntry item={model.primary} /></div>
      {model.tasks.length > 0 ? <div className="progress-work"><p className="progress-section-label">各项工作</p>
        <ul className="progress-list">{model.tasks.map((item) => <li key={item.id}>
          <ProgressEntry item={item} onStop={onStop} onResume={onResume} />
        </li>)}</ul>
      </div> : <p className="progress-empty">工作进度会自动更新，结果可以在对话中查看。</p>}
    </> : <p className="progress-empty">选择一个对话，查看工作进展。</p>}
  </section>;
}

function ProgressEntry({ item, onStop, onResume }: Pick<ProgressPanelProps, "onStop" | "onResume"> & { item: ProgressItem }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const control = item.control === "pause" ? onStop : item.control === "resume" ? onResume : undefined;
  async function act() {
    if (!control || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice(undefined);
    setFailed(false);
    try {
      await control(item.id);
      setNotice(item.control === "pause" ? "已请求暂停。" : "已请求继续。");
    } catch {
      setFailed(true);
      setNotice("操作未成功，请稍后重试。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return <details className={`progress-entry progress-${item.state}`}>
    <summary>
      <span className="progress-dot" aria-hidden="true" />
      <span className="progress-entry-copy"><strong>{item.title}</strong><span>{progressStateLabel(item.state)}</span></span>
      <span className="progress-chevron" aria-hidden="true">›</span>
    </summary>
    <div className="progress-entry-detail"><p>{item.detail}</p>
      {control ? <button type="button" disabled={pending} onClick={() => void act()}>{pending ? "正在处理…" : item.control === "pause" ? "暂停这项工作" : "继续这项工作"}</button> : null}
      {notice ? <p role={failed ? "alert" : "status"}>{notice}</p> : null}
    </div>
  </details>;
}
