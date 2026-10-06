import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalResourcePattern } from "./resource-policy.js";
import type { ChiliToolExecutionContext } from "./types.js";

/** Discovery may see names internally; only authorized canonical names may escape. */
export async function readableFileResources(context: ChiliToolExecutionContext, paths: readonly string[]): Promise<string[]> {
  context.signal.throwIfAborted();
  await context.assertCurrentAuthorization?.();
  const workspace = await realpath(context.cwd);
  // One policy snapshot per batch, rather than loading Host/store state for
  // each candidate. The authoritative bulk check below catches later revocation.
  const denials = await context.currentResourceDenials?.();
  const permitted: string[] = [];
  for (const path of paths) {
    context.signal.throwIfAborted();
    const relativePath = await canonicalResourcePattern(context.cwd, path, true);
    const physicalPath = resolve(workspace, relativePath);
    if (denials?.readPaths.some((denied) => physicalPath === denied || physicalPath.startsWith(denied.endsWith(sep) ? denied : `${denied}${sep}`))) continue;
    permitted.push(resolve(context.cwd, relativePath));
  }
  await assertAllowedResources(context, permitted);
  return permitted;
}

/** No content is streamed before this final policy check. */
export async function assertReadableFileResources(context: ChiliToolExecutionContext, paths: readonly string[]): Promise<void> {
  context.signal.throwIfAborted();
  await context.assertCurrentAuthorization?.();
  for (const path of paths) {
    context.signal.throwIfAborted();
    if (resolve(context.cwd, await canonicalResourcePattern(context.cwd, path, true)) !== path) {
      throw new Error("File access changed during this operation; no results were returned.");
    }
  }
  await assertAllowedResources(context, paths);
}

async function assertAllowedResources(context: ChiliToolExecutionContext, paths: readonly string[]): Promise<void> {
  try { await context.assertFileResourceAccess?.(paths, "read"); }
  catch (error) {
    context.signal.throwIfAborted();
    // A policy may change after discovery. Do not disclose the newly denied
    // candidate's name through the operation's error result.
    throw new Error("File resource authorization changed or could not be verified; no results were returned.", { cause: error });
  }
}

/** Git may read historical/renamed objects or run hooks beyond input pathspecs. */
export async function assertGitResourceAccess(context: ChiliToolExecutionContext, _mutates: boolean): Promise<void> {
  context.signal.throwIfAborted();
  await context.assertCurrentAuthorization?.();
  const denials = await context.currentResourceDenials?.();
  if (denials?.readPaths.length || denials?.writePaths.length) {
    throw new Error("Git cannot prove that this operation avoids denied file resources; the operation was refused.");
  }
  if (context.executionPolicy?.writeScope !== undefined || context.executionPolicy?.executeScope !== undefined) {
    throw new Error("Git filters and hooks cannot enforce the current file/process scope; the operation was refused.");
  }
}
