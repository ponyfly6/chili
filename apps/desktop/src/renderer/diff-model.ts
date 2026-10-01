export interface DiffLine {
  kind: "context" | "addition" | "deletion" | "hunk" | "metadata";
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFile {
  id: string;
  path: string;
  previousPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "binary" | "metadata";
  added: number;
  removed: number;
  lines: DiffLine[];
  raw: string;
}

export interface DiffDocument {
  files: DiffFile[];
  preamble: string[];
  added: number;
  removed: number;
  truncated: boolean;
}

interface Hunk {
  oldNumber: number;
  newNumber: number;
  oldRemaining: number;
  newRemaining: number;
}

interface FileState {
  file: DiffFile;
  start: number;
  oldPath?: string | null;
  newPath?: string | null;
  modeKind?: "added" | "deleted";
  binary: boolean;
  hasHeaders: boolean;
  hasHunk: boolean;
  hunk?: Hunk;
}

/** Parse display data only. Source lines and raw patches remain untrusted text. */
export function parseDiff(text: string, truncated = false): DiffDocument {
  const document: DiffDocument = { files: [], preamble: [], added: 0, removed: 0, truncated };
  if (text.length === 0) return document;

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const occurrences = new Map<string, number>();
  let current: FileState | undefined;
  let offset = 0;

  const finishFile = (end: number): void => {
    if (!current) return;
    const { file, oldPath, newPath } = current;
    const rawPath = (newPath ?? oldPath) || "Unrecognized diff";
    const occurrence = occurrences.get(rawPath) ?? 0;
    occurrences.set(rawPath, occurrence + 1);
    file.id = JSON.stringify([rawPath, occurrence]);
    file.raw = text.slice(current.start, end);
    file.path = displayPath(rawPath);
    const renamed = typeof oldPath === "string" && typeof newPath === "string" && oldPath !== newPath;
    if (renamed) file.previousPath = displayPath(oldPath);
    file.kind = current.binary ? "binary"
      : oldPath === null || current.modeKind === "added" ? "added"
        : newPath === null || current.modeKind === "deleted" ? "deleted"
          : renamed ? "renamed"
            : current.hasHunk ? "modified" : "metadata";
    document.files.push(file);
    document.added += file.added;
    document.removed += file.removed;
  };

  const beginFile = (): FileState => {
    finishFile(offset);
    return {
      file: {
        id: "",
        path: "Unrecognized diff",
        kind: "metadata",
        added: 0,
        removed: 0,
        lines: [],
        raw: "",
      },
      start: offset,
      binary: false,
      hasHeaders: false,
      hasHunk: false,
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    // CRLF framing is ignored for syntax, but retained in both source representations.
    const line = source.endsWith("\r") ? source.slice(0, -1) : source;
    let parsed: DiffLine | undefined;

    if (current?.hunk) {
      parsed = readHunkLine(source, current.hunk);
      if (parsed?.kind === "addition") current.file.added += 1;
      if (parsed?.kind === "deletion") current.file.removed += 1;
      if (!parsed) delete current.hunk;
    }

    if (!parsed) {
      if (/^# diff output truncated\b/u.test(line)) document.truncated = true;

      if (line.startsWith("diff --git ")) {
        current = beginFile();
        const paths = readGitHeader(line.slice("diff --git ".length));
        if (paths) {
          current.oldPath = stripPrefix(paths[0], "a/");
          current.newPath = stripPrefix(paths[1], "b/");
        }
      } else if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
        if (!current || current.hasHeaders || current.hasHunk) current = beginFile();
        const nextSource = lines[index + 1]!;
        const next = nextSource.endsWith("\r") ? nextSource.slice(0, -1) : nextSource;
        const oldPath = readWholePath(line.slice(4), true);
        const newPath = readWholePath(next.slice(4), true);
        // A malformed filename cannot establish a text patch or trustworthy line numbers.
        current.hasHeaders = oldPath !== undefined && newPath !== undefined;
        if (oldPath !== undefined) current.oldPath = stripPrefix(oldPath, "a/");
        if (newPath !== undefined) current.newPath = stripPrefix(newPath, "b/");
      } else if (current) {
        if (line.startsWith("new file mode ")) current.modeKind = "added";
        if (line.startsWith("deleted file mode ")) current.modeKind = "deleted";
        if (line === "GIT binary patch" || /^Binary files .+ differ$/u.test(line)) current.binary = true;
        if (line.startsWith("rename from ")) {
          const path = readWholePath(line.slice("rename from ".length));
          if (path !== undefined) current.oldPath = path;
        }
        if (line.startsWith("rename to ")) {
          const path = readWholePath(line.slice("rename to ".length));
          if (path !== undefined) current.newPath = path;
        }
        if (current.hasHeaders && !current.binary && line.startsWith("@@ ")) {
          const hunk = readHunk(line);
          if (hunk) {
            current.hunk = hunk;
            current.hasHunk = true;
            parsed = { kind: "hunk", text: source };
          }
        }
      }
    }

    if (current) current.file.lines.push(parsed ?? { kind: "metadata", text: source });
    else document.preamble.push(source);
    offset += source.length + 1;
  }

  finishFile(text.length);
  return document;
}

function readHunk(line: string): Hunk | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
  if (!match) return undefined;
  const oldNumber = Number(match[1]);
  const oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
  const newNumber = Number(match[3]);
  const newRemaining = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldNumber, oldRemaining, newNumber, newRemaining, oldNumber + oldRemaining, newNumber + newRemaining]
    .every(Number.isSafeInteger)) return undefined;
  if ((oldNumber === 0 && oldRemaining !== 0) || (newNumber === 0 && newRemaining !== 0)) return undefined;
  return { oldNumber, newNumber, oldRemaining, newRemaining };
}

