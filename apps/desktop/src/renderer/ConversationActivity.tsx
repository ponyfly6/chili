import type { RuntimeInputQueue } from "@chili/protocol";
import { pendingConversationInputs, type ConversationActivity } from "./conversation-activity.js";

export function ConversationQueue({ queue, pendingCount }: { queue: RuntimeInputQueue | undefined; pendingCount: number }) {
  const inputs = pendingConversationInputs(queue);
  const count = Math.max(inputs.length, pendingCount);
  if (!count) return null;
  return <details className="conversation-queue" open>
    <summary><span>待处理 · {count} 条</span><small>{queue?.paused ? "继续后按顺序处理" : "当前处理完成后继续"}</small></summary>
    {inputs.length ? <ol aria-label="待处理消息">{inputs.map((input) => <li key={input.inputId}>
      <p>{input.text}</p>{input.mode === "steer" ? <small>优先处理</small> : null}
    </li>)}</ol> : <p className="conversation-queue-loading">正在读取待处理消息…</p>}
  </details>;
}

export function ConversationActivityBar({ activity, disabled, canResume, onStop, onResume }: {
  activity: ConversationActivity;
  disabled: boolean;
  canResume: boolean;
  onStop: () => void;
  onResume: () => void;
}) {
  if (activity.kind === "idle") return null;
  return <div className={`conversation-activity activity-${activity.kind}`}>
    <span className="conversation-activity-label" role="status"><span aria-hidden="true" />{activity.label}</span>
    {canResume ? <button type="button" disabled={disabled} onClick={onResume}>继续处理 <span aria-hidden="true">→</span></button> : null}
    {activity.canStop ? <button type="button" aria-label="Stop current turn" disabled={disabled} onClick={onStop}>停止</button> : null}
  </div>;
}
