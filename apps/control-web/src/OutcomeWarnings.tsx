import type { UnknownMutationOutcome } from "./control-feedback.js";

export function OutcomeWarnings({ outcomes, onConfirm }: {
  outcomes: readonly UnknownMutationOutcome[];
  onConfirm: (id: string) => void;
}) {
  if (outcomes.length === 0) return null;
  return (
    <section className="outcome-warnings" data-testid="outcome-unknown" aria-label="待核对的未知指令结果">
      <p className="outcome-explanation">这些指令可能已经执行。重连成功或读取到新消息不会清除未知结果；请核对任务记录，不要直接重发。</p>
      {outcomes.map((outcome) => (
        <article className="outcome-warning" role="alert" key={outcome.id} data-testid={`unknown-outcome-${outcome.id}`}>
          <div className="outcome-heading"><strong>{outcome.command} 结果未知</strong><span>命令 {outcome.id} · {new Date(outcome.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>
          <p className="outcome-task">任务：{outcome.sessionTitle || "未命名任务"}<span>{outcome.sessionId}</span></p>
          {outcome.promptPreview && <p className="outcome-preview">指令摘要：{outcome.promptPreview}</p>}
          <button type="button" className="secondary-button" data-testid={`unknown-confirm-${outcome.id}`} aria-label={`已核对，清除此提醒：${outcome.command} ${outcome.sessionTitle}，命令 ${outcome.id}`} onClick={() => onConfirm(outcome.id)}>已核对，清除此提醒</button>
        </article>
      ))}
      <p className="outcome-lifetime">提醒仅保留在本页内存，刷新或关闭会丢失。请先核对每条指令；清除授权不会清除这些提醒。</p>
    </section>
  );
}
