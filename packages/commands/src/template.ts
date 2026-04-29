import type { CommandRunInput } from "./types.js";

export interface TemplateExpansionInput {
  raw: string;
  argv?: readonly string[];
}

export function splitCommandArguments(input: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        output.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) output.push(current);
  return output;
}

export function createCommandRunInput(input: string, raw: string, invocation: string): CommandRunInput {
  return {
    raw,
    argv: splitCommandArguments(raw),
    invocation,
    input,
  };
}

export function expandPromptTemplate(template: string, args: string | TemplateExpansionInput): string {
  const input = typeof args === "string" ? { raw: args } : args;
  const argv = input.argv ?? splitCommandArguments(input.raw);

  return template.replace(/\$(ARGUMENTS|\d+)/g, (_match, key: string) => {
    if (key === "ARGUMENTS") return input.raw;
    const index = Number.parseInt(key, 10) - 1;
    return argv[index] ?? "";
  });
}

