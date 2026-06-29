export type PromptPart =
  | { type: "text"; text: string }
  | { type: "paste"; marker: string; text: string };

export type LocalTranscriptItem =
  | { id: string; kind: "local"; level: "info" | "error"; text: string; createdAt?: number | undefined; persistent?: boolean | undefined }
  | {
      id: string;
      kind: "shell";
      command: string;
      cwd: string;
      createdAt?: number | undefined;
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
