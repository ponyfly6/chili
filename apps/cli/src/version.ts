// Replaced by the release build; source checkouts identify themselves explicitly.
declare const CHILI_CLI_VERSION: string | undefined;
export const cliVersion = typeof CHILI_CLI_VERSION === "string" ? CHILI_CLI_VERSION : "0.1.0-dev";