function readHunkLine(text: string, hunk: Hunk): DiffLine | undefined {
  if (text === "\\ No newline at end of file" || text === "\\ No newline at end of file\r") {
    return { kind: "metadata", text };
  }
  if (text.startsWith("+") && hunk.newRemaining > 0) {
    hunk.newRemaining -= 1;
    return { kind: "addition", text, newNumber: hunk.newNumber++ };
  }
  if (text.startsWith("-") && hunk.oldRemaining > 0) {
    hunk.oldRemaining -= 1;
    return { kind: "deletion", text, oldNumber: hunk.oldNumber++ };
  }
  if (text.startsWith(" ") && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
    return { kind: "context", text, oldNumber: hunk.oldNumber++, newNumber: hunk.newNumber++ };
  }
  return undefined;
}

function readGitHeader(value: string): [string, string] | undefined {
  if (value.startsWith("\"")) {
    const first = readQuotedPath(value);
    if (!first || first.path.length === 0 || value[first.end] !== " ") return undefined;
    const second = readWholePath(value.slice(first.end + 1));
    return second === undefined ? undefined : [first.path, second];
  }
  const quotedSecond = value.indexOf(" \"");
  if (quotedSecond >= 0) {
    const second = readWholePath(value.slice(quotedSecond + 1));
    return second === undefined ? undefined : [value.slice(0, quotedSecond), second];
  }
  // Git leaves spaces unquoted. Equal paths disambiguate embedded " b/" in O(n).
  const middle = (value.length - 1) / 2;
  if (Number.isInteger(middle) && value.startsWith("a/") && value.slice(middle, middle + 3) === " b/") {
    const first = value.slice(0, middle);
    const second = value.slice(middle + 1);
    if (first.slice(2) === second.slice(2)) return [first, second];
  }
  const separator = value.lastIndexOf(" b/");
  if (!value.startsWith("a/") || separator < 3 || separator + 3 >= value.length) return undefined;
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function readWholePath(value: string, allowTimestamp = false): string | undefined {
  if (value.startsWith("\"")) {
    const quoted = readQuotedPath(value);
    if (!quoted) return undefined;
    const suffix = value.slice(quoted.end);
    if (suffix.length > 0 && !(allowTimestamp && suffix.startsWith("\t"))) return undefined;
    return quoted.path.length > 0 ? quoted.path : undefined;
  }
  const tab = allowTimestamp ? value.indexOf("\t") : -1;
  const path = tab >= 0 ? value.slice(0, tab) : value;
  return path.length > 0 ? path : undefined;
}

function readQuotedPath(value: string): { path: string; end: number } | undefined {
  const parts: string[] = [];
  const escapes: Record<string, string> = {
    a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\u000b", f: "\f", r: "\r", "\\": "\\", "\"": "\"", "/": "/",
  };
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\"") return { path: parts.join(""), end: index + 1 };
    if (character !== "\\") {
      parts.push(character);
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) return undefined;
    if (/[0-7]/u.test(escaped)) {
      const bytes: number[] = [];
      while (value[index] === "\\" && /[0-7]/u.test(value[index + 1] ?? "")) {
        const digits = /^[0-7]{1,3}/u.exec(value.slice(index + 1, index + 4))![0];
        const byte = Number.parseInt(digits, 8);
        if (byte > 255) return undefined;
        bytes.push(byte);
        index += digits.length + 1;
      }
      try {
        parts.push(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes)));
      } catch {
        return undefined;
      }
      index -= 1;
    } else if (escaped === "u") {
      const digits = value.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/u.test(digits)) return undefined;
      parts.push(String.fromCharCode(Number.parseInt(digits, 16)));
      index += 5;
    } else {
      const replacement = escapes[escaped];
      if (replacement === undefined) return undefined;
      parts.push(replacement);
      index += 1;
    }
  }
  return undefined;
}

function stripPrefix(path: string, prefix: string): string | null {
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function displayPath(path: string): string {
  const escapes: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  return path.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (character) => {
    if (escapes[character]) return escapes[character];
    const code = character.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
