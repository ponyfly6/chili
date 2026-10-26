import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");
export const version: string = (await Bun.file(resolve(root, "apps/cli/package.json")).json()).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("CLI releases require a numeric major.minor.patch version");
export const tag = `v${version}`;
export const repository = "ponyfly6/chili";
export const targets = ["darwin-arm64", "linux-arm64", "linux-x64"] as const;
export type ReleaseTarget = typeof targets[number];
export const releaseDirectory = resolve(root, "dist/releases", tag);
export const assetName = (target: string) => `chili-${version}-${target}.tar.gz`;

export async function checked(command: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Command failed: ${command[0]} ${command[1] ?? ""}`);
}
