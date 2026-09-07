import { useId, useMemo, useState } from "react";
import { parseDiff, type DiffFile, type DiffLine } from "./diff-model.js";
import { splitRawDiff } from "./diff-pagination.js";
import "./diff-viewer.css";

export interface DiffViewerProps {
  text: string;
  truncated?: boolean;
  loading?: boolean;
  /** Change when the project, session, or diff scope changes. */
  resetKey?: string;
}

const PATCH_PAGE_LINES = 400;

/** A compact, read-only review surface; only the selected file is mounted. */
export function DiffViewer({ resetKey, ...props }: DiffViewerProps) {
  return <DiffViewerContent key={resetKey ?? "default"} {...props} />;
}

function DiffViewerContent({ text, truncated = false, loading = false }: Omit<DiffViewerProps, "resetKey">) {
  const document = useMemo(() => parseDiff(text, truncated), [text, truncated]);
  const rawPages = useMemo(() => splitRawDiff(text), [text]);
  const [selectedId, setSelectedId] = useState<string>();
  const [raw, setRaw] = useState(false);
  const [rawPage, setRawPage] = useState(0);
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());
  const [filePages, setFilePages] = useState<Record<string, number>>({});
  const selectId = useId();
  const selectedIndex = Math.max(0, document.files.findIndex((file) => file.id === selectedId));
  const selected = document.files[selectedIndex];
  const selectedRawPage = Math.min(rawPage, rawPages.length - 1);
  const notes = useMemo(() => [...new Set([
    ...document.preamble,
    ...document.files.flatMap((file) => file.lines
      .filter((line) => line.kind === "metadata" && line.text.startsWith("#"))
      .map((line) => line.text)),
  ])].join("\n").trim(), [document]);

  const toggleFile = (id: string) => setCollapsedFiles((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <section className="diff-review" aria-label="Changes review" aria-busy={loading}>
      <div className="diff-review-toolbar">
        <div className="diff-review-total" aria-live="polite">
          <strong>{document.files.length} {document.files.length === 1 ? "file" : "files"}</strong>
          <ChangeCounts added={document.added} removed={document.removed} />
        </div>
        <div className="diff-review-modes" role="group" aria-label="Diff display">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Patch</button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
        </div>
      </div>

      {document.truncated ? (
        <p className="diff-review-warning" role="note">This diff is incomplete. Some changes could not be included in the runtime output.</p>
      ) : null}
      {loading ? <p className="diff-review-loading" role="status">Loading changes…</p> : null}

      {raw ? (
        <div className="diff-review-raw">
          {rawPages.length > 1 ? (
            <PageNavigation current={selectedRawPage} total={rawPages.length} label="Raw text" onChange={setRawPage} />
          ) : null}
          <pre className="diff-review-source" tabIndex={0} aria-label={rawPages.length > 1 ? `Raw diff, part ${selectedRawPage + 1} of ${rawPages.length}` : "Raw diff"}>{rawPages[selectedRawPage] || (loading ? "" : "No changes to review.")}</pre>
          {rawPages.length > 1 ? <p className="diff-review-footnote">Full source is preserved across {rawPages.length} parts. Long lines may continue in the next part.</p> : null}
        </div>
      ) : (
        <>
          {notes ? <pre className={document.files.length ? "diff-review-notes" : "diff-review-empty"}>{notes}</pre> : null}
          {selected ? (
            <>
              <div className="diff-review-navigation">
                <button type="button" className="diff-review-arrow" aria-label="Previous changed file" disabled={selectedIndex === 0} onClick={() => setSelectedId(document.files[selectedIndex - 1]?.id)}>‹</button>
                <div className="diff-review-file-select">
                  <label className="diff-review-sr-only" htmlFor={selectId}>Changed file</label>
                  <select id={selectId} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                    {document.files.map((file, index) => <option key={file.id} value={file.id}>{index + 1}. {file.path} · +{file.added} −{file.removed}</option>)}
                  </select>
                </div>
                <button type="button" className="diff-review-arrow" aria-label="Next changed file" disabled={selectedIndex >= document.files.length - 1} onClick={() => setSelectedId(document.files[selectedIndex + 1]?.id)}>›</button>
              </div>
              <FilePatch
                key={selected.id}
                file={selected}
                collapsed={collapsedFiles.has(selected.id)}
                onToggle={() => toggleFile(selected.id)}
                page={filePages[selected.id] ?? 0}
                onPageChange={(page) => setFilePages((previous) => ({ ...previous, [selected.id]: page }))}
              />
            </>
          ) : !notes && !loading ? <p className="diff-review-empty">No changes to review.</p> : null}
        </>
      )}
    </section>
  );
}

