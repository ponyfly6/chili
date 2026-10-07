import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatTranscriptItem } from "@chili/sdk";
import { isResultPreviewUrl, type DesktopResultRead } from "../shared/result-preview.js";
import { discoverDesktopResults } from "./result-model.js";
import type { ControlTransport } from "./transport.js";
import "./results-panel.css";

export interface ResultsPanelProps {
  transport: ControlTransport;
  sessionId: string;
  workspace: string | undefined;
  items: readonly ChatTranscriptItem[];
  renderMarkdown?: (text: string) => ReactNode;
  onContinue?: (path: string) => void;
}

/** Key the panel by project/session so a change of owner releases its read. */
export function ResultsPanel(props: ResultsPanelProps) {
  return <ResultsPanelContent key={`${props.workspace ?? ""}:${props.sessionId}`} {...props} />;
}

function ResultsPanelContent({ transport, workspace, items, renderMarkdown, onContinue }: ResultsPanelProps) {
  const results = useMemo(() => discoverDesktopResults(items, workspace), [items, workspace]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = results.find((result) => result.id === selectedId) ?? results[0];
  const [read, setRead] = useState<{ path: string; revision: string; result: DesktopResultRead }>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const path = selected?.path;
  const revision = `${selected?.messageId ?? ""}:${selected?.updatedAt ?? 0}:${refresh}`;

  useEffect(() => {
    let active = true;
    setRead(undefined);
    setError(undefined);
    if (!path) return;
    if (!transport.readResult) { setError("当前连接不支持本地文件预览。"); return; }
    void transport.readResult(path).then((result) => {
      if (active) setRead({ path, revision, result });
    }).catch(() => {
      if (active) setError("暂时无法读取这个文件，请刷新后重试。");
    });
    return () => { active = false; };
  }, [transport, path, revision]);
  const result = read && read.path === path && read.revision === revision ? read.result : undefined;
  const ready = result?.status === "ready" ? result : undefined;
  const loading = Boolean(path && !result && !error);
  const canPreview = ready && ["markdown", "html"].includes(ready.kind);

  return <section className="results-panel" aria-label="会话结果" aria-busy={loading}>
    <header className="results-panel-header">
      <div><p>交付内容</p><h2>{selected ? selected.label : "结果会出现在这里"}</h2></div>
      {selected ? <button className="results-refresh" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)} aria-label="刷新结果">↻</button> : null}
    </header>
    {results.length > 1 ? <nav className="results-tabs" aria-label="结果文件">{results.map((candidate) =>
      <button key={candidate.id} type="button" aria-pressed={candidate.id === selected?.id} title={candidate.path}
        onClick={() => { setSelectedId(candidate.id); setSource(false); }}>{candidate.label}</button>)}</nav> : null}
    {selected ? <div className="results-file-toolbar">
      <span className="results-file-path" title={selected.path}>{selected.path}</span>
      {canPreview ? <div className="results-display-modes" role="group" aria-label="结果显示方式">
        <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>预览</button>
        <button type="button" aria-pressed={source} onClick={() => setSource(true)}>源码</button>
      </div> : null}
    </div> : null}
    <div className={`results-preview${ready?.kind === "html" && !source ? " results-preview-html" : ""}`}>
      {!selected ? <div className="results-empty"><span aria-hidden="true">↗</span><h3>从一次对话，到一个成果</h3><p>助手交付的本地文件会汇集在这里。可以预览网页、图片、文档与代码，再继续提出修改。</p></div> : null}
      {loading ? <p className="results-status" role="status">正在读取文件…</p> : null}
      {error ? <p className="results-status" role="alert">{error}</p> : null}
      {result?.status === "unavailable" ? <p className="results-status" role="status">{unavailableLabel(result.reason)}</p> : null}
      {ready ? <ResultPreviewContent result={ready} label={selected?.label ?? "结果预览"} source={source} {...(renderMarkdown ? { renderMarkdown } : {})} /> : null}
    </div>
    {selected ? <footer className="results-panel-footer"><span>{ready?.kind === "html" && !source ? "静态预览 · 脚本与外部资源已停用" : ready ? `${formatBytes(ready.bytes)} · 本地文件` : "来自当前会话的文件引用"}</span>
      {onContinue ? <button type="button" onClick={() => onContinue(selected.path)}>继续修改 <span aria-hidden="true">↗</span></button> : null}
    </footer> : null}
  </section>;
}

export function ResultPreviewContent({ result, label, source = false, renderMarkdown }: {
  result: Extract<DesktopResultRead, { status: "ready" }>;
  label: string;
  source?: boolean;
  renderMarkdown?: (text: string) => ReactNode;
}) {
  if (result.kind === "image") return <figure className="results-image"><img alt={label} src={`data:${result.mimeType};base64,${result.content}`} /></figure>;
  if (result.kind === "html" && !source && result.previewUrl && isResultPreviewUrl(result.previewUrl)) {
    return <iframe className="results-html-frame" title={label} src={result.previewUrl} sandbox="" referrerPolicy="no-referrer" />;
  }
  if (result.kind === "markdown" && !source && renderMarkdown) return <article className="results-markdown">{renderMarkdown(result.content)}</article>;
  return <pre className="results-source" tabIndex={0} aria-label="结果文件内容"><code>{result.content}</code></pre>;
}

function unavailableLabel(reason: Extract<DesktopResultRead, { status: "unavailable" }>["reason"]): string {
  const labels = {
    outside_workspace: "只能预览当前目录中的文件。",
    missing: "没有找到这个文件，它可能已被移动或删除。",
    unsupported: "暂不支持预览这种文件格式。",
    too_large: "文件较大，暂不支持内嵌预览。文本上限 512 KB，图片上限 4 MB。",
    not_file: "这个引用没有指向普通文件。",
    invalid_text: "这个文件不是可预览的 UTF-8 文本。",
    unavailable: "文件暂时无法读取，或正在被修改。请刷新后重试。",
  };
  return labels[reason];
}

function formatBytes(bytes: number): string { return bytes < 1_000 ? `${bytes} B` : bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
