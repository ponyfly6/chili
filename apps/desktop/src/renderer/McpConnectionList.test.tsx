import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpConnectionList } from "./McpConnectionList.js";

test("shows actual MCP state, available tool count, and explicit connection controls", () => {
  const html = renderToStaticMarkup(<McpConnectionList disabled={false} onConnection={() => undefined} servers={[
    { name: "running-server", status: "running", enabled: true, toolCount: 2 },
    { name: "stopped-server", status: "stopped", enabled: true },
    { name: "failed-server", status: "error", enabled: true, error: "secret-value-must-not-render", args: ["secret-argument"] },
  ]} />);
  expect(html).toContain("2 个工具可用");
  expect(html).toContain('aria-label="断开 running-server"');
  expect(html).toContain('aria-label="连接 stopped-server"');
  expect(html).toContain("重试连接");
  expect(html).not.toContain("secret-value-must-not-render");
  expect(html).not.toContain("secret-argument");
});

test("disabled configuration and in-progress actions cannot start another connection", () => {
  for (const server of [
    { name: "disabled", status: "disabled" as const, enabled: false },
    { name: "starting", status: "starting" as const, enabled: true },
  ]) {
    const html = renderToStaticMarkup(<McpConnectionList disabled={false} onConnection={() => undefined} servers={[server]} />);
    expect(html).toContain('disabled=""');
  }
  const html = renderToStaticMarkup(<McpConnectionList disabled servers={[{ name: "ready", status: "stopped", enabled: true }]} onConnection={() => undefined} />);
  expect(html).toContain('disabled=""');
});

test("authentication failures explain the recovery without rendering provider error material", () => {
  const html = renderToStaticMarkup(<McpConnectionList disabled={false} onConnection={() => undefined} servers={[
    { name: "auth", status: "auth_required", enabled: true, auth: { required: true, error: "secret-auth-detail" } },
  ]} />);
  expect(html).toContain("请在本机配置中完成授权，再重试连接。");
  expect(html).toContain("需要授权");
  expect(html).not.toContain("secret-auth-detail");
});
