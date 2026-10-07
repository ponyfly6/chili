import {
  createChiliHost,
  type ChiliHost,
  type ChiliHostOptions,
} from "@chili/host";
import { CliPrinter } from "./printing-store.js";

export {
  buildHostPromptFragments as buildCliPromptFragments,
  buildHostChildPromptFragments as buildCliChildPromptFragments,
  type HostPermissionProfileControl as CliPermissionProfileControl,
} from "@chili/host";

export type CliHarness = ChiliHost;

export interface CliHarnessOptions extends Omit<ChiliHostOptions, "permissionProfile" | "onEvent"> {
  yes?: boolean;
  quiet?: boolean;
}

/** The CLI owns terminal interaction; all execution state and policy live in Host. */
export function createCliHarness(options: CliHarnessOptions): Promise<CliHarness> {
  const { yes, quiet, ...shared } = options;
  const printer = quiet ? undefined : new CliPrinter();
  return createChiliHost({
    ...shared,
    ...(yes ? { permissionProfile: "full-access" as const } : {}),
    ...(printer ? { onEvent: (event) => printer.event(event) } : {}),
  });
}
