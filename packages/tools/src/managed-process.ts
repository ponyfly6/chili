import { normalizePersistedError, type SessionId } from "@chili/protocol";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BashRunRequest, BashRunResult, BashRunner } from "./builtins/bash.js";
import type { ProcessOutputAccumulator, ProcessOutputSnapshot } from "./process-output-accumulator.js";

export interface ManagedProcessOwner {
  sessionId: SessionId;
  workspaceRoot: string;
}

export type ManagedProcessStatus = "running" | "exited" | "stopped" | "failed";

export interface ManagedProcessInfo {
  processId: string;
  status: ManagedProcessStatus;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
}

export interface ManagedProcessSnapshot extends ManagedProcessInfo {
  output: ProcessOutputSnapshot;
  result?: BashRunResult;
  error?: string;
}

export interface ManagedProcessManagerOptions {
  maxRunning?: number;
  maxCompleted?: number;
}

export interface ManagedProcessStartInput {
  owner: ManagedProcessOwner;
  runner: BashRunner;
  request: Omit<BashRunRequest, "signal" | "onOutput" | "onRawOutput">;
  capture: ProcessOutputAccumulator;
}

export interface ManagedProcessReadOptions {
  waitMs?: number;
  signal?: AbortSignal;
}

interface ManagedProcessEntry {
  owner: ManagedProcessOwner;
  info: ManagedProcessInfo;
  controller: AbortController;
  capture: ProcessOutputAccumulator;
  completion: Promise<void>;
  waiters: Set<() => void>;
  output?: ProcessOutputSnapshot;
  result?: BashRunResult;
  error?: string;
}

