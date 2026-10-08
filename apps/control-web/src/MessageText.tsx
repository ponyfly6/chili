import type { ReactNode } from "react";

function safeLink(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return null;
  try {
    // URL parsers can discard controls or normalize credentials, so check the input too.
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(decodeURIComponent(value))) return null;
    const url = new URL(value);
    const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0]!;
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || authority.includes("@")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function inlineText(text: string, links = true, bold = true): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Delimiters cannot appear inside their own token, keeping incomplete input cheap to scan.
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(!?)\[([^\[\]\n]+)\]\(([^()\n]*)\)/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index;
    if (index > offset) nodes.push(text.slice(offset, index));
    const token = match[0];
    let backslashes = 0;
    while (index > backslashes && text[index - backslashes - 1] === "\\") backslashes += 1;
    if (backslashes % 2 === 1) {
      nodes.push(token);
    } else if (match[1] !== undefined) {
      nodes.push(<code key={index}>{match[1]}</code>);
    } else if (match[2] !== undefined && bold) {
      nodes.push(<strong key={index}>{inlineText(match[2], links, false)}</strong>);
    } else if (match[4] !== undefined && links && match[3] !== "!") {
      const href = safeLink(match[5]!);
      nodes.push(href ? <a key={index} href={href} target="_blank" rel="noreferrer noopener">{inlineText(match[4], false, bold)}</a> : token);
    } else {
      nodes.push(token);
    }
    offset = index + token.length;
  }
  if (offset < text.length) nodes.push(text.slice(offset));
  return nodes;
}

function textLines(text: string, formatted = true): ReactNode[] {
  return text.split("\n").flatMap((line, index) => [
    ...(index ? [<br key={`break-${index}`} />] : []),
    <span key={`line-${index}`}>{formatted ? inlineText(line) : line}</span>,
  ]);
}

function listItem(line: string): { ordered: boolean; start: number; text: string } | null {
  const match = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line);
  if (!match) return null;
  const ordered = /^\d/.test(match[1]!);
  return { ordered, start: ordered ? Number.parseInt(match[1]!, 10) : 1, text: match[2]! };
}

function fence(line: string): { marker: string; language: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return null;
  return { marker: match[1]!, language: match[2]!.trim() };
}

/** A deliberately small Markdown subset. All source content stays in React text nodes. */
export function MessageText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const opening = fence(line);
    if (opening) {
      let end = index + 1;
      while (end < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[end]!);
        if (closing && closing[1]![0] === opening.marker[0] && closing[1]!.length >= opening.marker.length) break;
        end += 1;
      }
      if (end === lines.length) {
        blocks.push(<p key={index}>{textLines(lines.slice(index).join("\n"), false)}</p>);
        break;
      }
      blocks.push(<div key={index} className="message-code-block">
        {opening.language && <div className="message-code-language">{opening.language}</div>}
        <pre className="message-code"><code>{lines.slice(index + 1, end).join("\n")}</code></pre>
      </div>);
      index = end + 1;
      continue;
    }

    const heading = /^(#{1,3})[ \t]+(.+)$/.exec(line);
    if (heading) {
      const Heading = `h${heading[1]!.length}` as "h1" | "h2" | "h3";
      blocks.push(<Heading key={index}>{inlineText(heading[2]!)}</Heading>);
      index += 1;
      continue;
    }

    const firstItem = listItem(line);
    if (firstItem) {
      const start = index;
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index]!);
        if (!item || item.ordered !== firstItem.ordered) break;
        items.push(<li key={index}>{inlineText(item.text)}</li>);
        index += 1;
      }
      blocks.push(firstItem.ordered
        ? <ol key={start} start={firstItem.start === 1 ? undefined : firstItem.start}>{items}</ol>
        : <ul key={start}>{items}</ul>);
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !fence(lines[index]!) && !/^(#{1,3})[ \t]+(.+)$/.test(lines[index]!) && !listItem(lines[index]!)) index += 1;
    blocks.push(<p key={start}>{textLines(lines.slice(start, index).join("\n"))}</p>);
  }
  return <div className="message-content">{blocks}</div>;
}
