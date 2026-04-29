#!/usr/bin/env bun
import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { HttpRuntimeClient } from "@chili/sdk";
import type { SessionId, TeamId, ThreadId } from "@chili/protocol";
import { ChatShellApp, type ChatShellOptions } from "./ChatShellApp.js";
import { TeamLiveApp } from "./TeamLiveApp.js";
export { teamLiveStreamInput, type TeamLiveStreamScopeInput } from "./useTeamLiveRuntime.js";

export interface TuiOptions extends ChatShellOptions {
  teamLive: boolean;
}

export function parseArgs(argv: readonly string[]): TuiOptions | "help" {
  const options: TuiOptions = {
    baseUrl: process.env.CHILI_RUNTIME_URL ?? "http://127.0.0.1:4777",
    runLoop: false,
    once: false,
    teamLive: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--url") {
      options.baseUrl = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--team") {
      options.teamId = requireValue(argv, ++index, arg) as TeamId;
      continue;
    }
    if (arg === "--team-live") {
      options.teamLive = true;
      continue;
    }
    if (arg === "--session") {
      options.sessionId = requireValue(argv, ++index, arg) as SessionId;
      continue;
    }
    if (arg === "--thread") {
      options.threadId = requireValue(argv, ++index, arg) as ThreadId;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--run-loop") {
      options.runLoop = true;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--max-cycles") {
      options.maxCycles = numberValue(requireValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = numberValue(requireValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = numberValue(requireValue(argv, ++index, arg), arg);
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
    "Usage: chili-tui --url <runtime-url> [--team <team-id>] [--session <session-id>] [--thread <thread-id>]",
    "",
    "Options:",
    "  --team-live           Open the team cockpit directly.",
    "  --run-loop             Trigger SDK runTeamLoop for --team.",
    "  --once                 Pass once=true to runTeamLoop.",
    "  --cwd <path>           CWD passed to runTeamLoop.",
    "  --max-cycles <n>       Max cycles passed to runTeamLoop.",
    "  --timeout-ms <n>       Timeout passed to runTeamLoop.",
    "  --poll-interval-ms <n> Poll interval passed to runTeamLoop.",
  ].join("\n");
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function numberValue(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative number`);
  return Math.trunc(parsed);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    console.log(usage());
    return;
  }

  const client = new HttpRuntimeClient({ baseUrl: options.baseUrl });
  const renderer = await createCliRenderer(rendererConfig());
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.unmount();
      renderer.destroy();
      resolve();
    };

    root.render(options.teamLive
      ? <TeamLiveApp client={client} options={options} onExit={close} />
      : <ChatShellApp client={client} options={options} onExit={close} />);
    renderer.start();
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(toError(error).message);
    process.exitCode = 1;
  });
}
