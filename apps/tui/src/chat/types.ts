export interface PromptPart {
  type: "text";
  text: string;
}

export type LocalTranscriptItem =
  | { id: string; kind: "local"; level: "info" | "error"; text: string; persistent?: boolean | undefined }
  | {
      id: string;
      kind: "shell";
      command: string;
      cwd: string;
      status: "running" | "completed" | "failed";
      output: string;
      exitCode?: number | null | undefined;
      signal?: string | null | undefined;
      durationMs?: number | undefined;
      timedOut?: boolean | undefined;
      stdoutTruncated?: boolean | undefined;
      stderrTruncated?: boolean | undefined;
      error?: string | undefined;
    };