/** Owns non-interactive commands for one harness lifetime, including their cleanup. */
export class ManagedProcessManager {
  private readonly entries = new Map<string, ManagedProcessEntry>();
  private readonly maxRunning: number;
  private readonly maxCompleted: number;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: ManagedProcessManagerOptions = {}) {
    this.maxRunning = positiveInteger(options.maxRunning ?? 8, "maxRunning");
    this.maxCompleted = positiveInteger(options.maxCompleted ?? 32, "maxCompleted");
  }

  start(input: ManagedProcessStartInput): string {
    if (this.closed) throw new Error("Managed process manager is closed");
    if ([...this.entries.values()].filter((entry) => entry.info.status === "running").length >= this.maxRunning) {
      throw new Error(`Cannot start more than ${this.maxRunning} managed processes; stop an existing process first`);
    }
    const owner = canonicalOwner(input.owner);
    const workspaceRoot = canonicalPath(input.request.workspaceRoot);
    if (workspaceRoot !== owner.workspaceRoot) throw new Error("Process workspace does not match its owner");
    const cwd = canonicalPath(input.request.cwd);
    const local = relative(workspaceRoot, cwd);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error("Process working directory must remain inside its workspace");
    }
    const processId = `process_${randomUUID()}`;
    const entry: ManagedProcessEntry = {
      owner,
      info: { processId, status: "running", command: input.request.command, cwd, startedAt: Date.now() },
      controller: new AbortController(),
      capture: input.capture,
      completion: Promise.resolve(),
      waiters: new Set(),
    };
    const request = {
      ...input.request,
      workspaceRoot,
      cwd,
      ...(input.request.env ? { env: { ...input.request.env } } : {}),
    };
    const runner = input.runner;
    this.entries.set(processId, entry);
    // Register before invoking a runner, which may throw or finish synchronously.
    // Deferring also lets close/stop cancel a launch before it starts.
    entry.completion = Promise.resolve().then(() => this.run(entry, runner, request));
    return processId;
  }

  async read(
    owner: ManagedProcessOwner,
    processId: string,
    options: ManagedProcessReadOptions = {},
  ): Promise<ManagedProcessSnapshot> {
    const entry = this.ownedEntry(owner, processId);
    throwIfAborted(options.signal);
    const requestedWait = options.waitMs ?? 0;
    if (!Number.isFinite(requestedWait) || requestedWait < 0) throw new Error("waitMs must be a non-negative number");
    if (entry.info.status === "running" && requestedWait > 0) {
      await waitForCompletion(entry, Math.min(30_000, requestedWait), options.signal);
    }
    throwIfAborted(options.signal);
    const snapshot = await this.snapshot(entry);
    throwIfAborted(options.signal);
    return snapshot;
  }

  list(owner: ManagedProcessOwner): ManagedProcessInfo[] {
    const canonical = canonicalOwner(owner);
    return [...this.entries.values()]
      .filter((entry) => sameOwner(entry.owner, canonical))
      .map((entry) => ({ ...entry.info }));
  }

  async stop(owner: ManagedProcessOwner, processId: string): Promise<ManagedProcessSnapshot> {
    const entry = this.ownedEntry(owner, processId);
    this.requestStop(entry, "Process stopped");
    await entry.completion;
    return this.snapshot(entry);
  }

  async stopSession(sessionId: SessionId, reason = "Session stopped"): Promise<boolean> {
    const running = [...this.entries.values()]
      .filter((entry) => entry.owner.sessionId === sessionId && entry.info.status === "running");
    for (const entry of running) this.requestStop(entry, reason);
    await Promise.all(running.map((entry) => entry.completion));
    return running.length > 0;
  }

  close(reason = "Runtime closed"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const entries = [...this.entries.values()];
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClose = resolvePromise;
      rejectClose = rejectPromise;
    });
    // Abort listeners can synchronously reenter close; publish its one promise first.
    for (const entry of entries) this.requestStop(entry, reason);
    void Promise.all(entries.map((entry) => entry.completion)).then(() => resolveClose(), rejectClose);
    return this.closePromise;
  }

  private async run(
    entry: ManagedProcessEntry,
    runner: BashRunner,
    request: ManagedProcessStartInput["request"],
  ): Promise<void> {
    try {
      throwIfAborted(entry.controller.signal);
      entry.result = await runner.run({
        ...request,
        signal: entry.controller.signal,
        onOutput: undefined,
        onRawOutput: (chunk) => entry.capture.append(chunk),
      });
    } catch (error) {
      if (!entry.controller.signal.aborted) entry.error = normalizePersistedError(error).message;
    }
    try {
      entry.output = await entry.capture.finish();
    } catch (error) {
      entry.error ??= normalizePersistedError(error).message;
      entry.output = emptyOutput();
    }
    entry.info.status = entry.controller.signal.aborted ? "stopped" : entry.error !== undefined ? "failed" : "exited";
    entry.info.finishedAt = Date.now();
    this.pruneCompleted();
    for (const wake of entry.waiters) wake();
  }

  private requestStop(entry: ManagedProcessEntry, reason: string): void {
    if (entry.info.status === "running" && !entry.controller.signal.aborted) entry.controller.abort(reason);
  }

  private ownedEntry(owner: ManagedProcessOwner, processId: string): ManagedProcessEntry {
    const canonical = canonicalOwner(owner);
    const entry = this.entries.get(processId);
    if (!entry || !sameOwner(entry.owner, canonical)) {
      throw new Error("Managed process is not available in this session and workspace");
    }
    return entry;
  }

  private async snapshot(entry: ManagedProcessEntry): Promise<ManagedProcessSnapshot> {
    const currentOutput = entry.output ?? await entry.capture.snapshot();
    const output = entry.output ?? currentOutput;
    return {
      ...entry.info,
      output: { ...output },
      ...(entry.result ? { result: { ...entry.result } } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
  }

  private pruneCompleted(): void {
    const completed = [...this.entries.values()]
      .filter((entry) => entry.info.status !== "running")
      .sort((left, right) => left.info.finishedAt! - right.info.finishedAt!);
    for (const entry of completed.slice(0, Math.max(0, completed.length - this.maxCompleted))) {
      this.entries.delete(entry.info.processId);
    }
  }
}

function canonicalOwner(owner: ManagedProcessOwner): ManagedProcessOwner {
  return { sessionId: owner.sessionId, workspaceRoot: canonicalPath(owner.workspaceRoot) };
}

function canonicalPath(path: string): string {
  return realpathSync.native(resolve(path));
}

function sameOwner(left: ManagedProcessOwner, right: ManagedProcessOwner): boolean {
  return left.sessionId === right.sessionId && left.workspaceRoot === right.workspaceRoot;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Process operation aborted");
  error.name = "AbortError";
  throw error;
}

function waitForCompletion(entry: ManagedProcessEntry, waitMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      entry.waiters.delete(wake);
      if (error) rejectWait(error);
      else resolveWait();
    };
    const abort = (): void => {
      const error = new Error("Process read aborted");
      error.name = "AbortError";
      finish(error);
    };
    const wake = (): void => finish();
    const timer = setTimeout(() => finish(), waitMs);
    entry.waiters.add(wake);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function emptyOutput(): ProcessOutputSnapshot {
  return {
    preview: "",
    truncated: false,
    truncatedBy: null,
    totalLines: 0,
    totalBytes: 0,
    previewLines: 0,
    previewBytes: 0,
  };
}
