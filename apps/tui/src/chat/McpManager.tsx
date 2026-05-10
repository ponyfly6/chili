import type { RuntimeMcpServerDescriptor, RuntimeMcpStatusResponse, RuntimeMcpSummary, RuntimeMcpToolDescriptor } from "@chili/protocol";
import type { ReactNode } from "react";
import type { ChatRuntimeState } from "../useChatRuntime.js";
import type { TuiTheme } from "../theme/index.js";

export type McpManagerScreen = "list" | "server" | "tools" | "tool" | "confirmRemove";

export interface McpManagerMessage {
  level: "info" | "error";
  text: string;
}

export interface McpManagerState {
  screen: McpManagerScreen;
  selectedIndex: number;
  server?: string | undefined;
  tools?: readonly RuntimeMcpToolDescriptor[] | undefined;
  status?: RuntimeMcpStatusResponse | undefined;
  toolIndex?: number | undefined;
  loading?: boolean | undefined;
  message?: McpManagerMessage | undefined;
}

export type McpServerMenuAction =
  | "tools"
  | "reload"
  | "auth"
  | "logout"
  | "remove"
  | "back";

export interface McpServerMenuItem {
  action: McpServerMenuAction;
  label: string;
  description: string;
}

const MCP_PANEL_WIDTH = "82%";
const MCP_PANEL_MAX_WIDTH = 112;
const MCP_PANEL_VISIBLE_ITEMS = 12;
const MCP_DETAIL_LABEL_WIDTH = 10;

export function initialMcpManagerState(message?: McpManagerMessage): McpManagerState {
  return { screen: "list", selectedIndex: 0, ...(message ? { message } : {}) };
}

export function normalizeMcpManagerState(state: McpManagerState, servers: readonly RuntimeMcpServerDescriptor[]): McpManagerState {
  if (state.screen === "list") return { ...state, selectedIndex: clampIndex(state.selectedIndex, servers.length) };
  const server = state.server ? servers.find((item) => item.name === state.server) : undefined;
  if (!server) return { screen: "list", selectedIndex: 0, ...(state.status ? { status: state.status } : {}), ...(state.message ? { message: state.message } : {}) };
  if (state.screen === "server") {
    return { ...state, selectedIndex: clampIndex(state.selectedIndex, mcpServerMenuItems(server).length) };
  }
  if (state.screen === "tools") {
    return { ...state, selectedIndex: clampIndex(state.selectedIndex, state.tools?.length ?? 0) };
  }
  if (state.screen === "tool") {
    const tools = state.tools ?? [];
    return { ...state, toolIndex: clampIndex(state.toolIndex ?? 0, tools.length) };
  }
  return { ...state, selectedIndex: clampIndex(state.selectedIndex, 2) };
}

export function selectedMcpServer(
  state: McpManagerState,
  servers: readonly RuntimeMcpServerDescriptor[],
): RuntimeMcpServerDescriptor | undefined {
  if (state.server) return servers.find((server) => server.name === state.server);
  return servers[clampIndex(state.selectedIndex, servers.length)];
}

export function mcpServerMenuItems(server: RuntimeMcpServerDescriptor): McpServerMenuItem[] {
  const items: McpServerMenuItem[] = [];
  if (server.status === "running" && server.toolCount !== 0) {
    items.push({ action: "tools", label: "View tools", description: server.toolCount === undefined ? "Fetch discovered tools" : `${server.toolCount} discovered` });
  }
  items.push({ action: "reload", label: "Reconnect / reload", description: "Refresh MCP config and server state" });
  if (server.auth?.required && !server.auth.authenticated) {
    items.push({ action: "auth", label: "Authenticate", description: mcpAuthDescription(server) });
  } else if (server.auth?.required || server.auth?.authenticated) {
    items.push({ action: "auth", label: "Re-authenticate", description: mcpAuthDescription(server) });
  }
  if (server.auth?.authenticated) {
    items.push({ action: "logout", label: "Clear authentication", description: "Remove stored auth for this server" });
  }
  items.push({ action: "remove", label: "Remove from user config", description: "Delete this MCP server from ~/.chili/mcp.json" });
  items.push({ action: "back", label: "Back", description: "Return to MCP server list" });
  return items;
}

