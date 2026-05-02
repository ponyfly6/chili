import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { chiliBasePromptFragment, type PromptFragment } from "@chili/core";
import type { AgentPath, SessionId, TaskId, ThreadId } from "@chili/protocol";
import { SkillRegistry, type Skill } from "@chili/skills";
import type { AgentTaskRow } from "@chili/store";
import { buildCliChildPromptFragments, buildCliPromptFragments, createCliHarness, type CliHarness } from "./harness.js";
import { formatPromptDebugJson, formatPromptDebugText, type CliPromptDebugOutput } from "./prompt-debug.js";
import { runPrompt } from "./runner.js";

test("CLI prompt fragments include base, memory/project context, and skills catalog", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(join(home, ".chili"), { recursive: true });
    await mkdir(join(repo, ".chili"), { recursive: true });
    await writeFile(join(repo, ".chili", "memory.md"), "project uses bun\n", "utf8");
    await writeFile(join(repo, "AGENTS.md"), "prefer focused patches\n", "utf8");

    const skillRegistry = new SkillRegistry([skill("reviewer")]);
    const fragments = await buildCliPromptFragments({
      cwd: repo,
      homeDir: home,
      projectRoot: repo,
      skillRegistry,
    });

    const contextual = fragments.filter((fragment) => fragment.layer === "contextual_user");
    const developer = fragments.filter((fragment) => fragment.layer === "developer");

    expect(fragments[0]).toEqual(chiliBasePromptFragment());
    expect(contextual.some((fragment) => fragment.source === "memory" && fragment.content.includes("project uses bun"))).toBe(true);
    expect(contextual.some((fragment) => fragment.source === "project" && fragment.content.includes("prefer focused patches"))).toBe(true);
    expect(developer.some((fragment) => fragment.id === "chili.memory.mechanics" && fragment.source === "memory")).toBe(true);
    const skills = developer.find((fragment) => fragment.id === "chili.skills.catalog");
    expect(skills).toMatchObject({
      id: "chili.skills.catalog",
      source: "skills",
      layer: "developer",
    });
    expect(skills?.content).toContain("<available_skills>");
    expect(skills?.content).toContain("reviewer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness promptFragments provider includes chili.base", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({ cwd: repo, model: "fake", quiet: true, yes: true });

    const service = harness.service as unknown as {
      options: {
        promptFragments?: (input: { sessionId: SessionId; threadId: ThreadId; cwd: string }) => Promise<PromptFragment[]> | PromptFragment[];
      };
    };
    const fragments = await service.options.promptFragments?.({
      sessionId: "session_harness" as SessionId,
      threadId: "thread_harness" as ThreadId,
      cwd: repo,
    });
    expect(fragments?.some((fragment) => fragment.id === "chili.base")).toBe(true);
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt fragments inject explicitly mentioned skill bodies for one turn", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  try {
    await mkdir(repo, { recursive: true });
    const skillRegistry = new SkillRegistry([skill("reviewer")]);
    const fragments = await buildCliPromptFragments({
      cwd: repo,
      skillRegistry,
      turn: {
        text: "please use $reviewer here",
      },
    });

    const body = fragments.find((fragment) => fragment.id === "chili.skill.reviewer");
    expect(body).toMatchObject({
      layer: "contextual_user",
      source: "skills",
      lifecycle: "turn",
      metadata: {
        kind: "skill_body",
        name: "reviewer",
        path: "/repo/.chili/skills/reviewer/SKILL.md",
      },
    });
    expect(body?.content).toContain("<instructions>\nreview body\n</instructions>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt fragments warn instead of choosing ambiguous plain skill mentions", async () => {
  const userSkill = skill("same", "user");
  const projectSkill = skill("same", "project");
  const fragments = await buildCliPromptFragments({
    cwd: "/repo",
    skillRegistry: new SkillRegistry([projectSkill], [], [userSkill, projectSkill]),
    turn: {
      text: "try $same",
    },
  });

  expect(fragments.some((fragment) => fragment.id.startsWith("chili.skill.same"))).toBe(false);
  expect(fragments.find((fragment) => fragment.id === "chili.skill_mentions.warnings")?.content).toContain("ambiguous");
});

test("CLI prompt fragments use structured skill path bindings for duplicate names", async () => {
  const userSkill = skill("same", "user");
  const projectSkill = skill("same", "project");
  const fragments = await buildCliPromptFragments({
    cwd: "/repo",
    skillRegistry: new SkillRegistry([projectSkill], [], [userSkill, projectSkill]),
    turn: {
      text: "try $same",
      skillMentions: [{ name: "same", path: userSkill.filePath }],
    },
  });

  const body = fragments.find((fragment) => fragment.id.startsWith("chili.skill.same"));
  expect(body?.metadata).toMatchObject({ name: "same", path: userSkill.filePath });
  expect(body?.content).toContain("review body");
  expect(fragments.some((fragment) => fragment.id === "chili.skill_mentions.warnings")).toBe(false);
});

test("CLI runPrompt leaves system prompt selection to the harness service", async () => {
  const submitted: Record<string, unknown>[] = [];
  const harness = {
    service: {
      submitPrompt: async (input: Record<string, unknown>) => {
        submitted.push(input);
        return { status: "completed", turns: [] };
      },
    },
  } as unknown as CliHarness;
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await runPrompt({
      harness,
      sessionId: "session_prompt" as SessionId,
      threadId: "thread_prompt" as ThreadId,
      prompt: "hello",
      maxTurns: 3,
    });
  } finally {
    console.log = originalLog;
  }

  expect(submitted).toHaveLength(1);
  expect(submitted[0]).not.toHaveProperty("system");
});

test("CLI prompt-debug text output shows manifest without content by default", () => {
  const output = promptDebugOutput(false);
  const text = formatPromptDebugText(output);

  expect(text).toContain("totalChars=31");
  expect(text).toContain("sessionId=session_prompt_debug");
  expect(text).toContain("threadId=thread_prompt_debug");
  expect(text).toContain("cwd=/repo");
  expect(text).toContain("created=true");
  expect(text).toContain("id=debug.project");
  expect(text).toContain("layer=contextual_user");
  expect(text).toContain("source=project");
  expect(text).toContain("trust=project");
  expect(text).toContain("lifecycle=session");
  expect(text).toContain("priority=100");
  expect(text).toContain("chars=12");
  expect(text).toContain("path=/repo/AGENTS.md");
  expect(text).toContain("kind=project_instruction");
  expect(text).toContain("scope=project");
  expect(text).toContain("truncated=false");
  expect(text).not.toContain("SECRET fragment content");
  expect(text).not.toContain("--- fragment debug.project begin ---");
});

test("CLI prompt-debug content output includes fragment boundaries", () => {
  const text = formatPromptDebugText(promptDebugOutput(true));

  expect(text).toContain("--- fragment debug.project begin ---");
  expect(text).toContain("SECRET fragment content");
  expect(text).toContain("--- fragment debug.project end ---");
});

test("CLI prompt-debug json output is machine-readable and omits content unless requested", () => {
  const parsed = JSON.parse(formatPromptDebugJson(promptDebugOutput(false))) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    sessionId: "session_prompt_debug",
    threadId: "thread_prompt_debug",
    cwd: "/repo",
    created: true,
  });
  expect(parsed).toHaveProperty("debug");
  expect(parsed).not.toHaveProperty("fragments");

  const parsedWithContent = JSON.parse(formatPromptDebugJson(promptDebugOutput(true))) as {
    fragments?: Array<{ content?: string }>;
  };
  expect(parsedWithContent.fragments?.some((fragment) => fragment.content === "SECRET fragment content")).toBe(true);
});

