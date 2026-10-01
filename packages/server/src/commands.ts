// Compatibility entry point. Command discovery and execution belong to @chili/commands.
export {
  cloneCatalog,
  createFilesystemPromptCommandControl,
  findRuntimeCommandNode,
  promptNamespaces,
  PromptCommandNotFoundError,
  PromptCommandUsageError,
  type FilesystemPromptCommandControlOptions,
  type PromptCommandCatalogInput,
  type PromptCommandControl,
  type PromptCommandRunResult,
} from "@chili/commands";