export function McpManager(props: {
  state: McpManagerState;
  runtime: ChatRuntimeState;
  theme: TuiTheme;
}) {
  const status = props.state.status ?? props.runtime.mcpStatus;
  const servers = status?.servers ?? [];
  const normalizedState = normalizeMcpManagerState(props.state, servers);
  const server = selectedMcpServer(normalizedState, servers);

  if (normalizedState.screen === "server" && server) {
    return <McpServerPanel server={server} state={normalizedState} theme={props.theme} />;
  }
  if (normalizedState.screen === "tools" && server) {
    return <McpToolsPanel server={server} state={normalizedState} theme={props.theme} />;
  }
  if (normalizedState.screen === "tool" && server) {
    return <McpToolDetailPanel server={server} state={normalizedState} theme={props.theme} />;
  }
  if (normalizedState.screen === "confirmRemove" && server) {
    return <McpRemoveConfirmPanel server={server} state={normalizedState} theme={props.theme} />;
  }
  return <McpServerListPanel state={normalizedState} servers={servers} summary={status?.summary} theme={props.theme} />;
}

function McpServerListPanel(props: {
  state: McpManagerState;
  servers: readonly RuntimeMcpServerDescriptor[];
  summary: RuntimeMcpSummary | undefined;
  theme: TuiTheme;
}) {
  const subtitle = props.summary
    ? `${props.summary.total} servers  ${props.summary.running} running  ${props.summary.disabled} disabled  ${props.summary.errored} errors`
    : "loading servers";
  return (
    <McpPanelLayout footer="Up/Down navigate  Enter select  r reload  Esc close" theme={props.theme}>
      <McpPanelFrame title="Manage MCP servers" subtitle={subtitle} theme={props.theme}>
        {props.state.message ? <McpMessage message={props.state.message} theme={props.theme} /> : null}
        {props.state.loading && props.servers.length === 0 ? (
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  Loading MCP servers..."}</text>
        ) : props.servers.length === 0 ? (
          <>
            <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  No MCP servers configured."}</text>
            <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  Use `chili mcp add` or `/mcp add ...` to add one."}</text>
          </>
        ) : (
          visibleItems(props.servers, props.state.selectedIndex, MCP_PANEL_VISIBLE_ITEMS).map(({ item: server, index }) => {
            const selected = index === props.state.selectedIndex;
            return <McpSelectableRow key={server.name} selected={selected} theme={props.theme} text={`${server.name}  ${statusPill(server)}  ${server.transport ?? "mcp"}  tools=${server.toolCount ?? "?"}${serverEndpoint(server) ? `  ${serverEndpoint(server)}` : ""}`} />;
          })
        )}
      </McpPanelFrame>
    </McpPanelLayout>
  );
}

function McpServerPanel(props: { server: RuntimeMcpServerDescriptor; state: McpManagerState; theme: TuiTheme }) {
  const items = mcpServerMenuItems(props.server);
  return (
    <McpPanelLayout footer="Up/Down navigate  Enter select  Esc back" theme={props.theme}>
      <McpPanelFrame title={`${capitalize(props.server.name)} MCP Server`} subtitle={serverSubtitle(props.server)} theme={props.theme}>
        {props.state.message ? <McpMessage message={props.state.message} theme={props.theme} /> : null}
        <McpSectionTitle text="Connection" theme={props.theme} />
        <McpDetail label="Status" value={statusPill(props.server)} theme={props.theme} />
        <McpDetail label="Enabled" value={props.server.enabled ? "yes" : "no"} theme={props.theme} />
        <McpDetail label="Transport" value={props.server.transport ?? "unknown"} theme={props.theme} />
        <McpDetail label={props.server.url ? "URL" : "Command"} value={serverEndpoint(props.server) || "-"} theme={props.theme} />
        <McpDetail label="Auth" value={mcpAuthDescription(props.server)} theme={props.theme} />
        <McpDetail label="Tools" value={`${props.server.toolCount ?? "?"}`} theme={props.theme} />
        {props.server.description ? <McpDetail label="Description" value={props.server.description} theme={props.theme} /> : null}
        {props.server.error ? <McpDetail label="Error" value={props.server.error} level="error" theme={props.theme} /> : null}
        <box height={1} />
        <McpSectionTitle text="Actions" theme={props.theme} />
        {items.map((item, index) => {
          const selected = index === props.state.selectedIndex;
          return <McpSelectableRow key={item.action} selected={selected} theme={props.theme} text={`${item.label} - ${item.description}`} />;
        })}
      </McpPanelFrame>
    </McpPanelLayout>
  );
}

