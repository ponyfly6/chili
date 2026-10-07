export type SettingsPage = "general" | "models" | "permissions" | "tools" | "memory" | "phone";

export const settingsPages: readonly { id: SettingsPage; label: string; description: string }[] = [
  { id: "general", label: "通用", description: "让 Chili 更合你的习惯。" },
  { id: "models", label: "模型与账号", description: "选择处理当前会话的模型。" },
  { id: "permissions", label: "权限与协作", description: "决定 Chili 可以做什么，如何分工。" },
  { id: "tools", label: "工具与技能", description: "连接资料、服务和可复用的工作方法。" },
  { id: "memory", label: "偏好与记忆", description: "沿用这个目录里的说明与工作约定。" },
  { id: "phone", label: "手机连接", description: "在同一私网内，接着电脑上的会话。" },
];

export const desktopCommands = [
  { id: "review", label: "检查最近的修改", group: "prompt", prompt: "请检查最近的修改，指出问题和需要改进的地方。" },
  { id: "help", label: "看看可以做什么", group: "prompt", prompt: "根据当前目录，告诉我你可以帮我做什么。" },
  { id: "settings", label: "打开设置", group: "settings", page: "general" },
  { id: "model", label: "选择模型", group: "settings", page: "models" },
  { id: "permissions", label: "权限与协作", group: "settings", page: "permissions" },
  { id: "mcp", label: "管理工具连接", group: "settings", page: "tools" },
  { id: "skills", label: "查看可用技能", group: "settings", page: "tools" },
  { id: "memory", label: "偏好与目录说明", group: "settings", page: "memory" },
  { id: "advanced", label: "配置高级任务", group: "advanced" },
] as const;
export type DesktopCommand = (typeof desktopCommands)[number];

export function matchingDesktopCommands(text: string): readonly DesktopCommand[] {
  if (!/^\/[^\s]*$/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return desktopCommands.filter((command) => command.id.startsWith(query));
}

export function conversationTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return Array.from(line).slice(0, 36).join("") || "新会话";
}

export { defaultReadingPreferences, parseReadingPreferences, type ReadingPreferences } from "../shared/reading-preferences.js";
