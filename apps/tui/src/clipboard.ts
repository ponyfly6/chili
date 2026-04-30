import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLIPBOARD_TIMEOUT_MS = 1200;
const CLIPBOARD_MAX_BUFFER = 8 * 1024 * 1024;

export interface ClipboardAccess {
  readText: () => Promise<string | undefined>;
  writeText: (text: string) => Promise<boolean>;
}

export const systemClipboard: ClipboardAccess = {
  readText: readClipboardText,
  writeText: writeClipboardText,
};

export function promptClipboardText(text: string): string {
  return cleanClipboardText(text)?.replace(/\n/g, " ") ?? "";
}

export function promptPasteBytes(bytes: Uint8Array): string {
  return promptClipboardText(decodePasteBytes(bytes));
}

export function cleanClipboardText(text: string): string | undefined {
  const cleaned = stripAnsiSequences(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
  if (!cleaned) return undefined;
  if (/^[\s\u2500-\u259f\u2800-\u28ff]+$/u.test(cleaned)) return undefined;
  return cleaned;
}

async function readClipboardText(): Promise<string | undefined> {
  for (const command of readCommands()) {
    try {
      const { stdout } = await execFileAsync(command.command, command.args, {
        timeout: CLIPBOARD_TIMEOUT_MS,
        maxBuffer: CLIPBOARD_MAX_BUFFER,
      });
      return stdout;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function writeClipboardText(text: string): Promise<boolean> {
  for (const command of writeCommands()) {
    if (await writeToCommand(command.command, command.args, text)) return true;
  }
  return false;
}

function readCommands(): Array<{ command: string; args: string[] }> {
  if (process.platform === "darwin") return [{ command: "pbpaste", args: [] }];
  if (process.platform === "win32") {
    return [
      { command: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] },
      { command: "pwsh", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] },
    ];
  }
  return [
    { command: "wl-paste", args: ["--no-newline"] },
    { command: "xclip", args: ["-selection", "clipboard", "-out"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ];
}

function writeCommands(): Array<{ command: string; args: string[] }> {
  if (process.platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (process.platform === "win32") {
    return [
      { command: "powershell.exe", args: ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] },
      { command: "pwsh", args: ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] },
    ];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard", "-in"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

async function writeToCommand(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(ok);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);

    child.on("error", () => {
      finish(false);
    });
    child.on("close", (code) => {
      finish(code === 0);
    });
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}
