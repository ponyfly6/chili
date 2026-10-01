import { strict as assert } from "node:assert";

const suites = [
  {
    name: "ad-hoc lifecycle and mailbox integration",
    args: ["bun", "test", "packages/core/src/multi-agent-lifecycle.integration.test.ts"],
  },
  {
    name: "agent projection and TUI integration",
    args: [
      "bun",
      "test",
      "packages/sdk/src/ad-hoc-agents.integration.test.ts",
      "apps/tui/src/chat/AgentsView.integration.test.tsx",
    ],
  },
  {
    name: "persistent team live child concurrency",
    args: [
      "bun",
      "test",
      "packages/core/src/team-execution-runner.test.ts",
      "--test-name-pattern",
      "limits five live child tasks",
    ],
  },
] as const;

for (const suite of suites) {
  console.log(`[multi-agent smoke] ${suite.name}`);
  const proc = Bun.spawn([...suite.args], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  assert.equal(exitCode, 0, `${suite.name} failed with exit code ${exitCode}`);
}

console.log(`[multi-agent smoke] passed ${suites.length}/${suites.length}`);
