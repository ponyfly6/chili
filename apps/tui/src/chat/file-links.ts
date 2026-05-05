import path from "node:path";
import { pathToFileURL } from "node:url";
import { charDisplayWidth } from "./markdown.js";

export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

export interface FileLinkRange {
  startIndex: number;
  endIndex: number;
  startColumn: number;
  endColumn: number;
  target: FileLinkTarget;
}

const FILE_URL_PATTERN = /file:\/\/[^\s)\]}>,;]+/g;
const PATH_PATTERN = /(^|[\s([{<'"`])((?:~|\.{1,2}|\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_+-]+)(?:(?::(\d+))(?::(\d+))?|#L(\d+)(?:C(\d+))?)?(?=$|[\s)\]}>,;])/g;

export function fileLinksForText(text: string, cwd: string): FileLinkRange[] {
  return [
    ...fileUrlLinks(text),
    ...pathLinks(text, cwd),
  ].sort((left, right) => left.startColumn - right.startColumn);
}

export function hasFileLinkText(text: string): boolean {
  FILE_URL_PATTERN.lastIndex = 0;
  PATH_PATTERN.lastIndex = 0;
  return FILE_URL_PATTERN.test(text) || PATH_PATTERN.test(text);
}

export function zedPathWithPosition(target: FileLinkTarget): string {
  const line = target.line;
  const column = target.column;
  if (line !== undefined && column !== undefined) return `${target.path}:${line}:${column}`;
  if (line !== undefined) return `${target.path}:${line}`;
  return target.path;
}

export function fileUrlWithPosition(target: FileLinkTarget): string {
  const url = pathToFileURL(target.path);
  if (target.line !== undefined) {
    url.hash = `L${target.line}${target.column === undefined ? "" : `C${target.column}`}`;
  }
  return url.toString();
}

function fileUrlLinks(text: string): FileLinkRange[] {
  const links: FileLinkRange[] = [];
  FILE_URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_URL_PATTERN)) {
    const raw = match[0] ?? "";
    const target = fileUrlTarget(raw);
    if (!target) continue;
    const start = match.index ?? 0;
    links.push({
      startIndex: start,
      endIndex: start + raw.length,
      startColumn: displayColumn(text, start),
      endColumn: displayColumn(text, start + raw.length),
      target,
    });
  }
  return links;
}

function pathLinks(text: string, cwd: string): FileLinkRange[] {
  const links: FileLinkRange[] = [];
  PATH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PATH_PATTERN)) {
    const prefix = match[1] ?? "";
    const rawPath = match[2] ?? "";
    if (!rawPath || looksLikeUrl(text, match.index ?? 0, prefix.length)) continue;
    const line = numberFrom(match[3] ?? match[5]);
    const column = numberFrom(match[4] ?? match[6]);
    const start = (match.index ?? 0) + prefix.length;
    const end = start + rawPath.length + positionSuffixLength(match);
    links.push({
      startIndex: start,
      endIndex: end,
      startColumn: displayColumn(text, start),
      endColumn: displayColumn(text, end),
      target: {
        path: resolveDisplayPath(rawPath, cwd),
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
      },
    });
  }
  return links;
}

function fileUrlTarget(raw: string): FileLinkTarget | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:") return undefined;
    const filePath = decodeURIComponent(url.pathname);
    if (!filePath) return undefined;
    const hash = url.hash.match(/^#L(\d+)(?:C(\d+))?$/i);
    const line = numberFrom(hash?.[1]);
    const column = numberFrom(hash?.[2]);
    return {
      path: filePath,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    };
  } catch {
    return undefined;
  }
}

function resolveDisplayPath(value: string, cwd: string): string {
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(cwd, value);
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function positionSuffixLength(match: RegExpMatchArray): number {
  const line = match[3];
  const column = match[4];
  const hashLine = match[5];
  const hashColumn = match[6];
  if (line) return 1 + line.length + (column ? 1 + column.length : 0);
  if (hashLine) return 2 + hashLine.length + (hashColumn ? 1 + hashColumn.length : 0);
  return 0;
}

function looksLikeUrl(text: string, matchIndex: number, prefixLength: number): boolean {
  const start = matchIndex + prefixLength;
  return text.slice(Math.max(0, start - 3), start) === "://";
}

function displayColumn(text: string, index: number): number {
  let column = 0;
  for (const char of text.slice(0, index)) column += charDisplayWidth(char);
  return column;
}
