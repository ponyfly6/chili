import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { discoverSkills } from "@chili/skills";
import { createActivateSkillTool } from "./builtins/activate-skill.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ExecuteToolInput } from "./types.js";

test("activate_skill returns full body, metadata, baseDir, and skill_files", async () => {
  const fixture = await tempFixture();
  const skillDir = path.join(fixture.cwd, ".chili", "skills", "tool-skill");
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await mkdir(path.join(skillDir, "templates"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: tool-skill",
      "description: Tool skill description.",
      "allowedTools:",
      "  - read",
      "  - grep",
      "model: chili-pro",
      "context: inline",
      "---",
      "# Tool Skill",
      "Full instructions.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(skillDir, "scripts", "run.ts"), "export {};\n", "utf8");
  await writeFile(path.join(skillDir, "templates", "component.tsx"), "export const C = null;\n", "utf8");

  const skillRegistry = await discoverSkills({ cwd: fixture.cwd, homeDir: fixture.home });
  const registry = new InMemoryToolRegistry();
  registry.register(createActivateSkillTool(skillRegistry));
  const executor = createExecutor(registry);

  const result = await executor.execute(toolInput("activate_skill", { name: "tool-skill" }, fixture.cwd));

  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.result.output).toContain('<activated_skill name="tool-skill">');
  expect(result.result.output).toContain("source: project");
  expect(result.result.output).toContain(`baseDir: ${skillDir}`);
  expect(result.result.output).toContain("allowedTools: read, grep");
  expect(result.result.output).toContain("model: chili-pro");
  expect(result.result.output).toContain("context: inline");
  expect(result.result.output).toContain("# Tool Skill\nFull instructions.");
  expect(result.result.output).toContain("- scripts/run.ts");
  expect(result.result.output).toContain("- templates/component.tsx");
  expect(result.result.metadata).toMatchObject({
    name: "tool-skill",
    source: "project",
    baseDir: skillDir,
  });
});

test("activate_skill not found returns a clear error with available names", async () => {
  const fixture = await tempFixture();
  await writeSkill(fixture.cwd, "known-skill", "Known skill.");
  const skillRegistry = await discoverSkills({ cwd: fixture.cwd, homeDir: fixture.home });
  const registry = new InMemoryToolRegistry();
  registry.register(createActivateSkillTool(skillRegistry));
  const executor = createExecutor(registry);

  const result = await executor.execute(toolInput("activate_skill", { name: "missing-skill" }, fixture.cwd));

  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.result.output).toContain('Skill "missing-skill" not found.');
  expect(result.result.output).toContain("known-skill");
  expect(result.result.metadata).toMatchObject({
    error: "skill_not_found",
    availableSkills: ["known-skill"],
  });
});

async function tempFixture(): Promise<{ root: string; cwd: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "chili-activate-skill-"));
  return {
    root,
    cwd: path.join(root, "repo"),
    home: path.join(root, "home"),
  };
}

async function writeSkill(cwd: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(cwd, ".chili", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "body", ""].join("\n"),
    "utf8",
  );
}

function createExecutor(registry: InMemoryToolRegistry): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown, cwd: string): ExecuteToolInput {
  return {
    sessionId: "session_activate_skill" as SessionId,
    turnId: "turn_activate_skill" as TurnId,
    toolName,
    input,
    cwd,
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}
