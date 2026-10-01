import type { RuntimeCommandCatalog, RuntimeCommandNode } from "@chili/protocol";
import { defineCommand } from "./registry.js";
import type { CommandDefinition, CommandRunInput } from "./types.js";

export type RuntimeCommandBinding<TContext, TResult> = (
  command: RuntimeCommandNode,
  context: TContext,
  input: CommandRunInput,
) => TResult | Promise<TResult>;

export function importRuntimeCommandCatalog<TContext, TResult>(
  catalog: RuntimeCommandCatalog,
  binding: RuntimeCommandBinding<TContext, TResult>,
): CommandDefinition<TContext, TResult>[] {
  return catalog.roots.map((command) => importNode(command, binding));
}

function importNode<TContext, TResult>(
  command: RuntimeCommandNode,
  binding: RuntimeCommandBinding<TContext, TResult>,
): CommandDefinition<TContext, TResult> {
  return defineCommand({
    id: command.id,
    name: command.name,
    title: command.title,
    description: command.description,
    group: command.group,
    source: command.source,
    argumentMode: command.argumentMode,
    argumentHint: command.argumentHint,
    selectionMode: command.selectionMode,
    concurrency: command.concurrency,
    hidden: command.hidden,
    executionTarget: command.executionTarget,
    children: command.children.map((child) => importNode(child, binding)),
    ...(!command.enabled ? {
      available: () => ({ enabled: false, reason: command.disabledReason ?? "Command is unavailable." }),
    } : {}),
    ...(command.selectionMode !== "drilldown" ? {
      run: (context, input) => binding(command, context, input),
    } : {}),
  });
}
