import type { ChiliToolDefinition, ToolRegistry } from "./types.js";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly canonical = new Map<string, ChiliToolDefinition>();
  private readonly lookup = new Map<string, ChiliToolDefinition>();

  register(tool: ChiliToolDefinition): void {
    if (this.lookup.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    const aliases = tool.aliases ?? [];
    for (const alias of aliases) {
      if (this.lookup.has(alias) || alias === tool.name) {
        throw new Error(`Tool alias already registered: ${alias}`);
      }
    }

    this.canonical.set(tool.name, tool);
    this.lookup.set(tool.name, tool);
    for (const alias of aliases) {
      this.lookup.set(alias, tool);
    }
  }

  get(name: string): ChiliToolDefinition | undefined {
    return this.lookup.get(name);
  }

  list(): ChiliToolDefinition[] {
    return [...this.canonical.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
}
