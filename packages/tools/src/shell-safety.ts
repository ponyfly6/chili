import { posix } from "node:path";

export interface DangerousShellCommandFinding {
  action: "ask" | "deny";
  reason: string;
}

export function commandPrefix(command: string): string {
  const tokens = shellWords(command.trim()).filter(Boolean);
  return tokens.slice(0, Math.min(tokens.length, 2)).join(" ");
}

export function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|sudo|tee|python|python3|node|bun|npm|pnpm|yarn|make|sh|bash|zsh|fish|perl|ruby|npx|bunx)\b/.test(normalized)) {
    return false;
  }
  if (/(^|\s)(>|>>|2>|&>)/.test(normalized)) return false;

  const segments = shellSegments(normalized);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

export function classifyDangerousShellCommand(command: string): DangerousShellCommandFinding | undefined {
  return classifyDangerousShellCommandAtDepth(command, 0);
}

export function escalatedShellCommandRejection(command: string): string | undefined {
  if (/[\r\n]/.test(command)) {
    return "elevated shell commands must be a single visible line";
  }
  if (hasCommandSubstitution(command)) {
    return "elevated shell commands cannot use command substitution or backticks";
  }
  const activeText = unquotedShellText(command);
  if (activeText.includes("$")) {
    return "elevated shell commands cannot use shell variable expansion";
  }
  if (/[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(activeText)) {
    return "elevated shell commands cannot define shell functions";
  }
  if (/[*?\[\]{}]/.test(activeText) || /(^|[\s=;|&<>])~(?:[+\-]|[A-Za-z0-9_])?/.test(activeText)) {
    return "elevated shell commands cannot use shell path expansion";
  }
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    if (changesWorkingDirectory(words)) {
      return "elevated shell commands cannot change the reviewed working directory";
    }
    if (stripEnvAssignments(words).length !== words.length) {
      return "elevated shell commands cannot use shell environment assignments";
    }
    const normalized = stripWrappers(words).words;
    const executable = commandName(normalized[0] ?? "");
    if (executable === "eval" || executable === "source" || executable === ".") {
      return "elevated shell commands cannot evaluate or source hidden shell code";
    }
    if (SHELL_INTERPRETERS.has(executable)) {
      return "elevated shell commands cannot invoke another shell interpreter";
    }
  }
  return undefined;
}

function classifyDangerousShellCommandAtDepth(command: string, depth: number): DangerousShellCommandFinding | undefined {
  const compact = command.replace(/\s+/g, "");
  if (compact.includes(":(){:|:&};:")) {
    return { action: "deny", reason: "Refusing to run a shell fork bomb pattern." };
  }

  let workingDirectoryChanged = false;
  for (const segment of shellSegments(command)) {
    const rawWords = shellWords(segment);
    const segmentChangesWorkingDirectory = changesWorkingDirectory(rawWords);
    const words = stripEnvAssignments(rawWords);
    if ((workingDirectoryChanged || segmentChangesWorkingDirectory) && isRecursiveMutation(words)) {
      return {
        action: "ask",
        reason: "Recursive mutation after changing the shell working directory requires explicit approval.",
      };
    }
    const analysis = analyzeShellWords(words, depth);
    if (analysis) return analysis;
    if (segmentChangesWorkingDirectory) workingDirectoryChanged = true;
  }

  return undefined;
}

function analyzeShellWords(words: string[], depth: number): DangerousShellCommandFinding | undefined {
  const normalized = stripWrappers(words);
  const command = commandName(normalized.words[0] ?? "");
  if (!command) return normalized.sawSudo ? { action: "ask", reason: "sudo commands require explicit approval." } : undefined;

  if (depth < 16 && command === "eval") {
    const nested = classifyDangerousShellCommandAtDepth(normalized.words.slice(1).join(" "), depth + 1);
    if (nested) return nested;
  }

  if (depth < 16 && SHELL_INTERPRETERS.has(command)) {
    const script = shellCommandString(normalized.words.slice(1));
    if (script !== undefined) {
      const nested = classifyDangerousShellCommandAtDepth(script, depth + 1);
      if (nested) return nested;
    }
  }

  if (command === "rm") {
    return analyzeRm(normalized.words.slice(1));
  }

  if (command === "dd" && normalized.words.some((word) => /^of=\/dev\/(?:disk|rdisk|sd|nvme)/.test(word))) {
    return { action: "deny", reason: "Refusing to write raw disk devices with dd." };
  }

  if (command === "mkfs" || command.startsWith("mkfs.") || command === "newfs") {
    return { action: "deny", reason: "Refusing to format filesystems." };
  }

  if (command === "diskutil" && normalized.words[1] === "eraseDisk") {
    return { action: "deny", reason: "Refusing to erase disks." };
  }

  if ((command === "chmod" || command === "chown") && hasRecursiveOption(normalized.words.slice(1))) {
    const targets = commandTargets(normalized.words.slice(1));
    if (targets.some(isCatastrophicTarget)) {
      return { action: "deny", reason: `Refusing recursive ${command} against a system or workspace root target.` };
    }
  }

  if (command === "find" && normalized.words.some((word) => word === "-delete" || word === "-exec" || word === "-execdir")) {
    return { action: "ask", reason: "find actions that delete files or execute commands require explicit approval." };
  }

  if (command === "shutdown" || command === "reboot" || command === "halt" || command === "poweroff") {
    return { action: "ask", reason: "Power-management commands require explicit approval." };
  }

  if (normalized.sawSudo) {
    return { action: "ask", reason: "sudo commands require explicit approval." };
  }

  return undefined;
}

