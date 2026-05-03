import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { SessionId, ThreadId } from "@chili/protocol";
import { formatResumeCommand, parseArgs, teamLiveStreamInput } from "./index.js";
import { generateSystemTheme, initialTuiThemeId, resolveTuiTheme } from "./theme/index.js";

test("parses runtime flags and keeps Team Live stream unscoped for child-session events", () => {
  const controller = new AbortController();

  expect(parseArgs([])).toMatchObject({
    baseUrl: "http://127.0.0.1:4777",
    runLoop: false,
    once: false,
    teamLive: false,
  });
  expect(parseArgs(["--url", "http://runtime.test", "--team", "team_live", "--team-live", "--run-loop", "--once", "--theme", "chili-light", "--max-cycles", "2"])).toMatchObject({
    baseUrl: "http://runtime.test",
    teamId: "team_live",
    teamLive: true,
    runLoop: true,
    once: true,
    themeId: "chili-light",
    maxCycles: 2,
  });
  expect(parseArgs(["--resume", "session_resume", "--thread", "thread_resume"])).toMatchObject({
    sessionId: "session_resume",
    threadId: "thread_resume",
  });

  const streamInput = teamLiveStreamInput(
    { sessionId: "session_live" as SessionId, threadId: "thread_live" as ThreadId },
    controller.signal,
    "event_live",
  );
  expect(streamInput.signal).toBe(controller.signal);
  expect(streamInput.afterEventId).toBe("event_live");
  expect(streamInput.sessionId).toBeUndefined();
  expect(streamInput.threadId).toBeUndefined();

  const scopedStreamInput = teamLiveStreamInput(
    { sessionId: "session_resume" as SessionId, threadId: "thread_resume" as ThreadId, streamScope: "session" },
    controller.signal,
  );
  expect(scopedStreamInput.sessionId).toBe("session_resume" as SessionId);
  expect(scopedStreamInput.threadId).toBe("thread_resume" as ThreadId);
});

test("formats a resume command when a chat session and thread are available", () => {
  expect(formatResumeCommand({
    sessionId: "session_resume" as SessionId,
    threadId: "thread_resume" as ThreadId,
    cwd: "/repo/chili",
  })).toBe("chili --cwd /repo/chili --resume session_resume --thread thread_resume");
  expect(formatResumeCommand({
    sessionId: "session_resume" as SessionId,
    threadId: "thread_resume" as ThreadId,
  })).toBe("chili --resume session_resume --thread thread_resume");
  expect(formatResumeCommand({
    sessionId: "session_resume" as SessionId,
  })).toBeUndefined();
});

test("apps/tui source does not import core, server, or store packages", async () => {
  const root = tuiSourceRoot();
  const files = await sourceFiles(root);
  const forbidden = /from\s+["'](?:@chili\/(?:core|server|store)|.*packages\/(?:core|server|store)\b)/;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, relative(root, file)).not.toMatch(forbidden);
  }
});

test("status footer does not keep a local model context catalog", async () => {
  const source = await readFile(join(tuiSourceRoot(), "chat", "StatusFooter.tsx"), "utf8");

  expect(source).not.toContain("KNOWN_CONTEXT_WINDOWS");
  expect(source).not.toContain("deepseek-v4-pro");
  expect(source).not.toContain("MiniMax-M2.7");
});

test("resolves the default TUI theme", () => {
  expect(initialTuiThemeId(undefined, {})).toBe("system");
  expect(resolveTuiTheme(undefined, {})).toMatchObject({
    id: "chili-dark",
    name: "Chili Dark",
  });
});

test("falls back to the default TUI theme for unknown names", () => {
  const systemTheme = generateSystemTheme({
    defaultBackground: "#101820",
    defaultForeground: "#f8f8f2",
    palette: ["#000000", "#ff5555", "#50fa7b", "#f1fa8c", "#8be9fd", "#ff79c6", "#7ee7c8", "#bbbbbb"],
  });

  expect(resolveTuiTheme("does-not-exist", {}, { systemTheme })).toMatchObject({
    id: "system",
  });
});

test("resolves TUI theme from CHILI_TUI_THEME", () => {
  expect(resolveTuiTheme(undefined, { CHILI_TUI_THEME: "terminal-dark" })).toMatchObject({
    id: "terminal-dark",
    name: "Terminal Dark",
  });
});

test("resolves light TUI themes", () => {
  expect(resolveTuiTheme("chili-light", {})).toMatchObject({
    id: "chili-light",
    name: "Chili Light",
    colors: {
      background: "#fbfbf8",
      text: { primary: "#1f2328" },
    },
  });
  expect(resolveTuiTheme("warm-light", {})).toMatchObject({
    id: "warm-light",
    name: "Warm Light",
    colors: {
      background: "#faf6ee",
      text: { primary: "#292524" },
    },
  });
});

test("system TUI theme falls back to the default when unavailable", () => {
  expect(resolveTuiTheme("system", {})).toMatchObject({
    id: "chili-dark",
    name: "Chili Dark",
  });
});

test("system TUI theme resolves from a generated palette theme when available", () => {
  const systemTheme = generateSystemTheme({
    defaultBackground: "#101820",
    defaultForeground: "#f8f8f2",
    palette: ["#000000", "#ff5555", "#50fa7b", "#f1fa8c", "#8be9fd", "#ff79c6", "#7ee7c8", "#bbbbbb"],
  });

  expect(resolveTuiTheme("system", {}, { systemTheme })).toMatchObject({
    id: "system",
    colors: {
      background: "#101820",
    },
  });
});

test("generates a system TUI theme from a terminal palette", () => {
  const theme = generateSystemTheme({
    defaultBackground: "#101820",
    defaultForeground: "#f8f8f2",
    palette: ["#000000", "#ff5555", "#50fa7b", "#f1fa8c", "#8be9fd", "#ff79c6", "#7ee7c8", "#bbbbbb"],
  });

  expect(theme).toMatchObject({
    id: "system",
    name: "System",
    colors: {
      background: "#101820",
      text: { primary: "#f8f8f2" },
      accent: { primary: "#7ee7c8" },
      status: {
        error: "#ff5555",
        success: "#50fa7b",
        warning: "#f1fa8c",
      },
    },
  });
});

test("system TUI theme generation tolerates invalid palette colors", () => {
  expect(() => generateSystemTheme({
    defaultBackground: "not-a-color",
    defaultForeground: "#12",
    palette: ["black", "red", undefined, null, "#12345678", "rgb(0 0 0)", "#abc"],
  })).not.toThrow();
  expect(generateSystemTheme({
    defaultBackground: "not-a-color",
    defaultForeground: "#12",
    palette: ["black", "red", undefined, null, "#12345678", "rgb(0 0 0)", "#abc"],
  })).toMatchObject({
    id: "system",
    colors: {
      background: "#050505",
      accent: { primary: "#aabbcc" },
    },
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await sourceFiles(path));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) output.push(path);
  }
  return output;
}

function tuiSourceRoot(): string {
  if (basename(import.meta.dir) === "dist") return join(import.meta.dir, "..", "src");
  return import.meta.dir;
}