function McpToolsPanel(props: { server: RuntimeMcpServerDescriptor; state: McpManagerState; theme: TuiTheme }) {
  const tools = props.state.tools ?? [];
  return (
    <McpPanelLayout footer="Up/Down navigate  Enter details  Esc back" theme={props.theme}>
      <McpPanelFrame title={`Tools for ${props.server.name}`} subtitle={props.state.loading ? "loading tools" : `${tools.length} tools`} theme={props.theme}>
        {props.state.message ? <McpMessage message={props.state.message} theme={props.theme} /> : null}
        {props.state.loading ? (
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  Loading tools..."}</text>
        ) : tools.length === 0 ? (
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  No tools available."}</text>
        ) : (
          visibleItems(tools, props.state.selectedIndex, 12).map(({ item, index }) => {
            const selected = index === props.state.selectedIndex;
            return <McpSelectableRow key={`${item.name}:${index}`} selected={selected} theme={props.theme} text={`${item.name}${toolAnnotationText(item)}${item.description ? `  ${compactWhitespace(item.description)}` : ""}`} />;
          })
        )}
      </McpPanelFrame>
    </McpPanelLayout>
  );
}

function McpToolDetailPanel(props: { server: RuntimeMcpServerDescriptor; state: McpManagerState; theme: TuiTheme }) {
  const tools = props.state.tools ?? [];
  const tool = tools[clampIndex(props.state.toolIndex ?? 0, tools.length)];
  return (
    <McpPanelLayout footer="Esc back" theme={props.theme}>
      <McpPanelFrame title={tool?.name ?? "Tool"} subtitle={props.server.name} theme={props.theme}>
        {tool ? (
          <>
            <McpDetail label="Tool name" value={tool.name} theme={props.theme} />
            {tool.description ? <McpWrappedDetail label="Description" value={tool.description} theme={props.theme} /> : null}
            <McpDetail label="Annotations" value={toolAnnotationSummary(tool)} theme={props.theme} />
            <box height={1} />
            <McpSectionTitle text="Parameters" theme={props.theme} />
            {schemaParameterLines(tool.inputSchema).length === 0 ? (
              <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  No parameters declared."}</text>
            ) : (
              schemaParameterLines(tool.inputSchema).slice(0, 12).map((line) => (
                <text key={line} fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`  ${line}`}</text>
              ))
            )}
          </>
        ) : (
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"  Tool is no longer available."}</text>
        )}
      </McpPanelFrame>
    </McpPanelLayout>
  );
}

function McpRemoveConfirmPanel(props: { server: RuntimeMcpServerDescriptor; state: McpManagerState; theme: TuiTheme }) {
  const options = ["Cancel", `Remove ${props.server.name}`];
  return (
    <McpPanelLayout footer="Up/Down choose  Enter confirm  Esc back" theme={props.theme}>
      <McpPanelFrame title="Remove MCP server" subtitle={props.server.name} theme={props.theme}>
        <text fg={props.theme.colors.status.warning} wrapMode="none" truncate>{"This removes the server from the user MCP config."}</text>
        <box height={1} />
        {options.map((option, index) => {
          const selected = index === props.state.selectedIndex;
          return <McpSelectableRow key={option} selected={selected} theme={props.theme} text={option} />;
        })}
      </McpPanelFrame>
    </McpPanelLayout>
  );
}

function McpPanelLayout(props: { footer: string; theme: TuiTheme; children: ReactNode }) {
  return (
    <box width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent="center">
      <box width={MCP_PANEL_WIDTH} maxWidth={MCP_PANEL_MAX_WIDTH} flexDirection="column">
        {props.children}
        <McpFooter text={props.footer} theme={props.theme} />
      </box>
    </box>
  );
}

function McpPanelFrame(props: { title: string; subtitle: string; theme: TuiTheme; children: ReactNode }) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.focus} backgroundColor={props.theme.colors.panel} paddingX={2} paddingY={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{props.title}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{props.subtitle}</text>
      <box height={1} />
      {props.children}
    </box>
  );
}

function McpFooter(props: { text: string; theme: TuiTheme }) {
  return (
    <box width="100%" height={1} paddingX={2}>
      <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{props.text}</text>
    </box>
  );
}

function McpMessage(props: { message: McpManagerMessage; theme: TuiTheme }) {
  const color = props.message.level === "error" ? props.theme.colors.status.error : props.theme.colors.status.info;
  const label = props.message.level === "error" ? "Error" : "Info";
  return (
    <box width="100%" height={1} backgroundColor={props.theme.colors.menu.background}>
      <text fg={color} wrapMode="none" truncate>{`${label}: ${props.message.text}`}</text>
    </box>
  );
}

