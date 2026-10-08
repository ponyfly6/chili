import type { UnknownMutationOutcome } from "./control-feedback.js";

export function OutcomeWarnings({ outcomes, onConfirm }: {
  outcomes: readonly UnknownMutationOutcome[];
  onConfirm: (id: string) => void;
}) {
  if (outcomes.length === 0) return null;
  return (
    <section className="outcome-warnings" data-testid="outcome-unknown" aria-label="待核对的未知指令结果">
      <p className="outcome-explanation">这些操作可能已经执行。请先核对任务记录，不要直接重复提交。恢复连接不会清除这些提醒。</p>
      {outcomes.map((outcome) => (
        <article className="outcome-warning" role="alert" key={outcome.id} data-testid={`unknown-outcome-${outcome.id}`}>
          <div className="outcome-heading"><strong>{commandLabel(outcome.command)}结果未知</strong><span>{new Date(outcome.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
          <p className="outcome-task">任务：{outcome.sessionTitle || "未命名任务"}<span>{outcome.sessionId}</span></p>
          {outcome.promptPreview && <p className="outcome-preview">指令摘要：{outcome.promptPreview}</p>}
          <button type="button" className="secondary-button" data-testid={`unknown-confirm-${outcome.id}`} aria-label={`已核对，清除此提醒：${outcome.command} ${outcome.sessionTitle}，命令 ${outcome.id}`} onClick={() => onConfirm(outcome.id)}>已核对，清除此提醒</button>
        </article>
      ))}
      <p className="outcome-lifetime">最小提醒保存在这台设备上，重新打开仍会显示；任务内容和连接授权不会保存在浏览器中。清除授权不会清除提醒。</p>
    </section>
  );
}

function commandLabel(command: UnknownMutationOutcome["command"]): string {
  return { Queue: "排队指令", Steer: "补充指令", Stop: "停止任务", Answer: "问题回答" }[command];
}
