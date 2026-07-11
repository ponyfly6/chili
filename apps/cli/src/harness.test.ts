import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { chiliBasePromptFragment, type PromptFragment } from "@chili/core";
import type { AgentPath, ChiliEvent, SessionId, TaskId, ThreadId, TimestampMs } from "@chili/protocol";
import { SkillRegistry, type Skill } from "@chili/skills";
import { SqliteEventStore, type AgentTaskRow } from "@chili/store";
import { buildCliChildPromptFragments, buildCliPromptFragments, createCliHarness, type CliHarness } from "./harness.js";
import { formatPromptDebugJson, formatPromptDebugText, type CliPromptDebugOutput } from "./prompt-debug.js";
import { runPrompt } from "./runner.js";
import { readUserModelSelection, writeUserModelSelection } from "./user-model-state.js";

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

test("CLI harness uses the user last model for new workspaces without forcing a prompt override", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await writeUserModelSelection(
      { provider: "openai-codex", model: "gpt-5.5" },
      { chiliHome: home, now: () => 1 },
    );

    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_user_model" as SessionId,
      threadId: "thread_user_model" as ThreadId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(harness.defaultModelSelection).toBeUndefined();
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness applies default reasoning and service tier", async () => {
  const root = await mkdtempName();
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });

    harness = await createCliHarness({
      cwd: repo,
      model: "fake",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_default_tier" as SessionId,
      threadId: "thread_default_tier" as ThreadId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.reasoningLevel).toBe("xhigh");
    expect(config.serviceTier).toBe("fast");
    expect(harness.defaultReasoningLevel).toBe("xhigh");
    expect(harness.defaultServiceTier).toBe("fast");
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness prefers workspace model history over user last model", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(join(repo, ".chili"), { recursive: true });
    await writeUserModelSelection(
      { provider: "openai-codex", model: "gpt-5.5" },
      { chiliHome: home, now: () => 1 },
    );
    await writeWorkspaceModelEvent(repo, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_workspace_model" as SessionId,
      threadId: "thread_workspace_model" as ThreadId,
    });
    const config = await harness.service.getModelConfig(session.sessionId);

    expect(config.modelSelection).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI harness persists setModel to the user last model state", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  let harness: CliHarness | undefined;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      chiliHome: home,
      model: "fake",
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
    });
    const session = await harness.service.createSession({
      sessionId: "session_set_model" as SessionId,
      threadId: "thread_set_model" as ThreadId,
    });

    await harness.service.setModel({
      ...session,
      modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    });

    expect(await readUserModelSelection({ chiliHome: home })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });
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
    const skillDir = join(repo, ".chili", "skills", "reviewer");
    await mkdir(join(skillDir, "templates"), { recursive: true });
    await writeFile(join(skillDir, "templates", "review.md"), "review template\n", "utf8");
    const skillRegistry = new SkillRegistry([skill("reviewer", "project", skillDir)]);
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
        path: join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        skillFiles: ["templates/review.md"],
      },
    });
    expect(body?.content).toContain("<instructions>\nreview body\n</instructions>");
    expect(body?.content).toContain("<skill_files>\n- templates/review.md");
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

test("CLI runPrompt warns for every output-limit finish reason", async () => {
  let finishReason = "length";
  const harness = {
    service: {
      submitPrompt: async () => ({ status: "completed", turns: [], finishReason }),
    },
  } as unknown as CliHarness;
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = () => undefined;
    console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    for (const reason of ["length", "max_tokens", "max_output_tokens"]) {
      finishReason = reason;
      await runPrompt({
        harness,
        sessionId: "session_output_limit_warning" as SessionId,
        threadId: "thread_output_limit_warning" as ThreadId,
        prompt: "hello",
        maxTurns: 1,
      });
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  expect(warnings).toEqual([
    "[warning] model stopped at length; response may be truncated",
    "[warning] model stopped at max_tokens; response may be truncated",
    "[warning] model stopped at max_output_tokens; response may be truncated",
  ]);
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

async function writeWorkspaceModelEvent(
  repo: string,
  modelSelection: { provider: string; model: string },
): Promise<void> {
  const sessionId = "session_previous_model" as SessionId;
  const threadId = "thread_previous_model" as ThreadId;
  const store = new SqliteEventStore(join(repo, ".chili", "chili.sqlite"));
  const events: ChiliEvent[] = [
    {
      id: "event_previous_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: repo },
    },
    {
      id: "event_previous_model",
      type: "session.model_changed",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, modelSelection },
    },
  ];
  try {
    for (const event of events) await store.append(event);
  } finally {
    store.close();
  }
}

function skill(name: string, source: Skill["source"] = "project", baseDir?: string): Skill {
  const resolvedBaseDir = baseDir ?? (source === "user" ? `/home/.chili/skills/${name}` : `/repo/.chili/skills/${name}`);
  return {
    name,
    source,
    filePath: join(resolvedBaseDir, "SKILL.md"),
    baseDir: resolvedBaseDir,
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