function McpDetail(props: { label: string; value: string; level?: "info" | "error"; theme: TuiTheme }) {
  return (
    <text fg={props.level === "error" ? props.theme.colors.status.error : props.theme.colors.text.secondary} wrapMode="none" truncate>
      {`  ${padEnd(`${props.label}:`, MCP_DETAIL_LABEL_WIDTH)} ${compactWhitespace(props.value)}`}
    </text>
  );
}

function McpWrappedDetail(props: { label: string; value: string; theme: TuiTheme }) {
  return (
    <>
      <text fg={props.theme.colors.text.secondary} wrapMode="none" truncate>{`  ${padEnd(`${props.label}:`, MCP_DETAIL_LABEL_WIDTH)}`}</text>
      {wrapText(compactWhitespace(props.value), 96).slice(0, 4).map((line) => (
        <text key={line} fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`  ${" ".repeat(MCP_DETAIL_LABEL_WIDTH)} ${line}`}</text>
      ))}
    </>
  );
}

function McpSectionTitle(props: { text: string; theme: TuiTheme }) {
  return <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{props.text}</text>;
}

function McpSelectableRow(props: { selected: boolean; text: string; theme: TuiTheme }) {
  const marker = props.selected ? ">" : " ";
  return (
    <box width="100%" height={1} backgroundColor={props.selected ? props.theme.colors.menu.selectedBackground : props.theme.colors.panel}>
      <text
        fg={props.selected ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
        wrapMode="none"
        truncate
      >
        {`${marker} ${props.text}`}
      </text>
    </box>
  );
}

function statusGlyph(server: RuntimeMcpServerDescriptor): string {
  if (!server.enabled || server.status === "disabled") return "o";
  if (server.status === "running") return "*";
  if (server.status === "starting") return "~";
  if (server.status === "auth_required") return "!";
  if (server.status === "error") return "x";
  return "-";
}

function statusLabel(server: RuntimeMcpServerDescriptor): string {
  if (!server.enabled || server.status === "disabled") return "disabled";
  if (server.status === "auth_required") return "needs authentication";
  if (server.status === "error") return "failed";
  return server.status;
}

function serverEndpoint(server: RuntimeMcpServerDescriptor): string {
  if (server.url) return server.url;
  if (server.command) return [server.command, ...(server.args ?? [])].join(" ");
  return "";
}

function serverSubtitle(server: RuntimeMcpServerDescriptor): string {
  return `${statusLabel(server)}  ${server.transport ?? "mcp"}  tools=${server.toolCount ?? "?"}`;
}

function statusPill(server: RuntimeMcpServerDescriptor): string {
  return `${statusGlyph(server)} ${statusLabel(server)}`;
}

function mcpAuthDescription(server: RuntimeMcpServerDescriptor): string {
  if (!server.auth?.required) return "not required";
  if (server.auth.authenticated) return "authenticated";
  return server.auth.provider ? `required by ${server.auth.provider}` : "required";
}

function toolAnnotationText(tool: RuntimeMcpToolDescriptor): string {
  const summary = toolAnnotationSummary(tool);
  return summary === "none" ? "" : ` [${summary}]`;
}

function toolAnnotationSummary(tool: RuntimeMcpToolDescriptor): string {
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  const labels: string[] = [];
  if (annotations.readOnlyHint === true) labels.push("read-only");
  if (annotations.destructiveHint === true) labels.push("destructive");
  if (annotations.openWorldHint === true) labels.push("open-world");
  return labels.length > 0 ? labels.join(", ") : "none";
}

function schemaParameterLines(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? new Set(schema.required.filter((item): item is string => typeof item === "string")) : new Set<string>();
  return Object.entries(schema.properties).map(([name, value]) => {
    const property = isRecord(value) ? value : {};
    const type = typeof property.type === "string" ? property.type : "unknown";
    const description = typeof property.description === "string" ? ` - ${compactWhitespace(property.description)}` : "";
    const requiredText = required.has(name) ? " (required)" : "";
    return `${name}${requiredText}: ${type}${description}`;
  });
}

function visibleItems<T>(items: readonly T[], selectedIndex: number, maxItems: number): Array<{ item: T; index: number }> {
  if (items.length <= maxItems) return items.map((item, index) => ({ item, index }));
  const selected = clampIndex(selectedIndex, items.length);
  const half = Math.floor(maxItems / 2);
  const start = Math.min(Math.max(0, selected - half), Math.max(0, items.length - maxItems));
  return items.slice(start, start + maxItems).map((item, offset) => ({ item, index: start + offset }));
}

function wrapText(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
      continue;
    }
    line = `${line} ${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function padEnd(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}
