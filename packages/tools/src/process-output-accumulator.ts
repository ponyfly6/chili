import type { ToolCallId } from "@chili/protocol";
import { StringDecoder } from "node:string_decoder";
import type { RunProcessOutputStream, RunProcessRawOutputChunk } from "./process.js";
import { StreamingToolOutputFile, type PersistedOutput } from "./tool-output-storage.js";

const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export interface ProcessOutputSnapshot {
  preview: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | "lines_and_bytes" | null;
  totalLines: number;
  totalBytes: number;
  previewLines: number;
  previewBytes: number;
  outputPath?: string;
  persistedBytes?: number;
  persistedTruncated?: boolean;
  persistenceError?: string;
}

export interface ProcessOutputAccumulatorOptions {
  cwd: string;
  callId: ToolCallId;
  maxLines?: number;
  maxBytes?: number;
  maxPersistedBytes?: number;
  maxDirectoryBytes?: number;
}

interface StreamLineState {
  seen: boolean;
  newlines: number;
  endsWithNewline: boolean;
}

export class ProcessOutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private readonly lineStates: Record<RunProcessOutputStream, StreamLineState> = {
    stdout: { seen: false, newlines: 0, endsWithNewline: false },
    stderr: { seen: false, newlines: 0, endsWithNewline: false },
  };
  private pending = "";
  private tail = "";
  private totalBytes = 0;
  private persistenceAttempted = false;
  private persistenceError: string | undefined;
  private outputFile: StreamingToolOutputFile | undefined;
  private persisted: PersistedOutput | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private finished: ProcessOutputSnapshot | undefined;

  constructor(private readonly options: ProcessOutputAccumulatorOptions) {
    this.maxLines = normalizeLimit(options.maxLines ?? DEFAULT_MAX_LINES);
    this.maxBytes = normalizeLimit(options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  append(update: RunProcessRawOutputChunk): Promise<void> {
    if (this.finished) return Promise.reject(new Error("Cannot append after process output capture has finished"));
    this.operationQueue = this.operationQueue.then(() => this.appendUpdate(update));
    return this.operationQueue;
  }

  async finish(): Promise<ProcessOutputSnapshot> {
    if (this.finished) return this.finished;
    this.operationQueue = this.operationQueue.then(async () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const finalText = this.decoders[stream].end();
        if (finalText) await this.processText(stream, finalText);
      }
      if (this.isTruncated() && !this.persistenceAttempted) await this.startPersistence();
      if (this.outputFile) {
        try {
          this.persisted = await this.outputFile.close();
        } catch (error) {
          this.persistenceError = errorMessage(error);
        } finally {
          this.outputFile = undefined;
        }
      }
    });
    await this.operationQueue;

    const preview = this.isTruncated()
      ? takeLastBytes(takeLastLines(this.tail, this.maxLines), this.maxBytes)
      : this.pending;
    const linesExceeded = this.totalLines() > this.maxLines;
    const bytesExceeded = this.totalBytes > this.maxBytes;
    this.finished = {
      preview,
      truncated: linesExceeded || bytesExceeded,
      truncatedBy: linesExceeded && bytesExceeded
        ? "lines_and_bytes"
        : linesExceeded
          ? "lines"
          : bytesExceeded
            ? "bytes"
            : null,
      totalLines: this.totalLines(),
      totalBytes: this.totalBytes,
      previewLines: countLines(preview),
      previewBytes: Buffer.byteLength(preview, "utf8"),
      ...(this.persisted
        ? {
            outputPath: this.persisted.relativePath,
            persistedBytes: this.persisted.bytes,
            persistedTruncated: this.persisted.truncated,
          }
        : {}),
      ...(this.persistenceError ? { persistenceError: this.persistenceError } : {}),
    };
    return this.finished;
  }

  private async appendUpdate(update: RunProcessRawOutputChunk): Promise<void> {
    this.totalBytes += update.chunk.byteLength;
    const text = this.decoders[update.stream].write(update.chunk);
    if (text) await this.processText(update.stream, text);
    if (this.isTruncated() && !this.persistenceAttempted) await this.startPersistence();
  }

  private async processText(stream: RunProcessOutputStream, text: string): Promise<void> {
    updateLineState(this.lineStates[stream], text);
    this.tail = takeLastBytes(
      takeLastLines(this.tail + text, multiplyLimit(this.maxLines, 2)),
      multiplyLimit(this.maxBytes, 2),
    );

    if (!this.persistenceAttempted) {
      this.pending += text;
      return;
    }
    if (this.outputFile) {
      const outputFile = this.outputFile;
      try {
        await outputFile.append(text);
      } catch (error) {
        this.persistenceError = errorMessage(error);
        this.outputFile = undefined;
        await outputFile.close().catch(() => undefined);
      }
    }
  }

  private async startPersistence(): Promise<void> {
    this.persistenceAttempted = true;
    let outputFile: StreamingToolOutputFile | undefined;
    try {
      outputFile = await StreamingToolOutputFile.open(this.options.cwd, this.options.callId, {
        ...(this.options.maxPersistedBytes !== undefined ? { maxBytes: this.options.maxPersistedBytes } : {}),
        ...(this.options.maxDirectoryBytes !== undefined ? { maxDirectoryBytes: this.options.maxDirectoryBytes } : {}),
      });
      await outputFile.append(this.pending);
      this.outputFile = outputFile;
    } catch (error) {
      this.persistenceError = errorMessage(error);
      this.outputFile = undefined;
      await outputFile?.close().catch(() => undefined);
    } finally {
      this.pending = "";
    }
  }

  private isTruncated(): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines() > this.maxLines;
  }

  private totalLines(): number {
    return streamLineCount(this.lineStates.stdout) + streamLineCount(this.lineStates.stderr);
  }
}

function updateLineState(state: StreamLineState, text: string): void {
  if (text.length === 0) return;
  state.seen = true;
  state.endsWithNewline = text.endsWith("\n");
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) state.newlines += 1;
  }
}

function streamLineCount(state: StreamLineState): number {
  return state.newlines + (state.seen && !state.endsWithNewline ? 1 : 0);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function takeLastLines(text: string, maxLines: number): string {
  if (text.length === 0 || maxLines === Infinity) return text;
  if (maxLines <= 0) return "";
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length <= maxLines) return text;
  const tail = lines.slice(-maxLines).join("\n");
  return trailingNewline ? `${tail}\n` : tail;
}

function takeLastBytes(text: string, maxBytes: number): string {
  if (maxBytes === Infinity) return text;
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let start = Math.max(0, buffer.byteLength - Math.trunc(maxBytes));
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function normalizeLimit(value: number): number {
  if (value === Infinity) return value;
  return Math.max(0, Math.trunc(value));
}

function multiplyLimit(value: number, multiplier: number): number {
  return value === Infinity ? Infinity : value * multiplier;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
