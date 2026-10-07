import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopResponseMap, DiffScope } from "../shared/contracts.js";
import { DiffViewer } from "./DiffViewer.js";
import type { ControlTransport } from "./transport.js";
import "./changes-panel.css";

export interface ChangesPanelProps {
  transport: ControlTransport;
  sessionId: string;
  turnId?: string;
  revision: number;
}

type ChangesResult = DesktopResponseMap["diff.get"];
export type ChangesLoadState =
  | { status: "loading"; result?: ChangesResult }
  | { status: "ready"; result: ChangesResult }
  | { status: "error"; message: string };

/** Coalesce event bursts and never run more than one diff request at a time. */
export function createChangesLoader({ load, onState, delayMs = 750 }: {
  load: () => Promise<ChangesResult>;
  onState: (state: ChangesLoadState) => void;
  delayMs?: number;
}) {
  let disposed = false;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: ChangesResult | undefined;

  const schedule = () => {
    if (!disposed && !running && !timer) timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };
  const run = async () => {
    if (disposed || running) return;
    dirty = false;
    running = true;
    onState({ status: "loading", ...(previous ? { result: previous } : {}) });
    try {
      const result = await load();
      if (disposed) return;
      previous = result;
      onState({ status: "ready", result });
    } catch (error) {
      if (disposed) return;
      onState({ status: "error", message: error instanceof Error ? error.message : "暂时无法读取改动。" });
    } finally {
      running = false;
      if (dirty) schedule();
    }
  };

  return {
    refresh(immediate = false) {
      if (disposed) return;
      dirty = true;
      if (running) return;
      if (immediate) {
        clearTimeout(timer);
        timer = undefined;
        void run();
      } else schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function ChangesPanel(props: ChangesPanelProps) {
  return <ChangesPanelContent key={props.sessionId} {...props} />;
}

function ChangesPanelContent({ transport, sessionId, turnId, revision }: ChangesPanelProps) {
  const [scope, setScope] = useState<DiffScope>("turn");
  const context = useMemo(() => ({ transport, sessionId, turnId, scope }), [transport, sessionId, turnId, scope]);
  const [view, setView] = useState<{ context: typeof context; state: ChangesLoadState }>();
  const request = useRef<{ loader: ReturnType<typeof createChangesLoader>; revision: number } | undefined>(undefined);
  const hasScope = scope === "workspace" || Boolean(turnId);

  useEffect(() => {
    if (!hasScope) return;
    const loader = createChangesLoader({
      load: () => context.transport.diff(context.scope, context.sessionId, context.scope === "turn" ? context.turnId : undefined),
      onState: (state) => setView({ context, state }),
    });
    request.current = { loader, revision };
    loader.refresh(true);
    return () => {
      loader.dispose();
      if (request.current?.loader === loader) request.current = undefined;
    };
  }, [context, hasScope]);

  useEffect(() => {
    if (request.current && request.current.revision !== revision) {
      request.current.revision = revision;
      request.current.loader.refresh();
    }
  }, [revision]);

  const state = view?.context === context ? view.state : { status: "loading" as const };
  return (
    <section className="changes-panel" aria-label="改动">
      <header className="changes-panel-heading">
        <p>{scope === "turn" ? "显示最近一次修改记录。" : "查看整个目录中尚未提交的改动。"}</p>
      </header>
      <div className="changes-panel-scope" role="group" aria-label="改动范围">
        <button type="button" aria-pressed={scope === "turn"} onClick={() => setScope("turn")}>最近修改</button>
        <button type="button" aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>整个目录</button>
      </div>
      {scope === "workspace" ? <p className="changes-panel-notice" role="note">包含其他会话和原有的修改，不全是这次对话产生的内容。</p> : null}
      {!hasScope ? (
        <p className="changes-panel-empty">还没有可查看的修改记录。你也可以选择「整个目录」查看已有改动。</p>
      ) : (
        <ChangesPanelBody state={state} resetKey={JSON.stringify([sessionId, scope, turnId])} onRetry={() => request.current?.loader.refresh(true)} />
      )}
    </section>
  );
}

export function ChangesPanelBody({ state, resetKey, onRetry }: {
  state: ChangesLoadState;
  resetKey: string;
  onRetry: () => void;
}) {
  if (state.status === "error") return (
    <div className="changes-panel-error" role="alert">
      <p>暂时无法读取改动。</p>
      <p className="changes-panel-error-detail">{state.message}</p>
      <button type="button" onClick={onRetry}>重试</button>
    </div>
  );
  const result = state.result;
  const emptyMessage = result && changesEmptyMessage(result);
  return (
    <div className="changes-panel-body" aria-busy={state.status === "loading"}>
      {state.status === "loading" ? <p className="changes-panel-loading" role="status">{result ? "正在更新改动…" : "正在读取改动…"}</p> : null}
      {emptyMessage ? <p className="changes-panel-empty">{emptyMessage}</p> : result ? <DiffViewer text={result.text} truncated={result.truncated} resetKey={resetKey} /> : null}
    </div>
  );
}

function changesEmptyMessage(result: ChangesResult): string | undefined {
  if (result.truncated) return undefined;
  const text = result.text.trim();
  if (!text) return result.scope === "turn" ? "这次修改记录没有留下文件改动。" : "目录中没有尚未提交的改动。";
  const messages: Record<string, string> = {
    "No turn activity yet.": "还没有可查看的修改记录。",
    "No file-changing tool activity in this turn.": "这次记录没有文件改动。",
    "No readable file snapshot was created by this turn.": "这次修改没有可供比较的文件快照。",
    "No snapshot-backed file changes were recorded for this turn.": "这次修改尚未记录可供比较的文件改动。",
    "No changes remain from this turn.": "这次修改记录没有留下文件改动。",
    "Workspace is clean.": "目录中没有尚未提交的改动。",
    "Workspace is not a Git repository.": "这个目录尚未使用 Git 管理，无法查看目录改动。",
    "Workspace is not a top-level Git working tree with local metadata.": "这个目录没有可用的本地 Git 记录，无法查看目录改动。",
  };
  return messages[text];
}
