import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLIPBOARD_TIMEOUT_MS = 1200;
const CLIPBOARD_MAX_BUFFER = 32 * 1024 * 1024;
const CLIPBOARD_MAX_APPLESCRIPT_BUFFER = CLIPBOARD_MAX_BUFFER * 3;
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface ClipboardAccess {
  readText: () => Promise<string | undefined>;
  readImage?: () => Promise<ClipboardImage | undefined>;
  writeText: (text: string) => Promise<boolean>;
}

export const systemClipboard: ClipboardAccess = {
  readText: readClipboardText,
  readImage: readClipboardImage,
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

async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  const image = process.platform === "darwin"
    ? await readDarwinClipboardImage()
    : process.platform === "win32"
      ? await readWindowsClipboardImage()
      : await readLinuxClipboardImage();
  return image ?? readClipboardImageFilePath();
}

async function readDarwinClipboardImage(): Promise<ClipboardImage | undefined> {
  const pastedPng = await readBinaryCommand("pngpaste", ["-"]);
  if (pastedPng && isPng(pastedPng)) return imageResult(pastedPng, "image/png", "png");

  const png = await readMacPasteboardData("PNGf");
  if (png && isPng(png)) return imageResult(png, "image/png", "png");

  const jpeg = await readMacPasteboardData("JPEG");
  if (jpeg && isJpeg(jpeg)) return imageResult(jpeg, "image/jpeg", "jpg");

  const tiff = await readMacPasteboardData("TIFF");
  if (tiff) return convertTiffToPng(tiff);

  return undefined;
}

async function readMacPasteboardData(dataClass: string): Promise<Buffer | undefined> {
  const fileData = await readMacPasteboardDataFile(dataClass);
  if (fileData) return fileData;

  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e", "try",
      "-e", `the clipboard as «class ${dataClass}»`,
      "-e", "on error",
      "-e", "return \"\"",
      "-e", "end try",
    ], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: CLIPBOARD_MAX_APPLESCRIPT_BUFFER,
    });
    return parseAppleScriptData(stdout);
  } catch {
    return undefined;
  }
}

async function readMacPasteboardDataFile(dataClass: string): Promise<Buffer | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "chili-clipboard-"));
  const output = join(dir, `clipboard-${dataClass}.bin`);
  const script = [
    "try",
    `set clipboard_data to (the clipboard as «class ${dataClass}»)`,
    `set fp to open for access POSIX file "${output.replace(/"/g, "\\\"")}" with write permission`,
    "set eof of fp to 0",
    "write clipboard_data to fp",
    "close access fp",
    "return \"ok\"",
    "on error",
    "try",
    "close access fp",
    "end try",
    "return \"\"",
    "end try",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (stdout.trim() !== "ok") return undefined;
    const info = await stat(output);
    if (!info.isFile() || info.size <= 0 || info.size > CLIPBOARD_MAX_BUFFER) return undefined;
    return await readFile(output);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readMacPasteboardFilePath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e", "try",
      "-e", "get POSIX path of (the clipboard as «class furl»)",
      "-e", "on error",
      "-e", "return \"\"",
      "-e", "end try",
    ], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return cleanImagePath(stdout);
  } catch {
    return undefined;
  }
}

