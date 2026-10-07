import type { RuntimeMcpServerDescriptor } from "@chili/protocol";
import "./mcp-connections.css";

export function McpConnectionList({ servers, disabled, onConnection }: {
  servers: readonly RuntimeMcpServerDescriptor[];
  disabled: boolean;
  onConnection?: (server: string, connect: boolean) => void;
}) {
  return <>{servers.map((server) => {
    const running = server.status === "running";
    const unavailable = disabled || !onConnection || !server.enabled || server.status === "starting";
    return <div className="settings-row" key={server.name}>
      <span>{server.name}<small>{server.status === "auth_required" ? "请在本机配置中完成授权，再重试连接。"
        : server.status === "error" ? "连接失败，可以重试。"
        : running ? server.toolCount === undefined ? "已连接，工具数量暂不可用。" : `${server.toolCount} 个工具可用`
        : !server.enabled ? "已在配置中停用。"
        : server.status === "starting" ? "正在连接…" : "已配置，尚未连接。"}</small></span>
      <span className="mcp-connection-actions"><span className={`connection-label ${running ? "available" : ""}`}>{connectionStatus(server.status)}</span>
        <button type="button" className="secondary" disabled={unavailable} aria-label={`${running ? "断开" : "连接"} ${server.name}`}
          onClick={() => onConnection?.(server.name, !running)}>{running ? "断开" : server.status === "error" || server.status === "auth_required" ? "重试连接" : "连接"}</button>
      </span>
    </div>;
  })}</>;
}

function connectionStatus(status: RuntimeMcpServerDescriptor["status"]): string {
  return { unknown: "未连接", disabled: "已停用", stopped: "未连接", starting: "连接中", running: "已连接", error: "连接失败", auth_required: "需要授权" }[status];
}
