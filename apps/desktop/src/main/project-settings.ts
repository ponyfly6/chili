import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

export interface SavedDesktopProject { id: string; path: string }
export interface SavedDesktopProjects { projects: SavedDesktopProject[]; activeProjectId?: string }

export class DesktopProjectSettings {
  constructor(private readonly path: string) {}

  async read(): Promise<SavedDesktopProjects> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object") return { projects: [] };
      const saved = value as Record<string, unknown>;
      const projects: SavedDesktopProject[] = [];
      if (Array.isArray(saved.projects)) {
        for (const item of saved.projects.slice(0, 64)) {
          if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)
            || typeof item.path !== "string" || !isAbsolute(item.path) || item.path.length > 16_384) continue;
          if (!projects.some((project) => project.id === item.id || project.path === item.path)) projects.push({ id: item.id, path: item.path });
        }
      } else if (typeof saved.workspace === "string" && isAbsolute(saved.workspace)) {
        projects.push({ id: randomUUID(), path: saved.workspace });
      }
      const activeProjectId = projects.find((project) => project.id === saved.activeProjectId)?.id ?? projects[0]?.id;
      return { projects, ...(activeProjectId ? { activeProjectId } : {}) };
    } catch {
      return { projects: [] };
    }
  }

  async write(state: SavedDesktopProjects): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const workspace = state.projects.find((project) => project.id === state.activeProjectId)?.path;
      await writeFile(temporary, `${JSON.stringify({ ...state, workspace }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
