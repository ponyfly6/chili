import {
  createChiliHost,
  type ChiliHost,
  type ChiliHostOptions,
} from "@chili/host";
import { createCliApprovalAsk } from "./approval.js";
import { CliPrinter } from "./printing-store.js";

export {
  buildHostPromptFragments as buildCliPromptFragments,
  buildHostChildPromptFragments as buildCliChildPromptFragments,
  createCompleteTaskController,
  createSubagentControlController,
  createTeamToolController,
  type HostPermissionProfileControl as CliPermissionProfileControl,
} from "@chili/host";

export type CliHarness = ChiliHost;

export interface CliHarnessOptions extends Omit<ChiliHostOptions, "permissionProfile" | "askApproval" | "onEvent"> {
  yes?: boolean;
  quiet?: boolean;
}

/** The CLI owns terminal interaction; all execution state and policy live in Host. */
export function createCliHarness(options: CliHarnessOptions): Promise<CliHarness> {
  const { yes, quiet, ...shared } = options;
  const printer = quiet ? undefined : new CliPrinter();
  return createChiliHost({
    ...shared,
    permissionProfile: yes ? "full-access" : "default",
    askApproval: createCliApprovalAsk(),
    ...(printer ? { onEvent: (event) => printer.event(event) } : {}),
  });
}