test("CLI child prompt fragments only inject follow-up context for the matching child thread", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(repo, { recursive: true });
    const task = {
      id: "task_reader" as TaskId,
      path: "/root/task_reader" as AgentPath,
      status: "completed",
      taskName: "reader",
      generation: 1,
      childSessionId: "session_child" as SessionId,
      childThreadId: "thread_actual" as ThreadId,
      cwd: repo,
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentTaskRow;
    const store = {
      agentTasks: async (query?: { childSessionId?: SessionId; limit?: number }) => {
        expect(query).toMatchObject({ childSessionId: "session_child", limit: 10 });
        return [task];
      },
    } as unknown as Parameters<typeof buildCliChildPromptFragments>[0]["store"];
    const common = {
      cwd: repo,
      sessionId: "session_child" as SessionId,
      skillRegistry: new SkillRegistry([]),
      store,
      homeDir: home,
      projectRoot: repo,
    };

    const mismatched = await buildCliChildPromptFragments({
      ...common,
      threadId: "thread_other" as ThreadId,
    });
    expect(mismatched.some((fragment) => fragment.id.startsWith("chili.task.followup."))).toBe(false);

    const matched = await buildCliChildPromptFragments({
      ...common,
      threadId: "thread_actual" as ThreadId,
    });
    expect(matched.find((fragment) => fragment.id.startsWith("chili.task.followup."))).toEqual(
      expect.objectContaining({
        id: "chili.task.followup.task_reader",
        layer: "developer",
        source: "runtime",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdtempName(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chili-harness-"));
}

function skill(name: string, source: Skill["source"] = "project"): Skill {
  return {
    name,
    source,
    filePath: source === "user" ? `/home/.chili/skills/${name}/SKILL.md` : `/repo/.chili/skills/${name}/SKILL.md`,
    baseDir: source === "user" ? `/home/.chili/skills/${name}` : `/repo/.chili/skills/${name}`,
    metadata: {
      name,
      description: "Review code changes.",
      when_to_use: "When reviewing code.",
    },
    body: "review body",
  };
}

function promptDebugOutput(includeContent: boolean): CliPromptDebugOutput {
  const output: CliPromptDebugOutput = {
    sessionId: "session_prompt_debug" as SessionId,
    threadId: "thread_prompt_debug" as ThreadId,
    cwd: "/repo",
    created: true,
    debug: {
      totalChars: 31,
      fragments: [
        {
          id: "debug.base",
          layer: "base",
          source: "core",
          priority: 0,
          chars: 19,
          lifecycle: "stable",
          trust: "system",
        },
        {
          id: "debug.project",
          layer: "contextual_user",
          source: "project",
          priority: 100,
          chars: 12,
          lifecycle: "session",
          trust: "project",
          metadata: {
            path: "/repo/AGENTS.md",
            kind: "project_instruction",
            scope: "project",
            truncated: false,
            truncatedAfter: 5000,
            ruleType: "unconditional",
          },
        },
      ],
    },
  };
  if (!includeContent) return output;
  return {
    ...output,
    fragments: [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        chars: 19,
        lifecycle: "stable",
        trust: "system",
        content: "base fragment text",
      },
      {
        id: "debug.project",
        layer: "contextual_user",
        source: "project",
        priority: 100,
        chars: 12,
        lifecycle: "session",
        trust: "project",
        content: "SECRET fragment content",
        metadata: {
          path: "/repo/AGENTS.md",
          kind: "project_instruction",
          scope: "project",
          truncated: false,
        },
      },
    ],
  };
}
