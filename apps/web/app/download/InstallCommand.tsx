"use client";
import { useState } from "react";

export function InstallCommand({ command }: { command: string }) {
  const [status, setStatus] = useState("复制命令");
  return <div className="download-command">
    <code>{command}</code>
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(command); setStatus("已复制"); }
      catch { setStatus("请手动复制"); }
      window.setTimeout(() => setStatus("复制命令"), 2200);
    }}>{status}</button>
    <span className="sr-only" role="status">{status === "复制命令" ? "" : status}</span>
  </div>;
}
