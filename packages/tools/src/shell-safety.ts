/** Scheduling hints only; execution review is owned by the host gate. */
export function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|sudo|tee|python|python3|node|bun|npm|pnpm|yarn|make|sh|bash|zsh|fish|perl|ruby|npx|bunx)\b/.test(normalized)) {
    return false;
  }
  if (hasCommandSubstitution(normalized)) return false;
  // Shell expansions can turn otherwise harmless arguments into executable
  // syntax or write options. Redirections do not require whitespace.
  if (/[<>$]/.test(unquotedShellText(normalized, false))) return false;
  if (unquotedShellText(normalized).includes("$")) return false;

  const segments = shellSegments(normalized);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && (command[index + 1] === "\n" || command[index + 1] === "\r")) {
      index += command[index + 1] === "\r" && command[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      pushSegment(segments, current);
      current = "";
      if ((char === "|" || char === "&") && command[index + 1] === char) index++;
      continue;
    }
    if (char === "\n" || char === "\r") {
      pushSegment(segments, current);
      current = "";
      if (char === "\r" && command[index + 1] === "\n") index++;
      continue;
    }
    current += char;
  }

  pushSegment(segments, current);
  return segments;
}

function pushSegment(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed) segments.push(trimmed);
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && (segment[index + 1] === "\n" || segment[index + 1] === "\r")) {
      index += segment[index + 1] === "\r" && segment[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\\") {
      escaped = true;
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
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function isReadOnlySegment(command: string): boolean {
  const words = shellWords(command);
  // Environment assignments and `env` wrappers alter the invocation being
  // classified, even when the visible executable is normally read-only.
  if (stripEnvAssignments(words).length !== words.length) return false;
  const normalized = stripWrappers(words);
  if (normalized.sawSudo || normalized.sawEnvironment) return false;

  const executable = commandName(normalized.words[0] ?? "");
  const args = normalized.words.slice(1);
  if (SIMPLE_READ_ONLY_COMMANDS.has(executable)) return true;
  if (executable === "find") return isReadOnlyFind(args);
  if (executable === "sed") return isReadOnlySed(args);
  if (executable === "awk") return isReadOnlyAwk(args);
  if (executable === "git") return isReadOnlyGit(args);
  return false;
}

const SIMPLE_READ_ONLY_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg"]);

function isReadOnlyFind(args: string[]): boolean {
  return !args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir");
}

function isReadOnlySed(args: string[]): boolean {
  let sawScript = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") continue;
    if (isSedInPlaceOption(arg) || arg === "-f" || arg === "--file" || arg.startsWith("-f") || arg.startsWith("--file=")) {
      return false;
    }
    if (arg === "-e" || arg === "--expression") {
      const script = args[++index];
      if (script === undefined || hasUnsafeSedScript(script)) return false;
      sawScript = true;
      continue;
    }
    if (arg.startsWith("-e")) {
      if (hasUnsafeSedScript(arg.slice(2))) return false;
      sawScript = true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (hasUnsafeSedScript(arg.slice("--expression=".length))) return false;
      sawScript = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (!isSafeSedFlag(arg)) return false;
      continue;
    }
    if (!sawScript) {
      if (hasUnsafeSedScript(arg)) return false;
      sawScript = true;
    }
  }
  return true;
}

function isSedInPlaceOption(arg: string): boolean {
  if (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place=")) return true;
  return /^-[^-].*i/.test(arg);
}

function isSafeSedFlag(arg: string): boolean {
  return (
    arg === "-n" ||
    arg === "-E" ||
    arg === "-r" ||
    arg === "-u" ||
    arg === "-s" ||
    arg === "-z" ||
    arg === "--quiet" ||
    arg === "--silent" ||
    arg === "--regexp-extended" ||
    arg === "--unbuffered" ||
    arg === "--separate" ||
    arg === "--null-data" ||
    arg === "--posix" ||
    /^-[nErsuz]+$/.test(arg) ||
    /^-l\d+$/.test(arg) ||
    arg.startsWith("--line-length=")
  );
}

function hasUnsafeSedScript(script: string): boolean {
  const normalized = script.replace(/\\./g, "");
  if (/(^|[;\n{}])\s*[ew](\s|$)/.test(normalized)) return true;
  return /s([^A-Za-z0-9\\\s]).*\1.*\1[0-9gpIM]*[ew](\s|$)/.test(normalized);
}

function isReadOnlyAwk(args: string[]): boolean {
  let sawProgram = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") continue;
    if (arg === "-i" || arg === "--include" || arg.startsWith("-i") || arg.startsWith("--include=")) return false;
    if (arg === "-f" || arg === "--file" || arg.startsWith("-f") || arg.startsWith("--file=")) return false;
    if (arg === "-v" || arg === "-F" || arg === "--assign" || arg === "--field-separator") {
      if (args[++index] === undefined) return false;
      continue;
    }
    if (arg.startsWith("-v") || arg.startsWith("-F") || arg.startsWith("--assign=") || arg.startsWith("--field-separator=")) {
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!sawProgram) {
      if (hasUnsafeAwkProgram(arg)) return false;
      sawProgram = true;
    }
  }
  return true;
}

function hasUnsafeAwkProgram(program: string): boolean {
  return />|\bsystem\s*\(|\|/.test(program);
}

function isReadOnlyGit(args: string[]): boolean {
  let index = 0;
  while (args[index] === "--no-optional-locks" || args[index] === "--no-pager" || args[index] === "-P") index++;
  const subcommand = args[index] ?? "";
  const commandArgs = args.slice(index + 1);
  // Do not infer read safety across configuration, repository overrides, or
  // aliases. The two supported global flags only suppress locks and pagers.
  if (subcommand.startsWith("-")) return false;
  const separator = commandArgs.indexOf("--");
  const options = separator < 0 ? commandArgs : commandArgs.slice(0, separator);
  if (options.some((arg) =>
    arg === "--output" || arg.startsWith("--output=")
    || arg === "--ext-diff" || arg === "--textconv"
    || arg === "--open-files-in-pager" || arg.startsWith("--open-files-in-pager=")
    || /^-O/.test(arg)
  )) return false;
  if (subcommand === "status" || subcommand === "diff" || subcommand === "log" || subcommand === "show") return true;
  if (subcommand === "rev-parse" || subcommand === "ls-files" || subcommand === "grep") return true;
  if (subcommand === "branch") return isReadOnlyGitBranch(commandArgs);
  return false;
}

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;

  let allowPatterns = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--list") {
      allowPatterns = true;
      continue;
    }
    if (isGitBranchReadOnlyFlag(arg)) continue;
    if (isGitBranchReadOnlyValueFlag(arg)) {
      if (args[index + 1] && !args[index + 1]?.startsWith("-")) index++;
      continue;
    }
    if (isGitBranchReadOnlyValueFlagWithEquals(arg)) continue;
    if (arg.startsWith("-")) return false;
    if (!allowPatterns) return false;
  }
  return true;
}

