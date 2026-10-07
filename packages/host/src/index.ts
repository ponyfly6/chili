export {
  createChiliHost,
  buildHostPromptFragments,
  buildHostChildPromptFragments,
  type ChiliHost,
  type ChiliHostOptions,
  type HostPermissionProfileControl,
} from "./host.js";
export {
  createHostExecutionGate,
  createExecutionReviewModule,
  DEFAULT_REVIEW_INSTRUCTIONS,
  REVIEWER_SYSTEM_INSTRUCTIONS,
  ToolReviewError,
  runtimePermissionConfig,
  type HostExecutionGateOptions,
  type ReviewSettings,
} from "./approval.js";
export {
  HostHookError,
  type HostModule,
  type HostHookPoint,
  type HostHookDiagnostic,
  type HostPromptContext,
} from "./hooks.js";
export {
  createHostModel,
  resolveHostRuntimeModelSelection,
  type HostModelName,
  type HostProviderName,
  type HostReasoningLevel,
  type HostModelSelection,
} from "./model.js";
export {
  createHostMcpRuntime,
  HostMcpRuntimeClosedError,
  type HostMcpRuntime,
  type HostMcpRuntimeOptions,
} from "./mcp-control.js";
export {
  loadHostConfig,
  DEFAULT_HOST_AGENT_CONFIG,
  type HostConfig,
  type HostAgentConfig,
  type LoadHostConfigOptions,
} from "./config.js";
export {
  readUserReviewSettings,
  writeUserReviewSettings,
  userReviewSettingsPath,
  type UserReviewSettings,
  type UserReviewSettingsOptions,
} from "./user-review-state.js";
export {
  createHostBashRunner,
  type HostBashRunnerOptions,
} from "./bash-runner.js";
export {
  createIdFactory,
} from "./id.js";
export { resolveHostExecutionIdentity } from "./identity.js";
export {
  readUserModelSelection,
  writeUserModelSelection,
  userModelStatePath,
  type UserModelStateOptions,
} from "./user-model-state.js";