async function convertTiffToPng(tiff: Uint8Array): Promise<ClipboardImage | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "chili-clipboard-"));
  const source = join(dir, "clipboard.tiff");
  const output = join(dir, "clipboard.png");
  try {
    await writeFile(source, tiff);
    await execFileAsync("sips", ["-s", "format", "png", source, "--out", output], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: CLIPBOARD_MAX_BUFFER,
    });
    const png = await readFile(output);
    return isPng(png) ? imageResult(png, "image/png", "png") : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readWindowsClipboardImage(): Promise<ClipboardImage | undefined> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img=[Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $img) { exit 1 }",
    "$ms=New-Object IO.MemoryStream",
    "$img.Save($ms,[Drawing.Imaging.ImageFormat]::Png)",
    "[Convert]::ToBase64String($ms.ToArray())",
  ].join("; ");
  for (const command of ["powershell.exe", "pwsh"]) {
    try {
      const { stdout } = await execFileAsync(command, ["-NoProfile", "-Command", script], {
        timeout: CLIPBOARD_TIMEOUT_MS,
        maxBuffer: CLIPBOARD_MAX_BUFFER * 2,
      });
      const png = Buffer.from(stdout.trim(), "base64");
      if (isPng(png)) return imageResult(png, "image/png", "png");
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readLinuxClipboardImage(): Promise<ClipboardImage | undefined> {
  for (const command of linuxImageReadCommands()) {
    const bytes = await readBinaryCommand(command.command, command.args);
    if (bytes && imageMatchesMime(bytes, command.mimeType)) return imageResult(bytes, command.mimeType, command.extension);
  }
  return undefined;
}

async function readClipboardImageFilePath(): Promise<ClipboardImage | undefined> {
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    const filePath = await readMacPasteboardFilePath();
    if (filePath) candidates.push(filePath);
  }

  const text = await readClipboardText().catch(() => undefined);
  if (text) candidates.push(...imagePathsFromText(text));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const image = await readImageFile(candidate);
    if (image) return image;
  }
  return undefined;
}

async function readImageFile(filePath: string): Promise<ClipboardImage | undefined> {
  const cleaned = cleanImagePath(filePath);
  if (!cleaned || !isAbsolute(cleaned)) return undefined;
  const extension = extname(cleaned).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) return undefined;

  try {
    const info = await stat(cleaned);
    if (!info.isFile() || info.size <= 0 || info.size > CLIPBOARD_MAX_BUFFER) return undefined;
    const bytes = await readFile(cleaned);
    if (!imageMatchesMime(bytes, mimeType)) return undefined;
    return imageResult(bytes, mimeType, extension.slice(1) === "jpeg" ? "jpg" : extension.slice(1));
  } catch {
    return undefined;
  }
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

function linuxImageReadCommands(): Array<{ command: string; args: string[]; mimeType: string; extension: string }> {
  return [
    { command: "wl-paste", args: ["--no-newline", "--type", "image/png"], mimeType: "image/png", extension: "png" },
    { command: "wl-paste", args: ["--no-newline", "--type", "image/jpeg"], mimeType: "image/jpeg", extension: "jpg" },
    { command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-out"], mimeType: "image/png", extension: "png" },
    { command: "xclip", args: ["-selection", "clipboard", "-t", "image/jpeg", "-out"], mimeType: "image/jpeg", extension: "jpg" },
  ];
}

function imagePathsFromText(text: string): string[] {
  const paths = text
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((part) => part.split("\n"))
    .map(cleanImagePath)
    .filter((path): path is string => typeof path === "string" && IMAGE_EXTENSION_REGEX.test(path));
  if (paths.length > 0) return paths;

  const cleaned = cleanImagePath(text);
  return cleaned && IMAGE_EXTENSION_REGEX.test(basename(cleaned)) ? [cleaned] : [];
}

function cleanImagePath(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return undefined;
    }
  }
  const unquoted = ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
  if (process.platform === "win32") return unquoted;
  const placeholder = "\0CHILI_DOUBLE_BACKSLASH\0";
  return unquoted
    .replace(/\\\\/g, placeholder)
    .replace(/\\(.)/g, "$1")
    .replace(new RegExp(placeholder, "g"), "\\");
}

function parseAppleScriptData(text: string): Buffer | undefined {
  const match = /data\s+[A-Za-z0-9]{4}([0-9A-Fa-f\s]+)[»>]?/.exec(text);
  const hex = match?.[1]?.replace(/\s+/g, "");
  if (!hex || hex.length % 2 !== 0) return undefined;
  return Buffer.from(hex, "hex");
}

function imageResult(bytes: Uint8Array, mimeType: string, extension: string): ClipboardImage {
  return { bytes, mimeType, extension };
}

function imageMatchesMime(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") return isPng(bytes);
  if (mimeType === "image/jpeg") return isJpeg(bytes);
  return bytes.byteLength > 0;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
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

async function readBinaryCommand(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };

    timeout = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, CLIPBOARD_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > CLIPBOARD_MAX_BUFFER) {
        child.kill();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        finish(undefined);
        return;
      }
      finish(Buffer.concat(chunks));
    });
  });
}