function isGitBranchReadOnlyFlag(arg: string): boolean {
  return (
    arg === "--show-current" ||
    arg === "--all" ||
    arg === "--remotes" ||
    arg === "--verbose" ||
    arg === "--no-color" ||
    arg === "--ignore-case" ||
    arg === "--no-column" ||
    arg === "--no-abbrev" ||
    arg === "-a" ||
    arg === "-r" ||
    arg === "-v" ||
    arg === "-vv"
  );
}

function isGitBranchReadOnlyValueFlag(arg: string): boolean {
  return (
    arg === "--contains" ||
    arg === "--no-contains" ||
    arg === "--merged" ||
    arg === "--no-merged" ||
    arg === "--points-at" ||
    arg === "--sort" ||
    arg === "--format" ||
    arg === "--color" ||
    arg === "--column" ||
    arg === "--abbrev"
  );
}

function isGitBranchReadOnlyValueFlagWithEquals(arg: string): boolean {
  return (
    arg.startsWith("--contains=") ||
    arg.startsWith("--no-contains=") ||
    arg.startsWith("--merged=") ||
    arg.startsWith("--no-merged=") ||
    arg.startsWith("--points-at=") ||
    arg.startsWith("--sort=") ||
    arg.startsWith("--format=") ||
    arg.startsWith("--color=") ||
    arg.startsWith("--column=") ||
    arg.startsWith("--abbrev=")
  );
}

function stripEnvAssignments(words: string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
  return words.slice(index);
}

function stripWrappers(words: string[]): { words: string[]; sawSudo: boolean; sawEnvironment: boolean } {
  let index = 0;
  let sawSudo = false;
  let sawEnvironment = false;
  while (index < words.length) {
    const word = commandName(words[index] ?? "");
    if (word === "sudo") {
      sawSudo = true;
      index++;
      continue;
    }
    if (word === "command" || word === "builtin") {
      index++;
      continue;
    }
    if (word === "env") {
      sawEnvironment = true;
      index++;
      while (index < words.length) {
        const arg = words[index] ?? "";
        if (arg === "--") {
          index++;
          break;
        }
        if (ENV_OPTIONS_WITH_VALUE.has(arg)) {
          index += 2;
          continue;
        }
        if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return { words: words.slice(index), sawSudo, sawEnvironment };
}

function commandName(word: string): string {
  const normalized = word.trim();
  const slash = normalized.lastIndexOf("/");
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

function hasCommandSubstitution(command: string): boolean {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "\"") {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        quote = undefined;
        continue;
      }
      if (char === "`" || (char === "$" && command[index + 1] === "(")) return true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === "\"") {
      quote = "\"";
      continue;
    }
    if (
      char === "`"
      || (char === "$" && command[index + 1] === "(")
      || ((char === "<" || char === ">") && command[index + 1] === "(")
    ) return true;
  }
  return false;
}

function unquotedShellText(command: string, includeDoubleQuoted = true): string {
  let result = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      result += " ";
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      result += " ";
      continue;
    }
    if (char === "\\") {
      escaped = true;
      result += " ";
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") {
        quote = undefined;
        result += " ";
      } else {
        result += includeDoubleQuoted ? char : " ";
      }
      continue;
    }
    if (char === "'") {
      quote = "'";
      result += " ";
      continue;
    }
    if (char === "\"") {
      quote = "\"";
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}
