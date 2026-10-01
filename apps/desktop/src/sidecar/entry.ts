#!/usr/bin/env bun
import { GIT_SUPERVISOR_MODE } from "../shared/git-supervisor-protocol.js";

// Keep the helper path independent of provider imports, credentials, and HTTP.
if (process.argv[2] === GIT_SUPERVISOR_MODE) {
  const { runGitSupervisor } = await import("./git-supervisor.js");
  await runGitSupervisor(process.argv.slice(3));
} else {
  await import("./index.js");
}
