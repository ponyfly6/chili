import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChiliEvent } from "@chili/protocol";
import type { EventMirror } from "./types.js";

export class JsonlMirror implements EventMirror {
  constructor(private readonly path: string) {}

  async write(event: ChiliEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
