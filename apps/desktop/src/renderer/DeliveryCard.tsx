import { resultFileType } from "../shared/result-preview.js";
import type { DesktopResult } from "./result-model.js";
import "./delivery-card.css";

export interface DeliveryCardProps {
  result: DesktopResult;
  onOpen: (path: string) => void;
}

export function DeliveryCard({ result, onOpen }: DeliveryCardProps) {
  const kind = resultFileType(result.path)?.kind;
  const type = kind === "markdown" ? "Markdown 文档" : kind === "html" ? "HTML 网页"
    : kind === "image" ? "图片" : kind === "code" ? "代码文件" : kind === "text" ? "文本文件"
      : `${result.path.split("/").at(-1)?.split(".").slice(1).at(-1)?.toUpperCase() ?? ""} 文件`.trim();
  return <button type="button" className="delivery-card" aria-label={`打开交付文件：${result.label}`} onClick={() => onOpen(result.path)}>
    <span className="delivery-card-icon" aria-hidden="true">▤</span>
    <span className="delivery-card-content"><strong>{result.label}</strong>
      {result.description ? <span className="delivery-card-description">{result.description}</span> : null}
      <span className="delivery-card-type">{type}</span>
    </span>
    <span className="delivery-card-open" aria-hidden="true">↗</span>
  </button>;
}
