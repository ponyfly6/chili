// A non-interactive tool call must not execute the user's login/interactive
// profiles before the command that was classified and approved. Explicit env
// overrides (including BASH_ENV) remain execution requests, never read-only.
export function bashArguments(command: string): string[] {
  return ["--noprofile", "--norc", "-c", command];
}
