#!/usr/bin/env bun
import {
  applyRuntimeEvent,
  createRuntimeView,
  HttpRuntimeClient,
  teamLiveCockpit,
  type ChiliRuntimeView,
  type RunTeamLoopRequest,
} from "@chili/sdk";
import type { SessionId, TeamId, ThreadId } from "@chili/protocol";
import { renderTeamLiveCockpit, selectedTeamId } from "./render.js";

interface TuiOptions {
  baseUrl: string;
  teamId?: TeamId;
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
  runLoop: boolean;
  once: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

class TeamLiveTui {
  private readonly client: HttpRuntimeClient;
  private view: ChiliRuntimeView = createRuntimeView();
  private selectedTeamIndex = 0;
  private detailOpen = false;
  private streamAbort: AbortController | undefined;
  private streamVersion = 0;
  private closed = false;
  private message = "connecting";
  private error: string | undefined;
  private resolveClosed: (() => void) | undefined;
  private runLoopAbort: AbortController | undefined;

  constructor(private readonly options: TuiOptions) {
    this.client = new HttpRuntimeClient({ baseUrl: options.baseUrl });
  }

  async run(): Promise<void> {
    this.enterTerminal();
    this.connect();
    this.maybeRunTeamLoop();
    this.render();

    await new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  private connect(): void {
    this.streamAbort?.abort();
    const controller = new AbortController();
    this.streamAbort = controller;
    const version = ++this.streamVersion;
    this.message = "streaming";
    this.error = undefined;

    void (async () => {
      try {
        const input: Parameters<HttpRuntimeClient["streamEvents"]>[0] = { signal: controller.signal };
        if (this.options.sessionId) input.sessionId = this.options.sessionId;
        if (this.options.threadId) input.threadId = this.options.threadId;
        for await (const event of this.client.streamEvents(input)) {
          if (this.closed || version !== this.streamVersion) return;
          applyRuntimeEvent(this.view, event);
          this.message = `last event: ${event.type}`;
          this.error = undefined;
          this.render();
        }
        if (!this.closed && version === this.streamVersion) {
          this.message = "stream ended";
          this.render();
        }
      } catch (error) {
        if (this.closed || controller.signal.aborted || version !== this.streamVersion) return;
        this.error = toError(error).message;
        this.render();
      }
    })();
  }

  private refresh(): void {
    this.view = createRuntimeView();
    this.message = "refreshing";
    this.error = undefined;
    this.connect();
    this.render();
  }

  private maybeRunTeamLoop(): void {
    if (!this.options.runLoop) return;
    if (!this.options.teamId) {
      this.error = "--run-loop requires --team";
      return;
    }

    const controller = new AbortController();
    this.runLoopAbort = controller;
    const input: RunTeamLoopRequest = {
      teamId: this.options.teamId,
      once: this.options.once,
      signal: controller.signal,
    };
    if (this.options.sessionId) input.sessionId = this.options.sessionId;
    if (this.options.threadId) input.threadId = this.options.threadId;
    if (this.options.cwd) input.cwd = this.options.cwd;
    if (this.options.maxCycles !== undefined) input.maxCycles = this.options.maxCycles;
    if (this.options.timeoutMs !== undefined) input.timeoutMs = this.options.timeoutMs;
    if (this.options.pollIntervalMs !== undefined) input.pollIntervalMs = this.options.pollIntervalMs;

    void this.client.runTeamLoop(input).catch((error) => {
      if (this.closed) return;
      this.error = toError(error).message;
      this.render();
    });
  }

  private render(): void {
    if (this.closed) return;
    const allTeamsInput: Parameters<typeof teamLiveCockpit>[1] = {};
    if (this.options.sessionId) allTeamsInput.sessionId = this.options.sessionId;
    const allTeams = teamLiveCockpit(this.view, allTeamsInput);
    if (allTeams.teams.length > 0) {
      this.selectedTeamIndex = clamp(this.selectedTeamIndex, 0, allTeams.teams.length - 1);
    } else {
      this.selectedTeamIndex = 0;
    }

    const selectedId = this.options.teamId ?? selectedTeamId(allTeams, this.selectedTeamIndex);
    const selectedIndex = selectedId ? Math.max(0, allTeams.teams.findIndex((team) => team.id === selectedId)) : this.selectedTeamIndex;
    const cockpitInput: Parameters<typeof teamLiveCockpit>[1] = { limit: 20 };
    if (selectedId) cockpitInput.teamId = selectedId;
    if (this.options.sessionId) cockpitInput.sessionId = this.options.sessionId;
    const cockpit = teamLiveCockpit(this.view, cockpitInput);

    const renderInput: Parameters<typeof renderTeamLiveCockpit>[1] = {
      width: process.stdout.columns ?? 100,
      height: process.stdout.rows ?? 32,
      selectedTeamIndex: selectedIndex,
      detailOpen: this.detailOpen,
      message: this.message,
    };
    if (this.error) renderInput.error = this.error;
    const output = renderTeamLiveCockpit(cockpit, renderInput);
    process.stdout.write(`\x1b[H${output}`);
  }

  private enterTerminal(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    process.on("SIGINT", this.onSigint);
  }

  private leaveTerminal(): void {
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    process.off("SIGINT", this.onSigint);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  private stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.streamAbort?.abort();
    this.runLoopAbort?.abort();
    this.leaveTerminal();
    this.resolveClosed?.();
  }

  private readonly onResize = (): void => {
    this.render();
  };

  private readonly onSigint = (): void => {
    this.stop();
  };

  private readonly onData = (chunk: Buffer): void => {
    const key = chunk.toString("utf8");
    if (key === "q" || key === "\u0003") {
      this.stop();
      return;
    }
    if (key === "r") {
      this.refresh();
      return;
    }
    if (key === "\r" || key === "\n") {
      this.detailOpen = !this.detailOpen;
      this.render();
      return;
    }
    if (key === "\x1b[A") {
      this.selectedTeamIndex = Math.max(0, this.selectedTeamIndex - 1);
      this.render();
      return;
    }
    if (key === "\x1b[B") {
      this.selectedTeamIndex++;
      this.render();
    }
  };
}

export function parseArgs(argv: readonly string[]): TuiOptions | "help" {
  const options: TuiOptions = {
    baseUrl: process.env.CHILI_RUNTIME_URL ?? "http://127.0.0.1:4777",
    runLoop: false,
    once: false,
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

function usage(): string {
  return [
    "Usage: chili-tui --url <runtime-url> [--team <team-id>] [--session <session-id>] [--thread <thread-id>]",
    "",
    "Options:",
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  await new TeamLiveTui(options).run();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(toError(error).message);
    process.exitCode = 1;
  });
}
