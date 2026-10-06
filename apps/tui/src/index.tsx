#!/usr/bin/env bun
import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { HttpRuntimeClient } from "@chili/sdk";
import type { SessionId } from "@chili/protocol";
import { basename, resolve } from "node:path";
import { ChatShellApp, type ChatShellExitInfo, type ChatShellOptions } from "./ChatShellApp.js";
import { detectSystemTheme } from "./theme/index.js";
export { runtimeStreamInput } from "./useRuntimeEvents.js";

export type TuiOptions = ChatShellOptions;

export function parseArgs(argv: readonly string[]): TuiOptions | "help" {
  const options: TuiOptions = {
    baseUrl: process.env.CHILI_RUNTIME_URL ?? "http://127.0.0.1:4777",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--url") {
      options.baseUrl = requireValue(argv, ++index, arg);
      continue;
    }


    if (arg === "--session" || arg === "--resume") {
      options.sessionId = requireValue(argv, ++index, arg) as SessionId;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--theme") {
      options.themeId = requireValue(argv, ++index, arg);
      continue;
    }





    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function rendererConfig(): CliRendererConfig {
  return {
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    clearOnShutdown: true,
    exitOnCtrlC: false,
    gatherStats: false,
    targetFps: 30,
    useMouse: true,
    autoFocus: false,
    openConsoleOnError: false,
    useKittyKeyboard: {},
  };
}

function usage(): string {
  return [
    "Usage: chili-tui --url <runtime-url> [--resume <session-id>]",
    "",
    "Options:",
    "  --resume <session-id> Resume a chat session. Alias for --session.",
    "  --session <session-id> Select a chat session.",
    "  --cwd <path>           Working directory for this chat.",
    "  --theme <theme-id>     Initial TUI theme.",
  ].join("\n");
}

export function formatTerminalTitle(cwd: string, appName = "🌶️"): string {
  const directory = basename(resolve(cwd)) || "root";
  return sanitizeTerminalTitle(`${appName}-${directory}`);
}

export function terminalTitleSequence(title: string): string {
  return `\x1b]0;${sanitizeTerminalTitle(title)}\x07`;
}

function setTerminalTitle(title: string): void {
  process.stdout.write(terminalTitleSequence(title));
}

function sanitizeTerminalTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function formatResumeCommand(info: ChatShellExitInfo | undefined): string | undefined {
  if (!info?.sessionId) return undefined;
  const cwd = info.cwd ? ` --cwd ${shellQuote(info.cwd)}` : "";
  return `chili${cwd} --resume ${shellQuote(info.sessionId)}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    console.log(usage());
    return;
  }

  options.cwd = resolve(options.cwd ?? process.cwd());

  setTerminalTitle(formatTerminalTitle(options.cwd));

  const client = new HttpRuntimeClient({ baseUrl: options.baseUrl });
  const renderer = await createCliRenderer(rendererConfig());
  const systemTheme = await detectSystemTheme(renderer);
  if (systemTheme) options.systemTheme = systemTheme;
  const root = createRoot(renderer);
  let exitInfo: ChatShellExitInfo | undefined;

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = (info?: ChatShellExitInfo) => {
      if (closed) return;
      closed = true;
      exitInfo = info;
      root.unmount();
      renderer.destroy();
      resolve();
    };

    root.render(<ChatShellApp client={client} options={options} onExit={close} />);
    renderer.start();
  });

  const resumeCommand = formatResumeCommand(exitInfo);
  if (resumeCommand) {
    console.log(`Resume this session: ${resumeCommand}`);
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(toError(error).message);
    process.exitCode = 1;
  });
}
