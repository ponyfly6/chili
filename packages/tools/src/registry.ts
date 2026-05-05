import type {
  ChiliToolDefinition,
  MutableToolRegistry,
  ToolRegistryEntry,
  ToolRegistryListOptions,
  ToolRegistryRegisterOptions,
  ToolRegistrySelector,
} from "./types.js";

interface RegisteredTool {
  tool: ChiliToolDefinition;
  source?: string;
}

export class InMemoryToolRegistry implements MutableToolRegistry {
  private readonly canonical = new Map<string, RegisteredTool>();
  private readonly lookup = new Map<string, RegisteredTool>();

  register(tool: ChiliToolDefinition, options: ToolRegistryRegisterOptions = {}): void {
    const existing = this.lookup.get(tool.name);
    if (existing && (!options.replace || existing.tool.name !== tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    const removedNames = new Set<string>();
    if (existing) removedNames.add(existing.tool.name);
    this.assertCanReplace(removedNames, [tool]);
    if (existing) this.remove(existing.tool.name);

    const registered: RegisteredTool = { tool };
    if (options.source !== undefined) registered.source = options.source;
    this.canonical.set(tool.name, registered);
    this.lookup.set(tool.name, registered);
    for (const alias of tool.aliases ?? []) {
      this.lookup.set(alias, registered);
    }
  }

  get(name: string): ChiliToolDefinition | undefined {
    return this.lookup.get(name)?.tool;
  }

  list(_options: ToolRegistryListOptions = {}): ChiliToolDefinition[] {
    return this.sortedEntries().map((entry) => entry.tool);
  }

  entries(_options: ToolRegistryListOptions = {}): ToolRegistryEntry[] {
    return this.sortedEntries().map((entry) => {
      const value: ToolRegistryEntry = { tool: entry.tool };
      if (entry.source !== undefined) value.source = entry.source;
      return value;
    });
  }

  unregister(name: string): boolean {
    const existing = this.lookup.get(name);
    if (!existing) return false;
    this.remove(existing.tool.name);
    return true;
  }

  unregisterMatching(selector: ToolRegistrySelector): ChiliToolDefinition[] {
    const names = this.matchingNames(selector);
    const removed: ChiliToolDefinition[] = [];
    for (const name of names) {
      const existing = this.canonical.get(name);
      if (!existing) continue;
      removed.push(existing.tool);
      this.remove(name);
    }
    return removed.sort((left, right) => left.name.localeCompare(right.name));
  }

  unregisterSource(source: string): ChiliToolDefinition[] {
    return this.unregisterMatching({ source });
  }

  replaceMatching(
    selector: ToolRegistrySelector,
    tools: readonly ChiliToolDefinition[],
    options: ToolRegistryRegisterOptions = {},
  ): ChiliToolDefinition[] {
    const removedNames = new Set(this.matchingNames(selector));
    this.assertCanReplace(removedNames, tools);
    const removed: ChiliToolDefinition[] = [];
    for (const name of removedNames) {
      const existing = this.canonical.get(name);
      if (!existing) continue;
      removed.push(existing.tool);
      this.remove(name);
    }
    const source = options.source ?? selector.source;
    for (const tool of tools) {
      this.register(tool, registerOptions(source, options.replace));
    }
    return removed.sort((left, right) => left.name.localeCompare(right.name));
  }

  replaceSource(source: string, tools: readonly ChiliToolDefinition[]): ChiliToolDefinition[] {
    return this.replaceMatching({ source }, tools, { source });
  }

  private sortedEntries(): RegisteredTool[] {
    return [...this.canonical.values()].sort((left, right) => left.tool.name.localeCompare(right.tool.name));
  }

  private remove(name: string): void {
    const existing = this.canonical.get(name);
    if (!existing) return;
    this.canonical.delete(name);
    this.lookup.delete(existing.tool.name);
    for (const alias of existing.tool.aliases ?? []) {
      this.lookup.delete(alias);
    }
  }

  private matchingNames(selector: ToolRegistrySelector): string[] {
    if (!selector.source && !selector.namePrefix) {
      throw new Error("Tool registry selector requires source or namePrefix.");
    }
    return [...this.canonical.values()]
      .filter((entry) => matchesSelector(entry, selector))
      .map((entry) => entry.tool.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private assertCanReplace(removedNames: ReadonlySet<string>, tools: readonly ChiliToolDefinition[]): void {
    const futureLookup = new Map<string, string>();
    for (const entry of this.canonical.values()) {
      if (removedNames.has(entry.tool.name)) continue;
      futureLookup.set(entry.tool.name, entry.tool.name);
      for (const alias of entry.tool.aliases ?? []) {
        futureLookup.set(alias, entry.tool.name);
      }
    }

    for (const tool of tools) {
      const existing = futureLookup.get(tool.name);
      if (existing) throw new Error(`Tool already registered: ${tool.name}`);
      futureLookup.set(tool.name, tool.name);
      for (const alias of tool.aliases ?? []) {
        const aliasOwner = futureLookup.get(alias);
        if (aliasOwner || alias === tool.name) {
          throw new Error(`Tool alias already registered: ${alias}`);
        }
        futureLookup.set(alias, tool.name);
      }
    }
  }
}

function matchesSelector(entry: RegisteredTool, selector: ToolRegistrySelector): boolean {
  if (selector.source !== undefined && entry.source !== selector.source) return false;
  if (selector.namePrefix !== undefined && !entry.tool.name.startsWith(selector.namePrefix)) return false;
  return true;
}

function registerOptions(source: string | undefined, replace: boolean | undefined): ToolRegistryRegisterOptions {
  const options: ToolRegistryRegisterOptions = {};
  if (source !== undefined) options.source = source;
  if (replace !== undefined) options.replace = replace;
  return options;
}
