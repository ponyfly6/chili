import type { ToolExecutionGate, ToolReviewRequest } from "@chili/tools";
import { EXECUTION_REVIEW_MODULE_ID, assertSupportedPermissionProfile, ToolReviewError, type ReviewSettings } from "./approval.js";
import type { HostModuleRegistry } from "./hooks.js";

export { EXECUTION_REVIEW_MODULE_ID } from "./approval.js";

/** Host-enforced adapter; optional modules can neither replace nor bypass the required reviewer. */
export function createModuleExecutionGate(options: {
  modules: HostModuleRegistry;
  settings: () => ReviewSettings;
  assertRequestCurrent?: (request: ToolReviewRequest) => Promise<void>;
}): ToolExecutionGate {
  if (!options.modules.hasReview(EXECUTION_REVIEW_MODULE_ID)) {
    throw new Error(`Host requires the registered ${EXECUTION_REVIEW_MODULE_ID} review module.`);
  }
  return { async review(request, signal) {
    const settings = options.settings();
    assertSupportedPermissionProfile(settings.profile);
    const assertSettingsCurrent = (): void => {
      signal?.throwIfAborted();
      if (settings.revision !== options.settings().revision) {
        throw new ToolReviewError("Execution review settings changed; prepare and review this action again.");
      }
    };
    assertSettingsCurrent();
    const permit = settings.profile === "full-access"
      ? { decision: "allow" as const }
      : await options.modules.review(request, signal);
    return { ...permit, assertCurrent: async () => {
      assertSettingsCurrent();
      await options.assertRequestCurrent?.(request);
      if ("assertCurrent" in permit) await permit.assertCurrent?.();
      assertSettingsCurrent();
    } };
  } };
}