function FilePatch({ file, collapsed, onToggle, page, onPageChange }: {
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const contentId = useId();
  const pageCount = Math.max(1, Math.ceil(file.lines.length / PATCH_PAGE_LINES));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PATCH_PAGE_LINES;
  const lines = file.lines.slice(start, start + PATCH_PAGE_LINES);

  return (
    <article className="diff-review-file">
      <button type="button" className="diff-review-file-heading" aria-expanded={!collapsed} aria-controls={contentId} onClick={onToggle}>
        <span className="diff-review-chevron" aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
        <span className="diff-review-file-name" title={file.path}>
          <strong>{file.path}</strong>
          {file.previousPath && file.previousPath !== file.path ? <small>From {file.previousPath}</small> : null}
        </span>
        <span className={`diff-review-kind diff-review-kind-${file.kind}`}>{kindLabel(file.kind)}</span>
        <ChangeCounts added={file.added} removed={file.removed} />
      </button>
      {!collapsed ? (
        <div id={contentId}>
          {pageCount > 1 ? <PageNavigation current={currentPage} total={pageCount} label="Patch" onChange={onPageChange} detail={`Rows ${start + 1}–${start + lines.length} of ${file.lines.length}`} /> : null}
          <div className="diff-review-code-scroll" tabIndex={0} role="region" aria-label={`Patch for ${file.path}`}>
            <table className="diff-review-code" aria-label={`Changes in ${file.path}`}>
              <thead className="diff-review-sr-only"><tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th><th scope="col">Content</th></tr></thead>
              <tbody>{lines.map((line, index) => <PatchLine key={start + index} line={line} />)}</tbody>
            </table>
          </div>
          {pageCount > 1 ? <PageNavigation current={currentPage} total={pageCount} label="Patch" onChange={onPageChange} detail={`Rows ${start + 1}–${start + lines.length} of ${file.lines.length}`} /> : null}
        </div>
      ) : null}
    </article>
  );
}

function PatchLine({ line }: { line: DiffLine }) {
  const changed = line.kind === "addition" || line.kind === "deletion";
  const content = changed || line.kind === "context" ? line.text.slice(1) : line.text;
  return (
    <tr className={`diff-review-line diff-review-line-${line.kind}`}>
      <td className="diff-review-number">{line.oldNumber ?? ""}</td>
      <td className="diff-review-number">{line.newNumber ?? ""}</td>
      <td className="diff-review-sign">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}</td>
      <td className="diff-review-content"><code>{content || " "}</code></td>
    </tr>
  );
}

function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="diff-review-counts"><span className="diff-review-added" aria-label={`${added} added lines`}>+{added}</span><span className="diff-review-removed" aria-label={`${removed} removed lines`}>−{removed}</span></span>;
}

function PageNavigation({ current, total, label, detail, onChange }: {
  current: number;
  total: number;
  label: string;
  detail?: string;
  onChange: (page: number) => void;
}) {
  return (
    <div className="diff-review-pages" role="group" aria-label={`${label} pages`}>
      <span>{detail ?? `${label} part ${current + 1} of ${total}`}</span>
      <div>
        <button type="button" aria-label={`Previous ${label.toLowerCase()} page`} disabled={current === 0} onClick={() => onChange(current - 1)}>Previous</button>
        <button type="button" aria-label={`Next ${label.toLowerCase()} page`} disabled={current >= total - 1} onClick={() => onChange(current + 1)}>Next</button>
      </div>
    </div>
  );
}

function kindLabel(kind: DiffFile["kind"]): string {
  switch (kind) {
    case "added": return "Added";
    case "deleted": return "Deleted";
    case "renamed": return "Renamed";
    case "binary": return "Binary";
    case "metadata": return "Metadata";
    default: return "Modified";
  }
}
