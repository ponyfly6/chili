import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChiliHost, type ChiliHost, type ChiliHostOptions } from "@chili/host";
import type { RuntimeService } from "@chili/core";
import type { SessionId } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import { resolveSession } from "./session.js";

test("CLI resume accepts only an existing active root session without creating events", async () => {
  const activeSessionId = "session_resume_active" as SessionId;
  const archivedSessionId = "session_resume_archived" as SessionId;
  const childSessionId = "session_resume_child" as SessionId;
  let createCalls = 0;
  const service = {
    async createSession() {
      createCalls += 1;
      return { sessionId: "session_created" as SessionId };
    },
  } as unknown as RuntimeService;
  const store = {
    async sessions() {
      return [
        {
          id: activeSessionId,
          cwd: "/repo",
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: archivedSessionId,
          cwd: "/repo",
          status: "archived" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: childSessionId,
          cwd: "/repo",
          agent: { parentSessionId: activeSessionId, name: "child", path: "/root/child", policy: {} },
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    },
  } as unknown as Pick<EventStore, "sessions">
;
  const input = { service, store, cwd: "/repo" };

  await expect(resolveSession({
    ...input,
    resume: "session_resume_missing",
  })).rejects.toThrow("Session not found: session_resume_missing");
  await expect(resolveSession({
    ...input,
    resume: childSessionId,
  })).rejects.toThrow("belongs to an agent");
  await expect(resolveSession({
    ...input,
    resume: archivedSessionId,
  })).rejects.toThrow("Session is not active: session_resume_archived");
  await expect(resolveSession({
    ...input,
    resume: activeSessionId,
  })).resolves.toEqual({ sessionId: activeSessionId, isNew: false });
  expect(createCalls).toBe(0);
});

test("CLI resumes the persisted project session after restart and execution settings change", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-session-resume-"));
  const cwd = join(root, "project-a");
  let host: ChiliHost | undefined;
  try {
    await mkdir(cwd);
    const options: ChiliHostOptions = {
      cwd, chiliHome: join(root, "home-a"), model: "fake",
      permissionProfile: "auto-review", mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    };
    host = await createChiliHost(options);
    const created = await resolveSession({ service: host.service, store: host.store, cwd });
    expect(created.isNew).toBe(true);
    expect((await host.service.submitPrompt({ sessionId: created.sessionId, text: "remember this session" })).status)
      .toBe("completed");
    await host.close();
    host = undefined;

    host = await createChiliHost({ ...options, chiliHome: join(root, "home-b"), permissionProfile: "full-access" });
    const before = await host.store.events({ sessionId: created.sessionId });
    expect(await resolveSession({ service: host.service, store: host.store, cwd, resume: created.sessionId }))
      .toEqual({ sessionId: created.sessionId, isNew: false });
    expect((await host.store.sessions()).map((session) => session.id)).toEqual([created.sessionId]);
    expect(await host.store.events({ sessionId: created.sessionId })).toEqual(before);
    expect((await host.service.submitPrompt({ sessionId: created.sessionId, text: "continue the same session" })).status)
      .toBe("completed");
    expect((await host.store.sessions()).map((session) => session.id)).toEqual([created.sessionId]);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI resume cannot find another project's session or create a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-session-scope-"));
  const cwdA = join(root, "project-a");
  const cwdB = join(root, "project-b");
  let hostA: ChiliHost | undefined;
  let hostB: ChiliHost | undefined;
  try {
    await mkdir(cwdA);
    await mkdir(cwdB);
    const options: ChiliHostOptions = {
      cwd: cwdA, chiliHome: join(root, "home"), model: "fake",
      permissionProfile: "full-access", mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    };
    hostA = await createChiliHost(options);
    hostB = await createChiliHost({ ...options, cwd: cwdB });
    const sessionA = await resolveSession({ service: hostA.service, store: hostA.store, cwd: cwdA });
    const sessionB = await resolveSession({ service: hostB.service, store: hostB.store, cwd: cwdB });
    const before = await hostA.store.events({});
    await expect(resolveSession({ service: hostA.service, store: hostA.store, cwd: cwdA, resume: sessionB.sessionId }))
      .rejects.toThrow(`Session not found: ${sessionB.sessionId}`);
    expect((await hostA.store.sessions()).map((session) => session.id)).toEqual([sessionA.sessionId]);
    expect((await hostB.store.sessions()).map((session) => session.id)).toEqual([sessionB.sessionId]);
    expect(await hostA.store.events({})).toEqual(before);
  } finally {
    await hostB?.close();
    await hostA?.close();
    await rm(root, { recursive: true, force: true });
  }
});
