import { createHash } from "node:crypto";
import { recordOwnedFileVersion } from "./file-operation-lock.js";
import { readFile, writeFile } from "node:fs/promises";

/** Last comparison before mutation. The caller must also hold its cooperative lock. */
export async function assertFileTextUnchanged(path: string, expected: string): Promise<void> {
  const current = await readFile(path, "utf8");
  if (current !== expected) {
    throw new Error(`File changed before modification: ${path}. Read it again before modifying.`);
  }
}

export async function writeFileTextIfUnchanged(
  path: string, content: string, expected: string | undefined, authorize?: () => Promise<void>,
): Promise<void> {
  if (expected !== undefined) await assertFileTextUnchanged(path, expected);
  await authorize?.();
  // A file created after the absence check must never be silently overwritten.
  await writeFile(path, content, { encoding: "utf8", flag: expected === undefined ? "wx" : "w" });
  await recordOwnedFileVersion(path, createHash("sha256").update(content, "utf8").digest("hex"));
}
