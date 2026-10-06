import {
  defaultScopedWorkerPolicy,
  type LocalSubagentManager,
  type LocalSubagentTaskInput,
  type WorkerToolPolicy,
  type WorkerToolPolicyTemplate,
} from "@chili/core";
import {
  normalizeAgentPath,
  parentAgentPath,
  ROOT_AGENT_PATH,
  type AgentPath,
  type SessionId,
} from "@chili/protocol";
import type { AgentTaskRow, EventStore, SubagentProjectionStore } from "@chili/store";
import type { SubagentController } from "@chili/tools";
import type { HostAgentConfig } from "./config.js";

type AgentAncestryStore = EventStore & SubagentProjectionStore;

export interface AgentAncestry {
  path: AgentPath;
  depth: number;
  rootSessionId: SessionId;
}

export interface AgentExpansionControllerOptions {
  subagents: LocalSubagentManager;
  store: AgentAncestryStore;
  limits: HostAgentConfig;
  workerPolicyForSession: (sessionId: SessionId) => Promise<WorkerToolPolicy>;
}

/** Resolve identity from durable ownership, never a model-provided path or depth. */
export async function resolveAgentAncestry(
  store: AgentAncestryStore,
  sessionId: SessionId,
): Promise<AgentAncestry> {
  const sessions = new Map((await store.sessions()).map((session) => [session.id, session]));
  const visited = new Set<SessionId>();
  const owners: AgentTaskRow[] = [];
  let currentSessionId = sessionId;
  while (true) {
    if (visited.has(currentSessionId)) {
      throw new Error(`Agent ancestry contains a cycle at session: ${currentSessionId}`);
    }
    visited.add(currentSessionId);
    const session = sessions.get(currentSessionId);
    if (!session) throw new Error(`Agent ancestry session is missing: ${currentSessionId}`);
    const mappings = (await store.agentTasks({ childSessionId: currentSessionId, limit: 2 }))
      .filter((task) => task.childSessionId === currentSessionId);
    if (mappings.length > 1) {
      throw new Error(`Agent ancestry has ambiguous ownership for session: ${currentSessionId}`);
    }
    const owner = mappings[0];
    if (!owner) {
      if (session.source === "subagent") {
        throw new Error(`Agent ancestry is missing the owner of subagent session: ${currentSessionId}`);
      }
      if (session.status !== "active") {
        throw new Error(`Agent ancestry root session is not active: ${currentSessionId}`);
      }
      break;
    }
    if (!owner.parentSessionId) {
      throw new Error(`Agent ancestry is missing a parent session for task: ${owner.id}`);
    }
    owners.push(owner);
    currentSessionId = owner.parentSessionId;
  }

  let path = ROOT_AGENT_PATH;
  for (const owner of owners.toReversed()) {
    const parentPath = owner.parentPath;
    // Team dispatch may add a member segment beneath its owning session's path.
    if (!parentPath || normalizeAgentPath(parentPath) !== parentPath
      || (parentPath !== path && !parentPath.startsWith(`${path}/`))
      || normalizeAgentPath(owner.path) !== owner.path
      || parentAgentPath(owner.path) !== parentPath) {
      throw new Error(`Agent ancestry path does not match its owning session for task: ${owner.id}`);
    }
    path = owner.path;
  }
  return { path, depth: owners.length, rootSessionId: currentSessionId };
}

/** Add delegation capabilities only to a newly created root worker's default policy. */
export function recursiveWorkerPolicy(base: WorkerToolPolicy, limits: HostAgentConfig): WorkerToolPolicy {
  if (limits.maxDepth <= 1 || !base.allowedTools) return { ...base };
  return {
    ...base,
    allowedTools: [...new Set([...base.allowedTools, "agent_spawn", "agent_wait", "agent_stop", "agent_resume"])],
  };
}

export function createAgentExpansionController(options: AgentExpansionControllerOptions): SubagentController {
  return {
    async spawnTask(input, context) {
      context.signal.throwIfAborted();
      const ancestry = await resolveAgentAncestry(options.store, context.sessionId);
      if (options.limits.maxChildren === 0) {
        throw new Error("Agent expansion is disabled because agents.max_children is 0");
      }
      if (ancestry.depth >= options.limits.maxDepth) {
        throw new Error(`Agent expansion reached agents.max_depth=${options.limits.maxDepth} (current depth: ${ancestry.depth})`);
      }
      const inherited = ancestry.depth === 0
        ? recursiveWorkerPolicy(defaultScopedWorkerPolicy(), options.limits)
        : await options.workerPolicyForSession(context.sessionId);
      if (ancestry.depth > 0 && (inherited.teamId !== undefined || inherited.taskId !== undefined)) {
        throw new Error("Recursive ad-hoc delegation is unavailable for team-scoped workers");
      }
      // The manager supplies the new session and path after generating their identity.
      const { childSessionId: _previousChildSessionId, ...policy } = inherited;
      const workerPolicy: WorkerToolPolicyTemplate = {
        ...policy,
        parentSessionId: context.sessionId,
      };
      const task: LocalSubagentTaskInput = {
        parentSessionId: context.sessionId,
        parentPath: ancestry.path,
        cwd: context.cwd,
        taskName: input.description,
        prompt: input.prompt,
        workerPolicy,
        bindWorkerIdentity: true,
        maxChildren: options.limits.maxChildren,
        signal: context.signal,
        sourceCallId: context.callId,
        ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
        ...(input.batchIndex !== undefined ? { batchIndex: input.batchIndex } : {}),
        ...(input.expectedBatchSize !== undefined ? { expectedBatchSize: input.expectedBatchSize } : {}),
        ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
        ...(input.completionPolicy !== undefined ? { completionPolicy: input.completionPolicy } : {}),
      };
      if (input.mode !== undefined) {
        if (input.mode !== "one_shot" && input.mode !== "resumable" && input.mode !== "background") {
          throw new Error(`Unsupported agent execution mode: ${input.mode}`);
        }
        task.mode = input.mode;
      }
      context.signal.throwIfAborted();
      const result = await options.subagents.spawnTask(task);
      return { taskId: result.taskId, status: result.status, summary: result.summary ?? "" };
    },
    completeTask(input) {
      return options.subagents.completeTask(input);
    },
  };
}