function analyzeRm(args: string[]): DangerousShellCommandFinding | undefined {
  const recursive = hasRecursiveOption(args);
  const force = hasForceOption(args);
  const targets = commandTargets(args);

  if (recursive && targets.some(isCatastrophicTarget)) {
    return { action: "deny", reason: "Refusing recursive delete of a system, home, workspace, parent, or .git root target." };
  }

  if (recursive && targets.some(isRootExpansionTarget)) {
    return { action: "deny", reason: "Refusing recursive delete with a shell expansion at the filesystem root." };
  }

  if (recursive && force && targets.some(isWorkspaceWildcardTarget)) {
    return { action: "ask", reason: "Recursive forced delete with a workspace wildcard requires explicit approval." };
  }

  if (recursive && targets.some(hasShellPathExpansion)) {
    return { action: "ask", reason: "Recursive delete with shell path expansion requires explicit approval." };
  }

  return undefined;
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
  const normalized = stripWrappers(stripEnvAssignments(shellWords(command)));
  if (normalized.sawSudo) return false;

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
  const subcommand = args[0] ?? "";
  if (subcommand === "status" || subcommand === "diff" || subcommand === "log" || subcommand === "show") return true;
  if (subcommand === "rev-parse" || subcommand === "ls-files" || subcommand === "grep") return true;
  if (subcommand === "branch") return isReadOnlyGitBranch(args.slice(1));
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

function stripWrappers(words: string[]): { words: string[]; sawSudo: boolean } {
  let index = 0;
  let sawSudo = false;
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
  return { words: words.slice(index), sawSudo };
}

function commandName(word: string): string {
  const normalized = word.trim();
  const slash = normalized.lastIndexOf("/");
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

function hasRecursiveOption(args: string[]): boolean {
  return args.some((arg) => arg === "--recursive" || (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg) && !arg.startsWith("--")));
}

function hasForceOption(args: string[]): boolean {
  return args.some((arg) => arg === "--force" || (/^-[A-Za-z]*f[A-Za-z]*$/.test(arg) && !arg.startsWith("--")));
}

function commandTargets(args: string[]): string[] {
  const targets: string[] = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}

function isCatastrophicTarget(target: string): boolean {
  const normalized = normalizeTarget(target);
  if (
    normalized === "/" ||
    normalized === "/*" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "~" ||
    normalized === "~+" ||
    normalized === "~-" ||
    normalized === "~/*" ||
    normalized === "$HOME" ||
    normalized === "$HOME/*" ||
    normalized === "${HOME}" ||
    normalized === "${HOME}/*" ||
    normalized === "$PWD" ||
    normalized === "${PWD}" ||
    normalized === "$OLDPWD" ||
    normalized === "${OLDPWD}" ||
    normalized === ".git"
  ) {
    return true;
  }
  if (normalized.endsWith("/.git")) return true;
  const home = process.env.HOME;
  return Boolean(home && normalized === normalizeTarget(home));
}

function isWorkspaceWildcardTarget(target: string): boolean {
  const normalized = normalizeTarget(target);
  return normalized === "*" || normalized === "./*";
}

function isRootExpansionTarget(target: string): boolean {
  const normalized = target.trim().replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    const firstComponent = normalized.slice(1).split("/")[0] ?? "";
    if (hasShellPathExpansion(firstComponent)) return true;
  }
  const brace = /^\{([^}]*)\}(\/.*)$/.exec(normalized);
  return Boolean(brace && brace[1]?.split(",").some((alternative) => alternative.length === 0));
}

function hasShellPathExpansion(target: string): boolean {
  return /[$*?\[\]{}]/.test(target) || /^~(?:[+\-]|[A-Za-z0-9_])?/.test(target);
}

function changesWorkingDirectory(words: readonly string[]): boolean {
  if (hasEnvChdir(words)) return true;
  const normalized = stripWrappers(stripEnvAssignments([...words]));
  const executable = commandName(normalized.words[0] ?? "");
  return executable === "cd" || executable === "pushd" || executable === "popd";
}

function hasEnvChdir(words: readonly string[]): boolean {
  const envIndex = words.findIndex((word) => commandName(word) === "env");
  if (envIndex < 0) return false;
  return words.slice(envIndex + 1).some((word) => (
    word === "-C" || word === "--chdir" || word.startsWith("--chdir=")
  ));
}

function isRecursiveMutation(words: string[]): boolean {
  const normalized = stripWrappers(words);
  const executable = commandName(normalized.words[0] ?? "");
  if (executable !== "rm" && executable !== "chmod" && executable !== "chown") return false;
  return hasRecursiveOption(normalized.words.slice(1));
}

function normalizeTarget(target: string): string {
  let normalized = target.trim().replaceAll("\\", "/");
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  normalized = posix.normalize(normalized);
  if (normalized === "./") return ".";
  if (normalized === "../") return "..";
  if (normalized === "~/") return "~";
  return normalized;
}

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

function shellCommandString(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "-c" || (/^-[^-]+$/.test(arg) && arg.includes("c"))) {
      return args[index + 1];
    }
  }
  return undefined;
}

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

function unquotedShellText(command: string): string {
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
    if (char === "'") {
      quote = "'";
      result += " ";
      continue;
    }
    if (char === "\"") {
      quote = quote === "\"" ? undefined : "\"";
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}
