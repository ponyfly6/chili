import {
  DELEGATION_POLICIES,
  isTransientEvent,
  normalizePersistedError,
  normalizeSessionTitle,
  parseRuntimeArray,
  parseRuntimeBoolean,
  parseRuntimeModelSelection,
  parseRuntimeRecord,
  parseRuntimeString,
  parseRuntimeStringArray,
  parseRuntimeStringRecord,
  parseUserInputAnswers,
  rejectRuntimeUnknownFields,
  RUNTIME_PERMISSION_PROFILE_IDS,
  RuntimeValidationError,
} from "@chili/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  resolveTeamSessionAuthority,
  RuntimeSessionNotFoundError,
  TeamSessionAuthorityError,
} from "@chili/core";
import type {
  ChiliEvent,
  EventEnvelope,
  AgentPath,
  AgentTaskMode,
  AgentTaskStatus,
  ApprovalDecisionAction,
  DelegationPolicy,
  RuntimeInterruptResult,
  RuntimeDelegationConfig,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimeMcpAddServerRequest,
  RuntimeMcpControlService,
  RuntimeMcpScopeInput,
  RuntimeMcpAuthRequest,
  RuntimeMcpListResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  RuntimeMcpTransport,
  MessageImageContent,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimeApprovalResolveResult,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  RuntimeTurnResult,
  RuntimeSkillMention,
  ModelSelection,
  ReasoningLevel,
  ServiceTier,
  SessionId,
  TaskId,
  TeamId,
  TeamMessageDelivery,
  SessionGoal,
  SessionGoalStatus,
  PendingUserInputRequest,
  UserInputAnswers,
  UserInputId,
} from "@chili/protocol";
import type {
  AgentTreeSnapshot,
  AgentTreeSnapshotQuery,
  ConsumeAgentMailboxInput,
  AgentTaskCloseInput,
  AgentTaskFinalStatus,
  AgentTaskFollowupInput,
  AgentTaskFollowupResult,
  AgentTaskReconcileStaleInput,
  AgentTaskReconcileStaleResult,
  AgentTaskWaitInput,
  RuntimeBackgroundErrorHandler,
  AddTeamMemberInput,
  AssignTeamTaskInput,
  ClaimTeamTaskInput,
  CreateTeamInput,
  CreateTeamTaskInput,
  SendTeamMessageInput,
  SubmitPromptInput,
  SubmitPromptResult,
  TeamTaskDispatchInput,
  TeamTaskDispatchResult,
  TeamExecutionRunInput,
  TeamExecutionRunSummary,
  TeamMergeInput,
  TeamMergeSweepResult,
  TeamTaskReconcileInput,
  TeamTaskReconcileResult,
  TeamTaskSyncInput,
  TeamTaskSyncResult,
  TeamSnapshot,
  UpdateTeamTaskInput,
} from "@chili/core";
import { UnknownEventCursorError } from "@chili/store";
import type { EventPublisher, EventStore } from "@chili/store";
import {
  jsonEventArrayUtf8Bytes,
  ReplayableRuntimeEventWindowAccumulator,
  runtimeEventDependencyKey,
  runtimeEventJsonUtf8Bytes,
  runtimeEventProvides,
  runtimeEventRequires,
  type RuntimePendingApprovalRequest,
  type RuntimePendingApprovalWindow,
  type RuntimeSessionEventWindow,
} from "@chili/sdk";
import {
  preparePromptCommandSubmission,
  PromptCommandNotFoundError,
  PromptCommandUsageError,
  type PromptCommandControl,
} from "@chili/commands";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskQuery,
  AgentTaskRow,
  TeamMemberRow,
  TeamMessageRow,
  TeamRow,
  TeamTaskMutationResult,
  TeamTaskRow,
} from "@chili/store";
import { projectRuntimeAgents } from "./agent-projection.js";

export interface RuntimeHttpSessionOperation {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface RuntimeHttpService {
  withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeHttpSessionOperation) => Promise<T> | T,
  ): Promise<T>;
  createSession(input?: { sessionId?: SessionId; cwd?: string }): Promise<RuntimeSessionRef>;
  listModels?(input?: { provider?: string }): Promise<RuntimeModelDescriptor[]>;
  getModelConfig?(sessionId: SessionId): Promise<RuntimeModelConfig>;
  setModel?(input: { sessionId: SessionId; modelSelection: ModelSelection }): Promise<RuntimeModelConfig>;
  setReasoning?(input: { sessionId: SessionId; reasoningLevel: ReasoningLevel }): Promise<RuntimeModelConfig>;
  setServiceTier?(input: { sessionId: SessionId; serviceTier: ServiceTier }): Promise<RuntimeModelConfig>;
  getDelegationConfig?(sessionId: SessionId): Promise<RuntimeDelegationConfig>;
  setDelegationPolicy?(input: { sessionId: SessionId; policy: DelegationPolicy }): Promise<RuntimeDelegationConfig>;
  getGoal?(input: { sessionId: SessionId }): Promise<SessionGoal | undefined>;
  setGoal?(input: { sessionId: SessionId; objective: string; tokenBudget?: number; replace?: boolean }): Promise<SessionGoal>;
  updateGoal?(input: { sessionId: SessionId; status?: SessionGoalStatus; objective?: string; tokenBudget?: number }): Promise<SessionGoal>;
  clearGoal?(input: { sessionId: SessionId }): Promise<{ cleared: boolean; previousGoal?: SessionGoal }>;
  assertSessionReadAllowed(sessionId: SessionId): Promise<void>;
  assertSessionTurnAllowed(sessionId: SessionId): Promise<void>;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  submitPromptAsync(input: SubmitPromptInput, onError?: RuntimeBackgroundErrorHandler): void;
  interrupt(sessionId: SessionId, reason?: string): Promise<boolean>;
  archiveSession(sessionId: SessionId): Promise<void>;
  renameSession?(sessionId: SessionId, title: string): Promise<void>;
}

export interface RuntimeTaskControlService {
  listTasks(query?: AgentTaskQuery): Promise<AgentTaskRow[]>;
  getTask(taskId: TaskId): Promise<AgentTaskRow>;
  followupTask(input: AgentTaskFollowupInput): Promise<AgentTaskFollowupResult>;
  waitForTask(input: AgentTaskWaitInput): Promise<AgentTaskRow>;
  closeTask(input: AgentTaskCloseInput): Promise<AgentTaskRow>;
  reconcileStaleTasks(input?: AgentTaskReconcileStaleInput): Promise<AgentTaskReconcileStaleResult>;
}

export interface RuntimeAgentTreeService {
  snapshot(query?: AgentTreeSnapshotQuery): Promise<AgentTreeSnapshot>;
  agentRuns(query?: AgentRunQuery): Promise<AgentRunRow[]>;
  mailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]>;
  consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow>;
}

export interface RuntimeTeamService {
  listTeams(): Promise<TeamRow[]>;
  snapshot(teamId: TeamId): Promise<TeamSnapshot>;
  members(teamId: TeamId): Promise<TeamMemberRow[]>;
  tasks(teamId: TeamId): Promise<TeamTaskRow[]>;
  messages(teamId: TeamId): Promise<TeamMessageRow[]>;
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  addMember(input: AddTeamMemberInput): Promise<TeamMemberRow>;
  createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
  assignTask(input: AssignTeamTaskInput): Promise<TeamTaskRow>;
  claimTask(input: ClaimTeamTaskInput): Promise<TeamTaskMutationResult>;
  updateTask(input: UpdateTeamTaskInput): Promise<TeamTaskRow>;
  sendMessage(input: SendTeamMessageInput): Promise<TeamMessageRow>;
}

export interface RuntimeTeamDispatcherService {
  dispatchTask(input: TeamTaskDispatchInput): Promise<TeamTaskDispatchResult>;
  syncTask(input: TeamTaskSyncInput): Promise<TeamTaskSyncResult>;
  reconcileTasks(input?: TeamTaskReconcileInput): Promise<TeamTaskReconcileResult>;
}

export interface RuntimeTeamExecutionRunnerService {
  run(input: TeamExecutionRunInput): Promise<TeamExecutionRunSummary>;
}

export interface RuntimeTeamMergeService {
  mergeTeamTasks(input: TeamMergeInput): Promise<TeamMergeSweepResult>;
}

export type { RuntimeMcpScopeInput, RuntimeMcpControlService } from "@chili/protocol";

export interface RuntimeHttpHandlerOptions {
  service: RuntimeHttpService;
  store: EventStore & EventPublisher;
  authToken?: string;
  tasks?: RuntimeTaskControlService;
  agents?: RuntimeAgentTreeService;
  teams?: RuntimeTeamService;
  teamDispatcher?: RuntimeTeamDispatcherService;
  teamMerger?: RuntimeTeamMergeService;
  teamRunner?: RuntimeTeamExecutionRunnerService;
  approvals?: ApprovalResolver;
  userInputs?: UserInputController;
  permissions?: PermissionProfileControl;
  commands?: PromptCommandControl;
  mcp?: RuntimeMcpControlService;
  maxBacklogEvents?: number;
  maxEventStreamDurableEvents?: number;
  maxEventStreamAgeMs?: number;
  maxSessionEventWindowBytes?: number;
  maxSessionEventScanPages?: number;
  maxSessionEventScanEvents?: number;
  maxSessionEventScanBytes?: number;
  maxSessionEventScanMs?: number;
  maxSessionEventWindowConcurrency?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface ApprovalResolver {
  resolve(input: {
    approvalId: import("@chili/protocol").ApprovalId;
    decision: ApprovalDecisionAction;
    feedback?: string;
  }): boolean | Promise<boolean>;
  maxApprovalScope?(approvalId: import("@chili/protocol").ApprovalId): import("@chili/protocol").ApprovalScope | undefined | Promise<import("@chili/protocol").ApprovalScope | undefined>;
}

export interface UserInputController {
  list(input?: { sessionId?: SessionId }): readonly PendingUserInputRequest[] | Promise<readonly PendingUserInputRequest[]>;
  resolve(input: {
    inputId: UserInputId;
    answers: UserInputAnswers;
  }): boolean | Promise<boolean>;
}

export interface PermissionProfileControl {
  get(): RuntimePermissionConfig | Promise<RuntimePermissionConfig>;
  set(profile: RuntimePermissionProfileId): RuntimePermissionConfig | Promise<RuntimePermissionConfig>;
}

export interface StartRuntimeHttpServerOptions extends RuntimeHttpHandlerOptions {
  hostname?: string;
  port?: number;
  idleTimeout?: number;
  tls?: Bun.TLSOptions | Bun.TLSOptions[];
}

export interface RuntimeHttpServer {
  url: string;
  close(): Promise<void>;
}

export const RUNTIME_HTTP_MINIMUM_REMOTE_AUTH_TOKEN_BYTES = 32;

export function createRuntimeHttpHandler(options: RuntimeHttpHandlerOptions): (request: Request) => Promise<Response> {
  const maxBacklogEvents = options.maxBacklogEvents ?? 5000;
  const maxEventStreamDurableEvents = positiveIntegerOrDefault(
    options.maxEventStreamDurableEvents,
    4096,
  );
  const maxEventStreamAgeMs = positiveIntegerOrDefault(options.maxEventStreamAgeMs, 5 * 60_000);
  const sessionEventWindowLimits: SessionEventWindowLimits = {
    maxBytes: positiveIntegerOrDefault(options.maxSessionEventWindowBytes, 4_000_000),
    maxScanPages: positiveIntegerOrDefault(options.maxSessionEventScanPages, 512),
    maxScanEvents: positiveIntegerOrDefault(options.maxSessionEventScanEvents, 4_096),
    maxScanBytes: positiveIntegerOrDefault(options.maxSessionEventScanBytes, 4_000_000),
    maxScanMs: positiveIntegerOrDefault(options.maxSessionEventScanMs, 250),
  };
  const sessionEventWindowAdmission = new AsyncAdmissionGate(
    positiveIntegerOrDefault(options.maxSessionEventWindowConcurrency, 4),
  );
  const inFlightSessionEventWindows = new Map<string, Promise<RuntimeSessionEventWindow>>();
  const authTokenDigest = configuredAuthTokenDigest(options.authToken);

  return async function runtimeHttpHandler(request: Request): Promise<Response> {
    if (authTokenDigest && !hasValidBearerToken(request, authTokenDigest)) {
      return unauthorized();
    }
    if (isUnsafeHttpMethod(request.method) && request.headers.has("origin")) {
      return jsonError(403, "Browser-originated runtime mutations are disabled");
    }

    const url = new URL(request.url);
    const route = routeRequest(request.method, url.pathname);

    try {
      if (route.name === "health") {
        return json({ ok: true });
      }

      if (route.name === "listSessions") {
        return json(await options.store.sessions());
      }

      if (route.name === "models") {
        const provider = url.searchParams.get("provider") ?? undefined;
        return json(await requireModelControl(options).listModels(provider ? { provider } : {}));
      }

      if (route.name === "permissionsConfig") {
        if (!options.permissions) return jsonError(501, "No permission profile controller is configured");
        return json(await options.permissions.get());
      }

      if (route.name === "setPermissions") {
        if (!options.permissions) return jsonError(501, "No permission profile controller is configured");
        const body = await readJson<PermissionsBody>(request, ["profile"]);
        if (!isRuntimePermissionProfileId(body.profile)) throw badRequest("profile must be default, auto-review, or full-access");
        return json(await options.permissions.set(body.profile));
      }

      if (route.name === "commands") {
        if (!route.sessionId) return json(await requireCommandControl(options).list());
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const session = await requireSession(options.store, route.sessionId);
        const cwd = await authoritativeRequestCwd(session.cwd, undefined);
        return json(await requireCommandControl(options).list({ cwd }));
      }

      if (route.name === "commandsReload") {
        if (!route.sessionId) return json(await requireCommandControl(options).reload());
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const session = await requireSession(options.store, route.sessionId);
        const cwd = await authoritativeRequestCwd(session.cwd, undefined);
        return json(await requireCommandControl(options).reload({ cwd }));
      }

      if (route.name === "mcpList") {
        return json(await requireMcpControl(options).list(await mcpScopeFromRequest(options, url)));
      }

      if (route.name === "mcpStatus") {
        const mcp = requireMcpControl(options);
        const scope = await mcpScopeFromRequest(options, url);
        return json(mcp.status ? await mcp.status(scope) : statusFromMcpList(await mcp.list(scope)));
      }

      if (route.name === "mcpReload") {
        const mcp = requireMcpControl(options);
        if (!mcp.reload) return jsonError(501, "No MCP reload controller is configured");
        return json(await withMcpMutationScope(options, url, (scope) => mcp.reload!(scope)));
      }

      if (route.name === "mcpAdd") {
        const mcp = requireMcpControl(options);
        if (!mcp.add) return jsonError(501, "No MCP add controller is configured");
        const body = await readJson<McpAddBody>(request, [
          "name", "transport", "command", "args", "env", "cwd", "url", "headers", "description", "enabled",
        ]);
        const input = mcpAddInput(body);
        if (mcpAddCreatesStdioServer(input)) {
          return jsonError(403, "Adding stdio MCP servers over HTTP is disabled because it can execute local commands.");
        }
        return json(await mcp.add(input), 201);
      }

      if (route.name === "mcpServer") {
        return json(await mcpServerDescriptor(
          requireMcpControl(options),
          route.server,
          await mcpScopeFromRequest(options, url),
        ));
      }

      if (route.name === "mcpRemove") {
        const mcp = requireMcpControl(options);
        if (!mcp.remove) return jsonError(501, "No MCP remove controller is configured");
        return json(await mcp.remove(route.server));
      }

      if (route.name === "mcpTools") {
        const mcp = requireMcpControl(options);
        if (!mcp.tools) return jsonError(501, "No MCP tools controller is configured");
        return json(await mcp.tools(route.server, await mcpScopeFromRequest(options, url)));
      }

      if (route.name === "mcpAuth") {
        const mcp = requireMcpControl(options);
        if (!mcp.auth) return jsonError(501, "No MCP auth controller is configured");
        return json(await mcp.auth(route.server, mcpAuthInput(await readJson<McpAuthBody>(request, ["callbackUrl", "scopes"]))));
      }

      if (route.name === "mcpLogout") {
        const mcp = requireMcpControl(options);
        if (!mcp.logout) return jsonError(501, "No MCP logout controller is configured");
        return json(await mcp.logout(route.server));
      }

      if (route.name === "listTasks") {
        const tasks = requireTaskControl(options);
        return json(await tasks.listTasks(taskQueryFromUrl(url)));
      }

      if (route.name === "tasksReconcileStale") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskReconcileStaleBody>(request, [
          "parentSessionId", "staleAfterMs", "modes", "limit", "summary", "error",
        ]);
        return json(await tasks.reconcileStaleTasks(reconcileStaleInput(body)));
      }

      if (route.name === "task") {
        const tasks = requireTaskControl(options);
        return json(await tasks.getTask(route.taskId));
      }

      if (route.name === "taskFollowup") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskFollowupBody>(request, ["text", "maxTurns", "system"]);
        rejectLegacySystemField(body);
        const input: AgentTaskFollowupInput = {
          taskId: route.taskId,
          text: stringField(body.text, "text"),
          signal: request.signal,
        };
        if (body.maxTurns !== undefined) input.maxTurns = positiveInteger(body.maxTurns, "maxTurns");
        return json(serializeTaskFollowupResult(await tasks.followupTask(input)));
      }

      if (route.name === "taskWait") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskWaitBody>(request, ["timeoutMs"]);
        const input: AgentTaskWaitInput = { taskId: route.taskId, signal: request.signal };
        if (body.timeoutMs !== undefined) input.timeoutMs = nonNegativeInteger(body.timeoutMs, "timeoutMs");
        return json(await tasks.waitForTask(input));
      }

      if (route.name === "taskClose") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskCloseBody>(request, ["status", "summary", "error", "interrupt"]);
        const input: AgentTaskCloseInput = {
          taskId: route.taskId,
          status: closeStatus(body.status),
        };
        if (body.summary !== undefined) input.summary = stringField(body.summary, "summary");
        if (body.error !== undefined) input.error = stringField(body.error, "error");
        if (body.interrupt !== undefined) input.interrupt = parseRuntimeBoolean(body.interrupt, "body.interrupt");
        return json(await tasks.closeTask(input));
      }

      if (route.name === "agentTree") {
        const agents = requireAgentTree(options);
        return json(await agents.snapshot(agentTreeQueryFromUrl(url)));
      }

      if (route.name === "agentRuns") {
        const agents = requireAgentTree(options);
        return json(await agents.agentRuns(agentRunQueryFromUrl(url)));
      }

      if (route.name === "mailbox") {
        const agents = requireAgentTree(options);
        return json(await agents.mailbox(mailboxQueryFromUrl(url)));
      }

      if (route.name === "consumeMailbox") {
        const agents = requireAgentTree(options);
        return json(await agents.consumeMailbox({ messageId: route.messageId }));
      }

      if (route.name === "agents") {
        const events = await readAllProjectionEvents(options.store, route.sessionId, maxBacklogEvents);
        return json(projectRuntimeAgents(events, route.sessionId));
      }

      if (route.name === "listTeams") {
        const teams = requireTeams(options);
        return json(await teams.listTeams());
      }

      if (route.name === "createTeam") {
        const teams = requireTeams(options);
        const body = await readJson<TeamCreateBody>(request, [
          "teamId", "sessionId", "name", "leadPath", "description", "leadName", "leadRole", "leadStatus", "leadWriteScope",
        ]);
        if (!body.name) throw badRequest("name is required");
        if (!body.leadPath) throw badRequest("leadPath is required");
        const input = teamCreateInput(body);
        if (!input.sessionId) return json(await teams.createTeam(input), 201);
        const sessionId = input.sessionId;
        await resolveHttpInteractiveSession(options, sessionId);
        return json(await options.service.withSessionOperation(sessionId, async (operation) => {
          await resolveHttpInteractiveSession(options, sessionId);
          operation.assertCurrent();
          return teams.createTeam(input);
        }), 201);
      }

      if (route.name === "teamReconcileDispatches") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamTaskReconcileBody>(request, ["teamId", "sessionId", "limit"]);
        const input = teamTaskReconcileInput(route.teamId, body);
        await assertHttpTeamReconcileAuthority(options, input);
        return json(await dispatcher.reconcileTasks(input));
      }

      if (route.name === "teamRunLoop") {
        const runner = requireTeamRunner(options);
        const body = await readJson<TeamRunLoopBody>(request, [
          "teamId", "sessionId", "cwd", "mode", "once", "maxCycles", "timeoutMs", "pollIntervalMs",
        ]);
        const input = teamRunLoopInput(route.teamId, body);
        const team = await requireHttpTeam(options, route.teamId);
        if (team.status !== "active") {
          throw new TeamSessionAuthorityError(`Cannot operate on archived team ${team.id}`);
        }
        if (team.sessionId) {
          const authority = await resolveHttpTeamAuthority(options, route.teamId, input.sessionId, input.cwd);
          input.sessionId = authority.sessionId;
          input.cwd = authority.cwd;
        } else {
          // An unbound team must let the runner create and atomically persist a
          // fresh owner session. Never promote a caller-provided id to owner.
          delete input.sessionId;
        }
        input.signal = request.signal;
        return json(await runner.run(input));
      }

      if (route.name === "teamMerge") {
        const merger = requireTeamMerger(options);
        const body = await readJson<TeamMergeBody>(request, ["teamId", "sessionId", "taskId", "cwd"]);
        const input = teamMergeInput(route.teamId, body);
        const authority = await resolveHttpTeamAuthority(options, route.teamId, input.sessionId, input.cwd);
        input.sessionId = authority.sessionId;
        input.cwd = authority.cwd;
        input.signal = request.signal;
        return json(await merger.mergeTeamTasks(input));
      }

      if (route.name === "teamMembers") {
        const teams = requireTeams(options);
        return json(await teams.members(route.teamId));
      }

      if (route.name === "teamSnapshot") {
        const teams = requireTeams(options);
        return json(await teams.snapshot(route.teamId));
      }

      if (route.name === "teamAddMember") {
        const teams = requireTeams(options);
        const body = await readJson<TeamMemberBody>(request, [
          "teamId", "sessionId", "path", "name", "role", "status", "childSessionId", "model", "toolScope", "writeScope",
        ]);
        if (!body.path) throw badRequest("path is required");
        if (!body.name) throw badRequest("name is required");
        if (!body.role) throw badRequest("role is required");
        const input = teamMemberInput(route.teamId, body);
        return json(await withHttpTeamOwnerMutation(options, route.teamId, input.sessionId, async (authority) => {
          input.sessionId = authority.sessionId;
          return teams.addMember(input);
        }), 201);
      }

      if (route.name === "teamTasks") {
        const teams = requireTeams(options);
        return json(await teams.tasks(route.teamId));
      }

      if (route.name === "teamCreateTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskCreateBody>(request, [
          "teamId", "sessionId", "taskId", "title", "description", "createdBy", "ownerPath", "dependsOn", "status", "metadata",
        ]);
        if (!body.title) throw badRequest("title is required");
        const input = teamTaskCreateInput(route.teamId, body);
        return json(await withHttpTeamOwnerMutation(options, route.teamId, input.sessionId, async (authority) => {
          input.sessionId = authority.sessionId;
          return teams.createTask(input);
        }), 201);
      }

      if (route.name === "teamAssignTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskAssignBody>(request, [
          "teamId", "taskId", "sessionId", "ownerPath", "assignedBy", "message", "messageDelivery", "messageSummary",
        ]);
        if (!body.ownerPath) throw badRequest("ownerPath is required");
        const input = teamTaskAssignInput(route.teamId, route.taskId, body);
        return json(await withHttpTeamOwnerMutation(options, route.teamId, input.sessionId, async (authority) => {
          input.sessionId = authority.sessionId;
          return teams.assignTask(input);
        }));
      }

      if (route.name === "teamClaimTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskClaimBody>(request, ["teamId", "taskId", "sessionId", "ownerPath", "claimedBy"]);
        if (!body.ownerPath) throw badRequest("ownerPath is required");
        const input = teamTaskClaimInput(route.teamId, route.taskId, body);
        return json(await withHttpTeamOwnerMutation(options, route.teamId, input.sessionId, async (authority) => {
          input.sessionId = authority.sessionId;
          return teams.claimTask(input);
        }));
      }

      if (route.name === "teamDispatchTask") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamTaskDispatchBody>(request, ["teamId", "taskId", "sessionId", "ownerPath", "cwd", "mode", "prompt"]);
        const input = teamTaskDispatchInput(route.teamId, route.taskId, body);
        const authority = await resolveHttpTeamAuthority(options, route.teamId, input.sessionId, input.cwd);
        input.sessionId = authority.sessionId;
        input.cwd = authority.cwd;
        input.signal = request.signal;
        return json(
          serializeTeamTaskDispatchResult(await dispatcher.dispatchTask(input)),
        );
      }

      if (route.name === "teamSyncTask") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamContextBody>(request, ["teamId", "taskId", "sessionId"]);
        const input = teamTaskSyncInput(route.teamId, route.taskId, body);
        const authority = await resolveHttpTeamAuthority(options, route.teamId, input.sessionId, undefined);
        input.sessionId = authority.sessionId;
        return json(await dispatcher.syncTask(input));
      }

      if (route.name === "teamUpdateTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskUpdateBody>(request, [
          "teamId", "taskId", "sessionId", "status", "ownerPath", "title", "description", "dependsOn", "summary", "error", "metadata",
        ]);
        const input = teamTaskUpdateInput(route.teamId, route.taskId, body);
        return json(await withHttpTeamOwnerMutation(options, route.teamId, input.sessionId, async (authority) => {
          input.sessionId = authority.sessionId;
          return teams.updateTask(input);
        }));
      }

      if (route.name === "teamMessages") {
        const teams = requireTeams(options);
        return json(await teams.messages(route.teamId));
      }

      if (route.name === "teamSendMessage") {
        const teams = requireTeams(options);
        const body = await readJson<TeamMessageBody>(request, [
          "teamId", "sessionId", "messageId", "from", "to", "content", "kind", "delivery", "taskId", "summary", "metadata",
        ]);
        if (!body.from) throw badRequest("from is required");
        if (!body.to) throw badRequest("to is required");
        if (!body.content) throw badRequest("content is required");
        const input = teamMessageInput(route.teamId, body);
        const authority = await resolveHttpTeamAuthority(options, route.teamId, undefined, undefined);
        const actorSessionId = input.sessionId;
        if (actorSessionId && actorSessionId !== authority.sessionId) {
          await resolveHttpActiveActorSession(options, actorSessionId);
        }
        return json(await options.service.withSessionOperation(authority.sessionId, async (operation) => {
          const current = await resolveHttpTeamAuthority(
            options,
            route.teamId,
            authority.sessionId,
            undefined,
          );
          if (actorSessionId && actorSessionId !== current.sessionId) {
            await resolveHttpActiveActorSession(options, actorSessionId);
            input.sessionId = actorSessionId;
          } else {
            input.sessionId = current.sessionId;
          }
          operation.assertCurrent();
          return teams.sendMessage(input);
        }), 201);
      }

      if (route.name === "createSession") {
        const body = await readJson<CreateSessionBody>(request, ["sessionId", "cwd"]);
        const input: { sessionId?: SessionId; cwd?: string } = {};
        if (body.sessionId !== undefined) input.sessionId = requestSessionId(body.sessionId);
        if (body.cwd !== undefined) input.cwd = await requestWorkspaceCwd(body.cwd);
        return json(await options.service.createSession(input), 201);
      }

      if (route.name === "messages") {
        return json(await options.store.messages(route.sessionId));
      }

      if (route.name === "sessionEvents") {
        await requireSession(options.store, route.sessionId);
        rejectUnknownQueryParameters(url, ["limit", "window"]);
        const requestedLimit = Number(url.searchParams.get("limit") ?? "5000");
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(5_000, Math.trunc(requestedLimit)))
          : 5_000;
        const windowKey = `${route.sessionId}\u0000${limit}`;
        let windowPromise = inFlightSessionEventWindows.get(windowKey);
        if (!windowPromise) {
          windowPromise = sessionEventWindowAdmission.run(async () => replayableSessionEventWindow({
            store: options.store,
            sessionId: route.sessionId,
            limit,
            limits: sessionEventWindowLimits,
            pendingInputs: options.userInputs
              ? await options.userInputs.list({ sessionId: route.sessionId })
              : [],
          }));
          inFlightSessionEventWindows.set(windowKey, windowPromise);
          void windowPromise.finally(() => {
            if (inFlightSessionEventWindows.get(windowKey) === windowPromise) {
              inFlightSessionEventWindows.delete(windowKey);
            }
          }).catch(() => undefined);
        }
        const window = await windowPromise;
        if (url.searchParams.get("window") === "replayable") return json(window);
        return json(window.events, 200, {
          "x-chili-event-window-truncated": String(window.truncated),
          "x-chili-event-window-bytes": String(window.bytes),
        });
      }

      if (route.name === "renameSession") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        if (!options.service.renameSession) return jsonError(501, "Session rename is not available from this runtime");
        const body = await readJson<RenameSessionBody>(request, ["title"]);
        let title: string;
        try {
          title = normalizeSessionTitle(parseRuntimeString(body.title, "body.title", { allowEmpty: true }));
        } catch (error) {
          if (error instanceof TypeError) throw badRequest(error.message);
          throw error;
        }
        await options.service.renameSession(route.sessionId, title);
        const renamed = (await options.store.sessions()).find((session) => session.id === route.sessionId);
        if (!renamed) throw notFound(`Session not found: ${route.sessionId}`);
        return json(renamed);
      }

      if (route.name === "modelConfig") {
        await requireSession(options.store, route.sessionId);
        return json(await requireModelControl(options).getModelConfig(route.sessionId));
      }

      if (route.name === "setModel") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const body = await readJson<ModelBody>(request, ["modelSelection"]);
        if (!isModelSelection(body.modelSelection)) throw badRequest("modelSelection with provider and model is required");
        return json(await requireModelControl(options).setModel({
          sessionId: route.sessionId,
          modelSelection: body.modelSelection,
        }));
      }

      if (route.name === "setReasoning") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const body = await readJson<ReasoningBody>(request, ["reasoningLevel"]);
        if (!isReasoningLevel(body.reasoningLevel)) {
          throw badRequest("reasoningLevel must be off, minimal, low, medium, high, xhigh, max, or ultra");
        }
        return json(await requireModelControl(options).setReasoning({
          sessionId: route.sessionId,
          reasoningLevel: body.reasoningLevel,
        }));
      }

      if (route.name === "setServiceTier") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const body = await readJson<ServiceTierBody>(request, ["serviceTier"]);
        if (!isServiceTier(body.serviceTier)) {
          throw badRequest("serviceTier must be standard or fast");
        }
        return json(await requireServiceTierControl(options).setServiceTier({
          sessionId: route.sessionId,
          serviceTier: body.serviceTier,
        }));
      }

      if (route.name === "delegationConfig") {
        await requireSession(options.store, route.sessionId);
        return json(await requireDelegationControl(options).getDelegationConfig(route.sessionId));
      }

      if (route.name === "setDelegationPolicy") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const body = await readJson<DelegationBody>(request, ["policy"]);
        if (!isDelegationPolicy(body.policy)) {
          throw badRequest("policy must be off, explicit, or proactive");
        }
        return json(await requireDelegationControl(options).setDelegationPolicy({
          sessionId: route.sessionId,
          policy: body.policy,
        }));
      }

      if (route.name === "goal") {
        const goals = requireGoalControl(options);
        if (request.method === "GET") {
          rejectUnknownQueryParameters(url, []);
          await requireSession(options.store, route.sessionId);
          const goal = await goals.getGoal({ sessionId: route.sessionId });
          return goal ? json(goal) : new Response(null, { status: 204 });
        }
        if (request.method === "POST") {
          const body = await readJson<GoalBody>(request, ["objective", "tokenBudget", "replace"]);
          const input = goalSetInput(route.sessionId, body);
          await options.service.assertSessionTurnAllowed(route.sessionId);
          await requireSession(options.store, route.sessionId);
          return json(await goals.setGoal(input), 201);
        }
        if (request.method === "PATCH") {
          const body = await readJson<GoalBody>(request, ["status", "objective", "tokenBudget"]);
          const input = goalUpdateInput(route.sessionId, body);
          await options.service.assertSessionTurnAllowed(route.sessionId);
          await requireSession(options.store, route.sessionId);
          return json(await goals.updateGoal(input));
        }
        if (request.method === "DELETE") {
          rejectUnknownQueryParameters(url, []);
          await options.service.assertSessionTurnAllowed(route.sessionId);
          await requireSession(options.store, route.sessionId);
          return json(await goals.clearGoal({ sessionId: route.sessionId }));
        }
      }

      if (route.name === "prompt" || route.name === "promptAsync") {
        const body = await readJson<PromptBody>(request, [
          "text", "displayText", "images", "skillMentions", "cwd", "maxTurns", "modelSelection", "reasoningLevel", "serviceTier", "system",
        ]);
        rejectLegacySystemField(body);
        const promptImages = parsePromptImages(body.images);
        if (!body.text && promptImages.length === 0) throw badRequest("text is required");
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const session = await requireSession(options.store, route.sessionId);
        const cwd = await authoritativeRequestCwd(session.cwd, body.cwd);

        const input = buildSubmitPromptInput(route.sessionId, body, promptImages);
        input.cwd = cwd;

        if (route.name === "prompt") {
          return json(serializeSubmitPromptResult(await options.service.submitPrompt(input)));
        }

        options.service.submitPromptAsync(input, options.onBackgroundError);
        const accepted: RuntimePromptAccepted = {
          status: "accepted",
          sessionId: route.sessionId,
        };
        return json(accepted, 202);
      }

      if (route.name === "command" || route.name === "commandAsync") {
        const body = await readJson<CommandPromptBody>(request, [
          "commandId", "name", "args", "cwd", "modelSelection", "reasoningLevel", "serviceTier",
        ]);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        const session = await requireSession(options.store, route.sessionId);
        if (typeof body.commandId !== "string" || body.commandId.trim().length === 0) {
          throw badRequest("commandId is required");
        }
        if (body.args !== undefined && typeof body.args !== "string") throw badRequest("args must be a string when provided");
        const cwd = await authoritativeRequestCwd(session.cwd, body.cwd);

        // Validate all caller-supplied options before expanding an MCP command.
        const input = buildSubmitPromptInput(route.sessionId, {
          text: "",
          cwd,
          ...(body.modelSelection !== undefined ? { modelSelection: body.modelSelection } : {}),
          ...(body.reasoningLevel !== undefined ? { reasoningLevel: body.reasoningLevel } : {}),
          ...(body.serviceTier !== undefined ? { serviceTier: body.serviceTier } : {}),
        });
        const command = await preparePromptCommandSubmission(requireCommandControl(options), {
          commandId: body.commandId.trim(),
          ...(body.args ? { args: body.args } : {}),
          cwd,
        });
        Object.assign(input, command);

        if (route.name === "command") {
          return json(serializeSubmitPromptResult(await options.service.submitPrompt(input)));
        }

        options.service.submitPromptAsync(input, options.onBackgroundError);
        const accepted: RuntimePromptAccepted = {
          status: "accepted",
          sessionId: route.sessionId,
        };
        return json(accepted, 202);
      }

      if (route.name === "interrupt") {
        const body = await readJson<InterruptBody>(request, ["reason"]);
        const reason = body.reason === undefined ? undefined : stringField(body.reason, "reason");
        const result: RuntimeInterruptResult = {
          interrupted: await options.service.interrupt(route.sessionId, reason),
        };
        return json(result);
      }

      if (route.name === "archive") {
        await requireSession(options.store, route.sessionId);
        await options.service.assertSessionTurnAllowed(route.sessionId);
        await options.service.archiveSession(route.sessionId);
        return new Response(null, { status: 204 });
      }

      if (route.name === "listUserInputs") {
        if (!options.userInputs) return jsonError(501, "No user input controller is configured");
        rejectUnknownQueryParameters(url, ["sessionId"]);
        const sessionId = asSessionId(url.searchParams.get("sessionId"));
        return json(await options.userInputs.list(sessionId ? { sessionId } : {}));
      }

      if (route.name === "listPendingApprovals") {
        rejectUnknownQueryParameters(url, ["sessionId", "window"]);
        const sessionId = asSessionId(url.searchParams.get("sessionId"));
        const window = await boundedPendingApprovalWindow(options.store, sessionId);
        if (url.searchParams.get("window") === "bounded") return json(window);
        return json(window.approvals, 200, {
          "x-chili-approval-window-truncated": String(window.truncated),
          "x-chili-approval-window-bytes": String(window.bytes),
        });
      }

      if (route.name === "resolveUserInput") {
        if (!options.userInputs) return jsonError(501, "No user input controller is configured");
        const inputId = requestUserInputId(route.inputId);
        const answers = parseResolveUserInputBody(await readJson<unknown>(request));
        const pending = (await options.userInputs.list()).find((candidate) => candidate.id === inputId);
        if (!pending) return jsonError(404, `User input request not found: ${inputId}`);
        let validatedAnswers: UserInputAnswers;
        try {
          validatedAnswers = parseUserInputAnswers(answers, pending.questions);
        } catch (error) {
          throw badRequest(error instanceof Error ? error.message : String(error));
        }
        const resolved = await options.userInputs.resolve({ inputId, answers: validatedAnswers });
        if (!resolved) {
          return jsonError(409, "User input request is no longer pending. It may have been handled already or orphaned by a server restart.");
        }
        return json({ resolved: true });
      }

      if (route.name === "resolveApproval") {
        if (!options.approvals) return jsonError(501, "No approval resolver is configured");
        const resolveInput = parseResolveApprovalBody(route.approvalId, await readJson<unknown>(request));
        // A resolver that cannot report the pending request's scope must not be
        // allowed to create reusable grants. Treat the extension boundary as
        // one-shot by default and fail closed before resolve() can persist state.
        const maxApprovalScope = options.approvals.maxApprovalScope
          ? await options.approvals.maxApprovalScope(route.approvalId)
          : "once";
        if (!approvalDecisionWithinScope(resolveInput.decision, maxApprovalScope)) {
          return jsonError(400, `Approval decision ${resolveInput.decision} exceeds the maximum approval scope ${maxApprovalScope}.`);
        }
        const resolved = await options.approvals.resolve(resolveInput);
        if (!resolved) {
          return jsonError(409, "Approval is not pending in this runtime. It may have been handled already or orphaned by a server restart.");
        }
        const result: RuntimeApprovalResolveResult = { resolved };
        return json(result);
      }

      if (route.name === "events") {
        rejectUnknownQueryParameters(url, ["sessionId", "afterEventId"]);
        const streamOptions: EventStreamOptions = {
          store: options.store,
          request,
          maxBacklogEvents,
          maxDurableEvents: maxEventStreamDurableEvents,
          maxAgeMs: maxEventStreamAgeMs,
        };
        const sessionId = asSessionId(url.searchParams.get("sessionId"));
        const afterEventId = url.searchParams.get("afterEventId");
        if (sessionId) streamOptions.sessionId = sessionId;
        if (afterEventId) streamOptions.afterEventId = afterEventId;
        return await eventStream(streamOptions);
      }

      return jsonError(404, "Not found");
    } catch (error) {
      const err = toHttpError(error);
      return jsonError(err.status, err.message);
    }
  };
}

function isUnsafeHttpMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function startRuntimeHttpServer(options: StartRuntimeHttpServerOptions): RuntimeHttpServer {
  assertRuntimeHttpServerAuthentication(options.hostname, options.authToken, options.tls);
  const handler = createRuntimeHttpHandler(options);
  const protectLoopbackHost = isLoopbackBindHostname(options.hostname ?? "127.0.0.1");
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: options.idleTimeout ?? 255,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    fetch(request, listener) {
      if (protectLoopbackHost && (listener.port === undefined || !isTrustedLoopbackHostAuthority(
        request.headers.get("host"),
        listener.port,
        options.tls !== undefined,
      ))) {
        return jsonError(421, "Misdirected request");
      }
      return handler(request);
    },
  });

  return {
    url: server.url.href,
    close: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Remote binds expose task execution and filesystem-affecting controls. Keep
 * loopback development compatible, but require a high-entropy bearer secret
 * and an explicit certificate/private-key pair before Bun opens any other
 * interface.
 */
export function assertRuntimeHttpServerAuthentication(
  hostname: string | undefined,
  authToken: string | undefined,
  tls?: Bun.TLSOptions | Bun.TLSOptions[],
): void {
  const effectiveHostname = hostname === undefined ? "127.0.0.1" : hostname;
  if (isLoopbackBindHostname(effectiveHostname)) return;
  const tokenBytes = typeof authToken === "string"
    ? new TextEncoder().encode(authToken).byteLength
    : 0;
  if (tokenBytes < RUNTIME_HTTP_MINIMUM_REMOTE_AUTH_TOKEN_BYTES) {
    throw new Error(
      `Refusing to bind runtime HTTP server to non-loopback host ${JSON.stringify(diagnosticHostname(effectiveHostname))} without an authToken of at least ${RUNTIME_HTTP_MINIMUM_REMOTE_AUTH_TOKEN_BYTES} UTF-8 bytes`,
    );
  }
  if (!hasExplicitTlsCredentials(tls)) {
    throw new Error(
      `Refusing to bind runtime HTTP server to non-loopback host ${JSON.stringify(diagnosticHostname(effectiveHostname))} without explicit TLS cert and key`,
    );
  }
}

export function isLoopbackBindHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (unbracketed === "localhost" || unbracketed.endsWith(".localhost")) return true;
  if (unbracketed === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(unbracketed);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function isTrustedLoopbackHostAuthority(
  authority: string | null,
  listenerPort: number,
  tls: boolean,
): boolean {
  if (!authority || authority.length > 512 || /[\u0000-\u0020\u007f]/u.test(authority)) return false;

  let hostname: string;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:]+)\](?::([0-9]+))?$/u.exec(authority);
    if (!match || !isIpv6LoopbackLiteral(match[1] ?? "")) return false;
    hostname = match[1] ?? "";
    port = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/u.exec(authority);
    if (!match) return false;
    hostname = match[1] ?? "";
    port = match[2];
    if (!isCanonicalIpv4Loopback(hostname) && !isLocalhostDnsName(hostname)) return false;
  }

  if (!hostname) return false;
  if (port === undefined) return listenerPort === (tls ? 443 : 80);
  if (!/^[1-9][0-9]{0,4}$/u.test(port)) return false;
  const numericPort = Number(port);
  return numericPort <= 65_535 && numericPort === listenerPort;
}

function isCanonicalIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const values: number[] = [];
  for (const octet of octets) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(octet)) return false;
    const value = Number(octet);
    if (value > 255) return false;
    values.push(value);
  }
  return values[0] === 127;
}

function isLocalhostDnsName(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.length > 253 || (normalized !== "localhost" && !normalized.endsWith(".localhost"))) return false;
  return normalized.split(".").every((label) => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}

function isIpv6LoopbackLiteral(hostname: string): boolean {
  const halves = hostname.split("::");
  if (halves.length > 2) return false;
  const left = ipv6Hextets(halves[0] ?? "");
  const right = halves.length === 2 ? ipv6Hextets(halves[1] ?? "") : [];
  if (!left || !right) return false;

  let hextets: number[];
  if (halves.length === 1) {
    if (left.length !== 8) return false;
    hextets = left;
  } else {
    const omitted = 8 - left.length - right.length;
    if (omitted < 1) return false;
    hextets = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  }
  return hextets.length === 8 && hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
}

function ipv6Hextets(value: string): number[] | undefined {
  if (!value) return [];
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9A-Fa-f]{1,4}$/u.test(part))) return undefined;
  return parts.map((part) => Number.parseInt(part, 16));
}

type Route =
  | { name: "health" }
  | { name: "events" }
  | { name: "agents"; sessionId?: SessionId }
  | { name: "listSessions" }
  | { name: "listTasks" }
  | { name: "tasksReconcileStale" }
  | { name: "models" }
  | { name: "permissionsConfig" }
  | { name: "setPermissions" }
  | { name: "commands"; sessionId?: SessionId }
  | { name: "commandsReload"; sessionId?: SessionId }
  | { name: "mcpList" }
  | { name: "mcpStatus" }
  | { name: "mcpReload" }
  | { name: "mcpAdd" }
  | { name: "mcpServer"; server: string }
  | { name: "mcpRemove"; server: string }
  | { name: "mcpTools"; server: string }
  | { name: "mcpAuth"; server: string }
  | { name: "mcpLogout"; server: string }
  | { name: "agentTree" }
  | { name: "agentRuns" }
  | { name: "mailbox" }
  | { name: "consumeMailbox"; messageId: string }
  | { name: "listTeams" }
  | { name: "createTeam" }
  | { name: "teamReconcileDispatches"; teamId?: TeamId }
  | { name: "teamRunLoop"; teamId: TeamId }
  | { name: "teamMerge"; teamId: TeamId }
  | { name: "teamSnapshot"; teamId: TeamId }
  | { name: "teamMembers"; teamId: TeamId }
  | { name: "teamAddMember"; teamId: TeamId }
  | { name: "teamTasks"; teamId: TeamId }
  | { name: "teamCreateTask"; teamId: TeamId }
  | { name: "teamAssignTask"; teamId: TeamId; taskId: TaskId }
  | { name: "teamClaimTask"; teamId: TeamId; taskId: TaskId }
  | { name: "teamDispatchTask"; teamId: TeamId; taskId: TaskId }
  | { name: "teamSyncTask"; teamId: TeamId; taskId: TaskId }
  | { name: "teamUpdateTask"; teamId: TeamId; taskId: TaskId }
  | { name: "teamMessages"; teamId: TeamId }
  | { name: "teamSendMessage"; teamId: TeamId }
  | { name: "task"; taskId: TaskId }
  | { name: "taskFollowup"; taskId: TaskId }
  | { name: "taskWait"; taskId: TaskId }
  | { name: "taskClose"; taskId: TaskId }
  | { name: "createSession" }
  | { name: "messages"; sessionId: SessionId }
  | { name: "sessionEvents"; sessionId: SessionId }
  | { name: "renameSession"; sessionId: SessionId }
  | { name: "modelConfig"; sessionId: SessionId }
  | { name: "setModel"; sessionId: SessionId }
  | { name: "setReasoning"; sessionId: SessionId }
  | { name: "setServiceTier"; sessionId: SessionId }
  | { name: "delegationConfig"; sessionId: SessionId }
  | { name: "setDelegationPolicy"; sessionId: SessionId }
  | { name: "goal"; sessionId: SessionId }
  | { name: "prompt"; sessionId: SessionId }
  | { name: "promptAsync"; sessionId: SessionId }
  | { name: "command"; sessionId: SessionId }
  | { name: "commandAsync"; sessionId: SessionId }
  | { name: "interrupt"; sessionId: SessionId }
  | { name: "archive"; sessionId: SessionId }
  | { name: "listUserInputs" }
  | { name: "listPendingApprovals" }
  | { name: "resolveUserInput"; inputId: string }
  | { name: "resolveApproval"; approvalId: import("@chili/protocol").ApprovalId }
  | { name: "notFound" };

interface CreateSessionBody {
  sessionId?: unknown;
  cwd?: unknown;
}

interface RenameSessionBody {
  title?: unknown;
}

interface PromptBody {
  text?: unknown;
  displayText?: unknown;
  images?: unknown;
  skillMentions?: unknown;
  cwd?: unknown;
  maxTurns?: unknown;
  modelSelection?: unknown;
  reasoningLevel?: unknown;
  serviceTier?: unknown;
}

interface CommandPromptBody {
  commandId?: unknown;
  args?: unknown;
  cwd?: unknown;
  modelSelection?: unknown;
  reasoningLevel?: unknown;
  serviceTier?: unknown;
}

interface ModelBody {
  modelSelection?: unknown;
}

interface ReasoningBody {
  reasoningLevel?: unknown;
}

interface ServiceTierBody {
  serviceTier?: unknown;
}

interface DelegationBody {
  policy?: unknown;
}

interface GoalBody {
  objective?: unknown;
  status?: unknown;
  tokenBudget?: unknown;
  replace?: unknown;
}

interface PermissionsBody {
  profile?: unknown;
}

interface ResolveUserInputBody {
  answers?: unknown;
}

interface McpAddBody {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  url?: unknown;
  headers?: unknown;
  description?: unknown;
  enabled?: unknown;
}

interface McpAuthBody {
  callbackUrl?: unknown;
  scopes?: unknown;
}

interface TaskFollowupBody {
  text?: unknown;
  maxTurns?: unknown;
}

interface TaskWaitBody {
  timeoutMs?: unknown;
}

interface TaskCloseBody {
  status?: unknown;
  summary?: unknown;
  error?: unknown;
  interrupt?: unknown;
}

interface TaskReconcileStaleBody {
  parentSessionId?: unknown;
  staleAfterMs?: unknown;
  modes?: unknown;
  limit?: unknown;
  summary?: unknown;
  error?: unknown;
}

interface TeamContextBody {
  sessionId?: unknown;
  teamId?: unknown;
  taskId?: unknown;
}

interface TeamCreateBody extends TeamContextBody {
  name?: unknown;
  leadPath?: unknown;
  description?: unknown;
  leadName?: unknown;
  leadRole?: unknown;
  leadStatus?: unknown;
  leadWriteScope?: unknown;
}

interface TeamMemberBody extends TeamContextBody {
  path?: unknown;
  name?: unknown;
  role?: unknown;
  status?: unknown;
  childSessionId?: unknown;
  model?: unknown;
  toolScope?: unknown;
  writeScope?: unknown;
}

interface TeamTaskCreateBody extends TeamContextBody {
  taskId?: unknown;
  title?: unknown;
  description?: unknown;
  createdBy?: unknown;
  ownerPath?: unknown;
  dependsOn?: unknown;
  status?: unknown;
  metadata?: unknown;
}

interface TeamTaskAssignBody extends TeamContextBody {
  ownerPath?: unknown;
  assignedBy?: unknown;
  message?: unknown;
  messageDelivery?: unknown;
  messageSummary?: unknown;
}

interface TeamTaskClaimBody extends TeamContextBody {
  ownerPath?: unknown;
  claimedBy?: unknown;
}

interface TeamTaskDispatchBody extends TeamContextBody {
  ownerPath?: unknown;
  cwd?: unknown;
  mode?: unknown;
  prompt?: unknown;
}

interface TeamTaskReconcileBody extends TeamContextBody {
  limit?: unknown;
}

interface TeamRunLoopBody extends TeamContextBody {
  cwd?: unknown;
  mode?: unknown;
  once?: unknown;
  maxCycles?: unknown;
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
}

interface TeamMergeBody extends TeamContextBody {
  taskId?: unknown;
  cwd?: unknown;
}

interface TeamTaskUpdateBody extends TeamContextBody {
  status?: unknown;
  ownerPath?: unknown;
  title?: unknown;
  description?: unknown;
  dependsOn?: unknown;
  summary?: unknown;
  error?: unknown;
  metadata?: unknown;
}

interface TeamMessageBody extends TeamContextBody {
  messageId?: unknown;
  from?: unknown;
  to?: unknown;
  content?: unknown;
  kind?: unknown;
  delivery?: unknown;
  taskId?: unknown;
  summary?: unknown;
  metadata?: unknown;
}

interface InterruptBody {
  reason?: unknown;
}

interface SessionEventWindowLimits {
  maxBytes: number;
  maxScanPages: number;
  maxScanEvents: number;
  maxScanBytes: number;
  maxScanMs: number;
}

interface SessionEventWindowBuildInput {
  store: EventStore & EventPublisher;
  sessionId: SessionId;
  limit: number;
  limits: SessionEventWindowLimits;
  pendingInputs: readonly PendingUserInputRequest[];
}

interface SessionEventHistoryScanState {
  pages: number;
  events: number;
  bytes: number;
  startedAt: number;
  boundary?: "pages" | "events" | "bytes" | "time" | "candidate_bytes";
}

interface ScannedDependencyEvent {
  event: ChiliEvent;
  discoveryOrder: number;
}

interface EventStreamOptions {
  store: EventStore & EventPublisher;
  request: Request;
  sessionId?: SessionId;
  afterEventId?: string;
  maxBacklogEvents: number;
  maxDurableEvents: number;
  maxAgeMs: number;
}

interface HttpError {
  status: number;
  message: string;
}

function routeRequest(method: string, pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (method === "GET" && path === "/health") return { name: "health" };
  if (method === "GET" && path === "/events") return { name: "events" };
  if (method === "GET" && path === "/agents") return { name: "agents" };
  if (method === "GET" && path === "/agents/tree") return { name: "agentTree" };
  if (method === "GET" && path === "/agent_runs") return { name: "agentRuns" };
  if (method === "GET" && path === "/mailbox") return { name: "mailbox" };
  if (method === "GET" && path === "/teams") return { name: "listTeams" };
  if (method === "POST" && path === "/teams") return { name: "createTeam" };
  if (method === "POST" && path === "/teams/reconcile_dispatches") return { name: "teamReconcileDispatches" };
  if (method === "GET" && path === "/sessions") return { name: "listSessions" };
  if (method === "GET" && path === "/user-inputs") return { name: "listUserInputs" };
  if (method === "GET" && path === "/approvals") return { name: "listPendingApprovals" };
  if (method === "GET" && path === "/models") return { name: "models" };
  if (method === "GET" && path === "/commands") return { name: "commands" };
  if (method === "POST" && path === "/commands/reload") return { name: "commandsReload" };
  if (method === "GET" && path === "/mcp") return { name: "mcpList" };
  if (method === "POST" && path === "/mcp") return { name: "mcpAdd" };
  if (method === "GET" && path === "/mcp/status") return { name: "mcpStatus" };
  if (method === "POST" && path === "/mcp/reload") return { name: "mcpReload" };
  if (method === "GET" && path === "/tasks") return { name: "listTasks" };
  if (method === "POST" && path === "/tasks/reconcile_stale") return { name: "tasksReconcileStale" };
  if (method === "POST" && path === "/sessions") return { name: "createSession" };

  const mcpRoute = /^\/mcp\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (mcpRoute) {
    const server = decodeURIComponent(mcpRoute[1] ?? "");
    const action = mcpRoute[2];
    if (method === "GET" && !action) return { name: "mcpServer", server };
    if (method === "DELETE" && !action) return { name: "mcpRemove", server };
    if (method === "GET" && action === "tools") return { name: "mcpTools", server };
    if (method === "POST" && action === "auth") return { name: "mcpAuth", server };
    if (method === "POST" && action === "logout") return { name: "mcpLogout", server };
    return { name: "notFound" };
  }

  const mailboxRoute = /^\/mailbox\/([^/]+)\/consume$/.exec(path);
  if (method === "POST" && mailboxRoute) {
    return { name: "consumeMailbox", messageId: decodeURIComponent(mailboxRoute[1] ?? "") };
  }

  const approvalRoute = /^\/approvals\/([^/]+)\/resolve$/.exec(path);
  if (method === "POST" && approvalRoute) {
    return {
      name: "resolveApproval",
      approvalId: decodeURIComponent(approvalRoute[1] ?? "") as import("@chili/protocol").ApprovalId,
    };
  }

  const userInputRoute = /^\/user-inputs\/([^/]+)\/resolve$/.exec(path);
  if (method === "POST" && userInputRoute) {
    return { name: "resolveUserInput", inputId: decodeURIComponent(userInputRoute[1] ?? "") };
  }

  const teamRoute = /^\/teams\/([^/]+)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(path);
  if (teamRoute) {
    const teamId = decodeURIComponent(teamRoute[1] ?? "") as TeamId;
    const resource = teamRoute[2];
    const resourceId = teamRoute[3];
    const action = teamRoute[4];
    if (resource === "snapshot" && method === "GET" && !resourceId) return { name: "teamSnapshot", teamId };
    if (resource === "members") {
      if (method === "GET" && !resourceId) return { name: "teamMembers", teamId };
      if (method === "POST" && !resourceId) return { name: "teamAddMember", teamId };
    }
    if (resource === "reconcile_dispatches" && method === "POST" && !resourceId) {
      return { name: "teamReconcileDispatches", teamId };
    }
    if ((resource === "run_loop" || resource === "run-loop") && method === "POST" && !resourceId) {
      return { name: "teamRunLoop", teamId };
    }
    if (resource === "merge" && method === "POST" && !resourceId) {
      return { name: "teamMerge", teamId };
    }
    if (resource === "tasks") {
      if (method === "GET" && !resourceId) return { name: "teamTasks", teamId };
      if (method === "POST" && !resourceId) return { name: "teamCreateTask", teamId };
      const taskId = resourceId ? (decodeURIComponent(resourceId) as TaskId) : undefined;
      if (taskId && method === "POST" && action === "assign") return { name: "teamAssignTask", teamId, taskId };
      if (taskId && method === "POST" && action === "claim") return { name: "teamClaimTask", teamId, taskId };
      if (taskId && method === "POST" && action === "dispatch") return { name: "teamDispatchTask", teamId, taskId };
      if (taskId && method === "POST" && action === "sync") return { name: "teamSyncTask", teamId, taskId };
      if (taskId && method === "POST" && action === "update") return { name: "teamUpdateTask", teamId, taskId };
    }
    if (resource === "messages") {
      if (method === "GET" && !resourceId) return { name: "teamMessages", teamId };
      if (method === "POST" && !resourceId) return { name: "teamSendMessage", teamId };
    }
    return { name: "notFound" };
  }

  const taskRoute = /^\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (taskRoute) {
    const taskId = decodeURIComponent(taskRoute[1] ?? "") as TaskId;
    const action = taskRoute[2];
    if (method === "GET" && !action) return { name: "task", taskId };
    if (method === "POST" && action === "followup") return { name: "taskFollowup", taskId };
    if (method === "POST" && action === "wait") return { name: "taskWait", taskId };
    if (method === "POST" && action === "close") return { name: "taskClose", taskId };
    return { name: "notFound" };
  }

  if (path === "/permissions") {
    if (method === "GET") return { name: "permissionsConfig" };
    if (method === "POST") return { name: "setPermissions" };
    return { name: "notFound" };
  }

  const sessionCommandsRoute = /^\/sessions\/([^/]+)\/commands(?:\/(reload))?$/.exec(path);
  if (sessionCommandsRoute) {
    const sessionId = requestSessionId(decodeURIComponent(sessionCommandsRoute[1] ?? ""));
    const action = sessionCommandsRoute[2];
    if (method === "GET" && !action) return { name: "commands", sessionId };
    if (method === "POST" && action === "reload") return { name: "commandsReload", sessionId };
    return { name: "notFound" };
  }

  const sessionRoute = /^\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
  if (!sessionRoute) return { name: "notFound" };

  const sessionId = requestSessionId(decodeURIComponent(sessionRoute[1] ?? ""));
  const action = sessionRoute[2];
  if (method === "GET" && action === "agents") return { name: "agents", sessionId };
  if (method === "GET" && action === "messages") return { name: "messages", sessionId };
  if (method === "GET" && action === "events") return { name: "sessionEvents", sessionId };
  if ((method === "POST" || method === "PATCH") && action === "rename") return { name: "renameSession", sessionId };
  if (method === "GET" && action === "model") return { name: "modelConfig", sessionId };
  if (method === "POST" && action === "model") return { name: "setModel", sessionId };
  if (method === "POST" && action === "reasoning") return { name: "setReasoning", sessionId };
  if (method === "POST" && (action === "service-tier" || action === "service_tier" || action === "fast")) return { name: "setServiceTier", sessionId };
  if (method === "GET" && action === "delegation") return { name: "delegationConfig", sessionId };
  if (method === "POST" && action === "delegation") return { name: "setDelegationPolicy", sessionId };
  if ((method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE") && action === "goal") return { name: "goal", sessionId };
  if (method === "POST" && action === "prompt") return { name: "prompt", sessionId };
  if (method === "POST" && action === "prompt_async") return { name: "promptAsync", sessionId };
  if (method === "POST" && action === "command") return { name: "command", sessionId };
  if (method === "POST" && action === "command_async") return { name: "commandAsync", sessionId };
  if (method === "POST" && action === "interrupt") return { name: "interrupt", sessionId };
  if (method === "POST" && action === "archive") return { name: "archive", sessionId };
  return { name: "notFound" };
}

function buildSubmitPromptInput(sessionId: SessionId, body: PromptBody, parsedImages?: readonly MessageImageContent[]): SubmitPromptInput {
  const input: SubmitPromptInput = {
    sessionId,
    text: body.text === undefined
      ? ""
      : parseRuntimeString(body.text, "body.text", { allowEmpty: true }),
  };
  if (body.displayText !== undefined) {
    input.displayText = parseRuntimeString(body.displayText, "body.displayText", { allowEmpty: true });
  }
  const images = parsedImages ?? parsePromptImages(body.images);
  if (images.length > 0) input.images = images;
  if (typeof body.cwd === "string" && body.cwd.trim().length > 0) input.cwd = body.cwd;
  const skillMentions = parseSkillMentions(body.skillMentions);
  if (skillMentions.length > 0) input.skillMentions = skillMentions;
  if (body.maxTurns !== undefined) input.maxTurns = positiveInteger(body.maxTurns, "maxTurns");
  if (body.modelSelection !== undefined) {
    input.modelSelection = parseRuntimeModelSelection(body.modelSelection, "body.modelSelection");
  }
  if (body.reasoningLevel !== undefined) {
    if (!isReasoningLevel(body.reasoningLevel)) {
      throw badRequest("reasoningLevel must be off, minimal, low, medium, high, xhigh, max, or ultra");
    }
    input.reasoningLevel = body.reasoningLevel;
  }
  if (body.serviceTier !== undefined) {
    if (!isServiceTier(body.serviceTier)) throw badRequest("serviceTier must be standard or fast");
    input.serviceTier = body.serviceTier;
  }
  return input;
}

function goalSetInput(sessionId: SessionId, body: GoalBody): {
  sessionId: SessionId;
  objective: string;
  tokenBudget?: number;
  replace?: boolean;
} {
  if (typeof body.objective !== "string" || body.objective.trim().length === 0) {
    throw badRequest("objective is required");
  }
  const input: {
    sessionId: SessionId;
    objective: string;
    tokenBudget?: number;
    replace?: boolean;
  } = {
    sessionId,
    objective: body.objective.trim(),
  };
  const tokenBudget = optionalPositiveInteger(body.tokenBudget, "tokenBudget");
  if (tokenBudget !== undefined) input.tokenBudget = tokenBudget;
  if (body.replace !== undefined) input.replace = parseRuntimeBoolean(body.replace, "body.replace");
  return input;
}

function goalUpdateInput(sessionId: SessionId, body: GoalBody): {
  sessionId: SessionId;
  status?: SessionGoalStatus;
  objective?: string;
  tokenBudget?: number;
} {
  const input: {
    sessionId: SessionId;
    status?: SessionGoalStatus;
    objective?: string;
    tokenBudget?: number;
  } = {
    sessionId,
  };
  const status = optionalGoalStatus(body.status);
  if (status) input.status = status;
  if (body.objective !== undefined) {
    if (typeof body.objective !== "string" || body.objective.trim().length === 0) {
      throw badRequest("objective must be a non-empty string when provided");
    }
    input.objective = body.objective.trim();
  }
  const tokenBudget = optionalPositiveInteger(body.tokenBudget, "tokenBudget");
  if (tokenBudget !== undefined) input.tokenBudget = tokenBudget;
  if (!input.status && input.objective === undefined && input.tokenBudget === undefined) {
    throw badRequest("status, objective, or tokenBudget is required");
  }
  return input;
}

function optionalGoalStatus(value: unknown): SessionGoalStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "paused" || value === "budgetLimited" || value === "complete") return value;
  throw badRequest("status must be active, paused, budgetLimited, or complete");
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function stringField(value: unknown, field: string): string {
  const text = parseRuntimeString(value, `body.${field}`);
  if (text.trim().length === 0) throw badRequest(`${field} must be a non-empty string`);
  return text.trim();
}

function stringArrayField(value: unknown, field: string): string[] {
  return parseRuntimeStringArray(value, `body.${field}`);
}

function stringRecordField(value: unknown, field: string): Record<string, string> {
  return parseRuntimeStringRecord(value, `body.${field}`);
}

function parseSkillMentions(value: unknown): RuntimeSkillMention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest("skillMentions must be an array");
  const mentions: RuntimeSkillMention[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name.trim().length === 0) {
      throw badRequest("skillMentions entries require a non-empty name");
    }
    const mention: RuntimeSkillMention = { name: item.name.trim() };
    if (item.path !== undefined) {
      if (typeof item.path !== "string" || item.path.trim().length === 0) {
        throw badRequest("skillMentions path must be a non-empty string when provided");
      }
      mention.path = item.path;
    }
    mentions.push(mention);
  }
  return mentions;
}

function parsePromptImages(value: unknown): MessageImageContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest("images must be an array");
  const images: MessageImageContent[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw badRequest("images entries must be objects");
    if (typeof item.data !== "string" || item.data.length === 0) {
      throw badRequest("images entries require non-empty base64 data");
    }
    if (typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/")) {
      throw badRequest("images entries require an image mimeType");
    }
    const image: MessageImageContent = {
      data: item.data,
      mimeType: item.mimeType,
    };
    if (item.filename !== undefined) {
      if (typeof item.filename !== "string" || item.filename.trim().length === 0) {
        throw badRequest("images filename must be a non-empty string when provided");
      }
      image.filename = item.filename;
    }
    if (item.sourcePath !== undefined) {
      if (typeof item.sourcePath !== "string" || item.sourcePath.trim().length === 0) {
        throw badRequest("images sourcePath must be a non-empty string when provided");
      }
      image.sourcePath = item.sourcePath;
    }
    images.push(image);
  }
  return images;
}

function parseResolveApprovalBody(approvalId: import("@chili/protocol").ApprovalId, body: unknown): {
  approvalId: import("@chili/protocol").ApprovalId;
  decision: ApprovalDecisionAction;
  feedback?: string;
} {
  if (!isRecord(body)) throw badRequest("JSON object body is required");
  const unknownKeys = Object.keys(body).filter((key) => key !== "decision" && key !== "feedback");
  if (unknownKeys.length > 0) throw badRequest(`Unexpected field: ${unknownKeys[0]}`);
  if (body.decision === undefined) throw badRequest("decision is required");
  if (!isApprovalDecisionAction(body.decision)) throw badRequest("decision must be one of allow_once, allow_session, allow_always, deny");

  const input: {
    approvalId: import("@chili/protocol").ApprovalId;
    decision: ApprovalDecisionAction;
    feedback?: string;
  } = {
    approvalId,
    decision: body.decision,
  };
  if (body.feedback !== undefined) {
    if (typeof body.feedback !== "string") throw badRequest("feedback must be a string");
    input.feedback = body.feedback;
  }
  return input;
}

function parseResolveUserInputBody(body: unknown): UserInputAnswers {
  if (!isRecord(body) || Array.isArray(body)) throw badRequest("JSON object body is required");
  const typed = body as ResolveUserInputBody & Record<string, unknown>;
  const unknownKeys = Object.keys(typed).filter((key) => key !== "answers");
  if (unknownKeys.length > 0) throw badRequest(`Unexpected field: ${unknownKeys[0]}`);
  if (typed.answers === undefined) throw badRequest("answers is required");
  try {
    return parseUserInputAnswers(typed.answers);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

function isApprovalDecisionAction(value: unknown): value is ApprovalDecisionAction {
  return value === "allow_once" || value === "allow_session" || value === "allow_always" || value === "deny";
}

function approvalDecisionWithinScope(
  decision: ApprovalDecisionAction,
  maxApprovalScope: import("@chili/protocol").ApprovalScope | undefined,
): boolean {
  if (decision === "deny" || decision === "allow_once") return true;
  if (decision === "allow_session") return maxApprovalScope !== "once";
  return maxApprovalScope === undefined || maxApprovalScope === "persistent";
}

function rejectLegacySystemField(body: unknown): void {
  if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, "system")) {
    throw badRequest("system is no longer supported in runtime prompt requests");
  }
}

function rejectUnknownQueryParameters(url: URL, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!supported.has(key)) throw badRequest(`Query parameter ${JSON.stringify(key)} is not supported`);
  }
}

async function readAllProjectionEvents(
  store: EventStore,
  sessionId: SessionId | undefined,
  requestedPageSize: number,
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  const pageSize = Math.max(1, Math.trunc(requestedPageSize));
  let afterEventId: string | undefined;

  while (true) {
    const batch = await store.events({
      ...(sessionId ? { sessionId } : {}),
      ...(afterEventId ? { afterEventId } : {}),
      limit: pageSize,
    });
    events.push(...batch);
    if (batch.length < pageSize) return events;
    afterEventId = batch.at(-1)?.id;
    if (!afterEventId) return events;
  }
}

// Persisted events are capped at 512k; seven rows keep a scan page below the
// default 4MB response window before any dependency candidates are retained.
const SESSION_EVENT_WINDOW_PAGE_SIZE = 7;
const SESSION_EVENT_WINDOW_METADATA_RESERVE = 16_384;
const SESSION_EVENT_WINDOW_PIN_LIMIT = 256;
const SESSION_EVENT_WINDOW_ROW_LIMIT = 2_000;
const PENDING_APPROVAL_WINDOW_BYTES = 1_000_000;
const PENDING_APPROVAL_ROW_BYTES = 64_000;

class AsyncAdmissionGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let inheritedSlot = false;
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.concurrency * 8) {
        const error = new Error("Session event window capacity is exhausted");
        error.name = "RuntimeEventWindowCapacityError";
        throw error;
      }
      await new Promise<void>((resolvePromise) => this.waiters.push(resolvePromise));
      inheritedSlot = true;
    }
    if (!inheritedSlot) this.active += 1;
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

async function boundedPendingApprovalWindow(
  store: EventStore,
  sessionId?: SessionId,
  maxBytes = PENDING_APPROVAL_WINDOW_BYTES,
): Promise<RuntimePendingApprovalWindow> {
  const rows = await store.pendingApprovals(sessionId, SESSION_EVENT_WINDOW_ROW_LIMIT + 1);
  const approvals: RuntimePendingApprovalRequest[] = [];
  let bytes = 2;
  let truncated = rows.length > SESSION_EVENT_WINDOW_ROW_LIMIT;
  for (const row of rows.slice(0, SESSION_EVENT_WINDOW_ROW_LIMIT)) {
    const safe = safePendingApproval(row, sessionId);
    if (!safe) {
      truncated = true;
      continue;
    }
    const approval = safe.approval;
    truncated ||= safe.sanitized;
    const rowBytes = utf8Bytes(JSON.stringify(approval));
    const extra = rowBytes + (approvals.length > 0 ? 1 : 0);
    if (rowBytes > PENDING_APPROVAL_ROW_BYTES || bytes + extra > maxBytes) {
      truncated = true;
      break;
    }
    approvals.push(approval);
    bytes += extra;
  }
  return {
    approvals,
    truncated,
    bytes,
    ...(truncated ? { warning: "Pending approvals exceeded their validated count or UTF-8 byte budget." } : {}),
  };
}

function safePendingApproval(
  value: unknown,
  requestedSessionId?: SessionId,
): { approval: RuntimePendingApprovalRequest; sanitized: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedIdentifierText(value.id, 256);
  const permission = boundedPlainText(value.permission, 512);
  const sessionId = value.sessionId === undefined ? undefined : boundedIdentifierText(value.sessionId, 256);
  const callId = value.callId === undefined ? undefined : boundedIdentifierText(value.callId, 256);
  if (!id || !permission || (requestedSessionId && sessionId !== requestedSessionId)) return undefined;
  let sanitized = (value.sessionId !== undefined && !sessionId) || (value.callId !== undefined && !callId);
  if (!Array.isArray(value.patterns) || value.patterns.length > 64) return undefined;
  const patterns = value.patterns.map((pattern) => boundedPlainText(pattern, 2_000));
  if (patterns.some((pattern) => pattern === undefined)) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  const approval: RuntimePendingApprovalRequest = {
    id,
    permission,
    patterns: patterns as string[],
    createdAt: value.createdAt,
  };
  if (sessionId) approval.sessionId = sessionId as SessionId;
  if (callId) approval.callId = callId;
  if (value.maxApprovalScope === "once" || value.maxApprovalScope === "session" || value.maxApprovalScope === "persistent") {
    approval.maxApprovalScope = value.maxApprovalScope;
  } else if (value.maxApprovalScope !== undefined) {
    sanitized = true;
  }
  if (isRecord(value.metadata)) {
    try {
      if (utf8Bytes(JSON.stringify(value.metadata)) <= 16_000) approval.metadata = value.metadata;
      else sanitized = true;
    } catch {
      sanitized = true;
    }
  } else if (value.metadata !== undefined) {
    sanitized = true;
  }
  return { approval, sanitized };
}

function boundedPlainText(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars ? value : undefined;
}

function boundedIdentifierText(value: unknown, maxChars: number): string | undefined {
  const text = boundedPlainText(value, maxChars);
  if (!text || /[\u0000-\u001f\u007f]/u.test(text)) return undefined;
  if (text === "__proto__" || text === "prototype" || text === "constructor") return undefined;
  return text;
}

async function replayableSessionEventWindow(
  input: SessionEventWindowBuildInput,
): Promise<RuntimeSessionEventWindow> {
  const warnings = new Set<string>();
  const tail = await boundedSessionEventTail(input);
  if (tail.truncated) warnings.add("durable event tail exceeded its count or byte budget");

  const pendingApprovalWindow = await boundedPendingApprovalWindow(
    input.store,
    input.sessionId,
    Math.max(2, Math.min(PENDING_APPROVAL_WINDOW_BYTES, Math.floor(input.limits.maxBytes / 2))),
  );
  if (pendingApprovalWindow.truncated) warnings.add("pending approvals exceeded their validated snapshot budget");
  if (input.pendingInputs.length > SESSION_EVENT_WINDOW_ROW_LIMIT) {
    warnings.add(`pending inputs exceeded the ${SESSION_EVENT_WINDOW_ROW_LIMIT}-row event-window seed limit`);
  }

  const authoritativePins = new Set<string>();
  const authoritativeDependencyKeys = new Set<string>();
  for (const approval of pendingApprovalWindow.approvals) {
    authoritativeDependencyKeys.add(runtimeEventDependencyKey({ kind: "approval", key: approval.id }));
    if (approval.callId) {
      authoritativeDependencyKeys.add(runtimeEventDependencyKey({ kind: "tool", key: approval.callId }));
    }
  }
  for (const pending of input.pendingInputs.slice(0, SESSION_EVENT_WINDOW_ROW_LIMIT)) {
    if (
      pending.sessionId !== input.sessionId
      || typeof pending.id !== "string"
      || pending.id.length === 0
      || typeof pending.callId !== "string"
      || pending.callId.length === 0
    ) {
      warnings.add("invalid pending input rows were omitted from the event-window seed");
      continue;
    }
    authoritativeDependencyKeys.add(runtimeEventDependencyKey({ kind: "user_input", key: pending.id }));
    authoritativeDependencyKeys.add(runtimeEventDependencyKey({ kind: "tool", key: pending.callId }));
  }

  const candidates = new Map<string, ScannedDependencyEvent>();
  let discoveryOrder = 0;
  let recoveredOrder = -1_000_000_000;
  let candidateBytes = 2;
  const addCandidate = (event: ChiliEvent, explicitOrder?: number): boolean => {
    if (candidates.has(event.id)) return true;
    const bytes = runtimeEventJsonUtf8Bytes(event) + (candidates.size > 0 ? 1 : 0);
    if (candidateBytes + bytes > input.limits.maxBytes * 2) return false;
    candidates.set(event.id, { event, discoveryOrder: explicitOrder ?? discoveryOrder });
    if (explicitOrder === undefined) discoveryOrder += 1;
    candidateBytes += bytes;
    return true;
  };

  const created = await input.store.events({
    sessionId: input.sessionId,
    type: "session.created",
    limit: 1,
  }) as ChiliEvent[];
  for (const event of created) {
    if (!addCandidate(event, -2_000_000_000)) warnings.add("session event dependency candidates exceeded their byte budget");
  }
  for (const event of tail.events) {
    if (!addCandidate(event)) {
      warnings.add("session event dependency candidates exceeded their byte budget");
      break;
    }
  }

  const scanState: SessionEventHistoryScanState = {
    pages: 0,
    events: 0,
    bytes: 0,
    startedAt: Date.now(),
  };
  while (true) {
    const providers = providerKeys(candidates.values());
    const unresolved = new Set(authoritativeDependencyKeys);
    for (const candidate of candidates.values()) {
      for (const required of runtimeEventRequires(candidate.event)) {
        unresolved.add(runtimeEventDependencyKey(required));
      }
    }
    for (const key of providers) unresolved.delete(key);
    if (unresolved.size === 0) break;

    const found = await scanSessionDependencyProviders(input, unresolved, scanState);
    if (found.length === 0) break;
    let added = false;
    for (const row of found) {
      if (!addCandidate(row.event, recoveredOrder)) {
        scanState.boundary = "candidate_bytes";
        break;
      }
      recoveredOrder += 1;
      added = true;
      for (const provided of runtimeEventProvides(row.event)) {
        if (authoritativeDependencyKeys.has(runtimeEventDependencyKey(provided))) {
          authoritativePins.add(row.event.id);
        }
      }
    }
    if (!added || scanState.boundary) break;
  }

  const providers = providerKeys(candidates.values());
  const unresolved = new Set(authoritativeDependencyKeys);
  for (const candidate of candidates.values()) {
    for (const required of runtimeEventRequires(candidate.event)) {
      unresolved.add(runtimeEventDependencyKey(required));
    }
  }
  for (const key of providers) unresolved.delete(key);
  if (unresolved.size > 0) warnings.add(`${unresolved.size} event dependency anchors could not be recovered`);
  if (scanState.boundary) warnings.add(`event dependency scan reached its ${scanState.boundary.replace("_", " ")} limit`);

  const ordered = dependencyOrderedCandidates(candidates);
  const eventBudget = Math.max(
    2,
    input.limits.maxBytes - pendingApprovalWindow.bytes - SESSION_EVENT_WINDOW_METADATA_RESERVE,
  );
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({
    maxEvents: input.limit,
    maxBytes: eventBudget,
    maxSources: 1,
  });
  let retained = accumulator.addSource(ordered, {
    sourceOrder: 0,
    pinnedEventIds: authoritativePins,
  });
  if (retained.missingDependencies.length > 0) {
    warnings.add(`${retained.missingDependencies.length} event groups were dropped without their anchors`);
  }
  if (retained.truncated) warnings.add("session event window exceeded its replay budget");

  let pins = retained.pinnedEventIds.slice(0, SESSION_EVENT_WINDOW_PIN_LIMIT);
  if (pins.length < retained.pinnedEventIds.length) warnings.add("active event pins exceeded their metadata limit");
  let warning = boundedSessionWindowWarning(warnings);
  let window: RuntimeSessionEventWindow = {
    events: retained.events,
    pendingApprovals: pendingApprovalWindow.approvals,
    truncated: tail.truncated || retained.truncated || warnings.size > 0,
    bytes: retained.bytes,
    pinnedEventIds: pins,
    ...(warning ? { warning } : {}),
  };

  for (let attempt = 0; attempt < 3 && utf8Bytes(JSON.stringify(window)) > input.limits.maxBytes; attempt += 1) {
    const overflow = utf8Bytes(JSON.stringify(window)) - input.limits.maxBytes;
    const nextBudget = Math.max(2, eventBudget - overflow - 256 * (attempt + 1));
    retained = new ReplayableRuntimeEventWindowAccumulator({
      maxEvents: input.limit,
      maxBytes: nextBudget,
      maxSources: 1,
    }).addSource(ordered, { sourceOrder: 0, pinnedEventIds: authoritativePins });
    warnings.add("session event response envelope exceeded its byte budget");
    pins = retained.pinnedEventIds.slice(0, SESSION_EVENT_WINDOW_PIN_LIMIT);
    warning = boundedSessionWindowWarning(warnings);
    window = {
      events: retained.events,
      pendingApprovals: pendingApprovalWindow.approvals,
      truncated: true,
      bytes: retained.bytes,
      pinnedEventIds: pins,
      ...(warning ? { warning } : {}),
    };
  }
  if (utf8Bytes(JSON.stringify(window)) > input.limits.maxBytes) {
    return {
      events: [],
      pendingApprovals: pendingApprovalWindow.approvals,
      truncated: true,
      bytes: 2,
      pinnedEventIds: [],
      warning: "Session event response metadata exceeded its byte budget; reload after reducing active controls.",
    };
  }
  return window;
}

async function boundedSessionEventTail(
  input: SessionEventWindowBuildInput,
): Promise<{ events: ChiliEvent[]; truncated: boolean }> {
  const chunks: ChiliEvent[][] = [];
  let count = 0;
  let bytes = 2;
  let beforeEventId: string | undefined;
  let truncated = false;

  while (count < input.limit + 1) {
    const requested = Math.min(SESSION_EVENT_WINDOW_PAGE_SIZE, input.limit + 1 - count);
    const batch = await input.store.events({
      sessionId: input.sessionId,
      limit: requested,
      tail: true,
      ...(beforeEventId ? { beforeEventId } : {}),
    }) as ChiliEvent[];
    if (batch.length === 0) break;
    if (beforeEventId && batch.at(-1)?.id === beforeEventId) {
      truncated = true;
      break;
    }
    const accepted: ChiliEvent[] = [];
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const event = batch[index];
      if (!event) continue;
      const eventBytes = runtimeEventJsonUtf8Bytes(event) + (count > 0 ? 1 : 0);
      if (bytes + eventBytes > input.limits.maxBytes || count >= input.limit + 1) {
        truncated = true;
        break;
      }
      accepted.unshift(event);
      bytes += eventBytes;
      count += 1;
    }
    if (accepted.length > 0) chunks.unshift(accepted);
    if (accepted.length < batch.length || batch.length < requested) break;
    const nextCursor = batch[0]?.id;
    if (!nextCursor || nextCursor === beforeEventId) break;
    beforeEventId = nextCursor;
  }
  const events = chunks.flat();
  if (events.length > input.limit) {
    events.splice(0, events.length - input.limit);
    truncated = true;
  }
  return { events, truncated };
}

async function scanSessionDependencyProviders(
  input: SessionEventWindowBuildInput,
  targets: ReadonlySet<string>,
  state: SessionEventHistoryScanState,
): Promise<ScannedDependencyEvent[]> {
  const found = new Map<string, ScannedDependencyEvent>();
  let afterEventId: string | undefined;
  let discoveryOrder = 0;

  while (found.size < targets.size) {
    if (state.pages >= input.limits.maxScanPages) {
      state.boundary = "pages";
      break;
    }
    if (state.events >= input.limits.maxScanEvents) {
      state.boundary = "events";
      break;
    }
    if (Date.now() - state.startedAt >= input.limits.maxScanMs) {
      state.boundary = "time";
      break;
    }
    const requested = Math.min(
      SESSION_EVENT_WINDOW_PAGE_SIZE,
      input.limits.maxScanEvents - state.events,
    );
    const batch = await input.store.events({
      sessionId: input.sessionId,
      ...(afterEventId ? { afterEventId } : {}),
      limit: requested,
    }) as ChiliEvent[];
    state.pages += 1;
    if (batch.length === 0) break;
    for (const event of batch) {
      const eventBytes = runtimeEventJsonUtf8Bytes(event);
      if (state.bytes + eventBytes > input.limits.maxScanBytes) {
        state.boundary = "bytes";
        break;
      }
      state.events += 1;
      state.bytes += eventBytes;
      for (const provided of runtimeEventProvides(event)) {
        const key = runtimeEventDependencyKey(provided);
        if (targets.has(key) && !found.has(key)) {
          found.set(key, { event, discoveryOrder });
        }
      }
      discoveryOrder += 1;
    }
    if (state.boundary || batch.length < requested) break;
    const nextCursor = batch.at(-1)?.id;
    if (!nextCursor || nextCursor === afterEventId) break;
    afterEventId = nextCursor;
  }
  return [...new Map([...found.values()].map((row) => [row.event.id, row])).values()];
}

function providerKeys(candidates: Iterable<ScannedDependencyEvent>): Set<string> {
  const providers = new Set<string>();
  for (const candidate of candidates) {
    for (const provided of runtimeEventProvides(candidate.event)) {
      providers.add(runtimeEventDependencyKey(provided));
    }
  }
  return providers;
}

function dependencyOrderedCandidates(candidates: ReadonlyMap<string, ScannedDependencyEvent>): ChiliEvent[] {
  const providerByKey = new Map<string, ChiliEvent>();
  for (const candidate of candidates.values()) {
    for (const provided of runtimeEventProvides(candidate.event)) {
      if (!providerByKey.has(runtimeEventDependencyKey(provided))) {
        providerByKey.set(runtimeEventDependencyKey(provided), candidate.event);
      }
    }
  }
  const base = [...candidates.values()].sort((left, right) => left.discoveryOrder - right.discoveryOrder);
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ChiliEvent[] = [];
  const emit = (event: ChiliEvent): void => {
    if (emitted.has(event.id) || visiting.has(event.id)) return;
    visiting.add(event.id);
    for (const required of runtimeEventRequires(event)) {
      const provider = providerByKey.get(runtimeEventDependencyKey(required));
      if (provider) emit(provider);
    }
    visiting.delete(event.id);
    emitted.add(event.id);
    ordered.push(event);
  };
  for (const candidate of base) emit(candidate.event);
  return ordered;
}

function boundedSessionWindowWarning(warnings: ReadonlySet<string>): string | undefined {
  if (warnings.size === 0) return undefined;
  const text = `Session event window truncated: ${[...warnings].join("; ")}.`;
  return text.length <= 2_000 ? text : `${text.slice(0, 1_997)}...`;
}

async function eventStream(options: EventStreamOptions): Promise<Response> {
  const encoder = new TextEncoder();
  const pending: ChiliEvent[] = [];
  const maxBacklogEvents = Math.max(1, Math.trunc(options.maxBacklogEvents));
  const maxDurableEvents = Math.max(1, Math.trunc(options.maxDurableEvents));
  const maxAgeMs = Math.max(1, Math.trunc(options.maxAgeMs));
  // This set is bounded by rotating the connection after maxDurableEvents. A
  // resumed connection never trusts live durable notification order: it pumps
  // committed events after its durable cursor, so an arbitrarily late emit from
  // an older connection cannot move the stream backwards or duplicate an event.
  const seenDurableEventIds = new Set<string>();
  let backlogDone = false;
  let closed = false;
  let durableEventsSent = 0;
  let durableCursor = options.afterEventId;
  let durablePumpRunning = false;
  let durablePumpRequested = false;
  let rotationDue = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let rotationTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closeController: (() => void) | undefined;
  let sendEvent: ((event: ChiliEvent) => void) | undefined;
  let requestDurablePump: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = undefined;
    closeController?.();
  };

  type BacklogQuery = {
    sessionId?: SessionId;
    afterEventId?: string;
    limit: number;
    tail: boolean;
  };
  const query = (input: { afterEventId?: string; limit: number; tail: boolean }): BacklogQuery => ({
    ...input,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });

  unsubscribe = options.store.subscribe((event) => {
    if (!matchesEvent(event, options)) return;
    if (backlogDone) {
      if (isTransientEvent(event)) sendEvent?.(event);
      else requestDurablePump?.();
    } else {
      pending.push(event);
    }
  });
  options.request.signal.addEventListener("abort", cleanup, { once: true });

  let backlog: ChiliEvent[];
  try {
    if (options.afterEventId) {
      const resumed = await options.store.events(query({
        afterEventId: options.afterEventId,
        limit: maxBacklogEvents + 1,
        tail: false,
      }));
      if (resumed.length > maxBacklogEvents) {
        throw {
          status: 409,
          message: `Event backlog exceeds the ${maxBacklogEvents}-event replay limit. Reconnect without afterEventId to resync from the latest events.`,
        } satisfies HttpError;
      }
      backlog = resumed as ChiliEvent[];
    } else {
      backlog = await options.store.events(query({
        limit: maxBacklogEvents,
        tail: true,
      })) as ChiliEvent[];
    }
  } catch (error) {
    cleanup();
    if (error instanceof UnknownEventCursorError) {
      throw {
        status: 409,
        message: `Unknown event cursor ${JSON.stringify(error.eventId)}. Reconnect without afterEventId to resync from the latest events.`,
      } satisfies HttpError;
    }
    throw error;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ChiliEvent): void => {
        if (closed || !matchesEvent(event, options)) return;
        const durable = !isTransientEvent(event);
        if (durable && seenDurableEventIds.has(event.id)) return;
        try {
          controller.enqueue(formatSse(event));
          if (durable) {
            seenDurableEventIds.add(event.id);
            durableCursor = event.id;
            durableEventsSent += 1;
            if (durableEventsSent >= maxDurableEvents || rotationDue) cleanup();
          }
        } catch (error) {
          // Legacy/corrupt stores may predate today's producer limits. Advance
          // only through the exact persisted poison row, tell the SDK to force
          // an authoritative snapshot, then rotate. No synthetic ChiliEvent is
          // allowed into the projection and reconnect cannot loop forever.
          if (durable && isRuntimeEventTransportLimitError(error)) {
            try {
              controller.enqueue(formatSseResync(event));
              seenDurableEventIds.add(event.id);
              durableCursor = event.id;
              durableEventsSent += 1;
            } catch {
              // An invalid legacy cursor that cannot fit the bounded control
              // frame still closes safely without allocating another payload.
            }
          }
          cleanup();
        }
      };
      sendEvent = send;

      const pumpDurableEvents = async (): Promise<void> => {
        while (!closed) {
          const remaining = maxDurableEvents - durableEventsSent;
          if (remaining <= 0) return;
          const limit = Math.min(maxBacklogEvents, remaining);
          const cursorBeforeQuery = durableCursor;
          const batch = await options.store.events(query({
            ...(cursorBeforeQuery ? { afterEventId: cursorBeforeQuery } : {}),
            limit,
            tail: false,
          })) as ChiliEvent[];
          if (closed || batch.length === 0) return;

          let advanced = false;
          for (const event of batch) {
            if (isTransientEvent(event)) continue;
            send(event);
            advanced = true;
            if (closed) return;
          }
          if (!advanced || batch.length < limit) return;
        }
      };

      requestDurablePump = (): void => {
        durablePumpRequested = true;
        if (durablePumpRunning || closed) return;
        durablePumpRunning = true;
        void (async () => {
          try {
            while (durablePumpRequested && !closed) {
              durablePumpRequested = false;
              await pumpDurableEvents();
            }
          } catch {
            // Closing normally lets the client reconnect with the last durable
            // cursor. A rejected cursor then receives the regular 409 resync.
            cleanup();
          } finally {
            durablePumpRunning = false;
            if (durablePumpRequested && !closed) requestDurablePump?.();
          }
        })();
      };

      closeController = (): void => {
        try {
          controller.close();
        } catch {
          // The client may have closed first.
        }
      };

      if (closed) {
        closeController();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          cleanup();
        }
      }, 5_000);
      rotationTimer = setTimeout(() => {
        rotationDue = true;
        // Once a durable cursor exists, closing is a safe replay boundary. If
        // the stream has only transient data, wait for its next durable event.
        if (durableCursor) cleanup();
      }, maxAgeMs);
      rotationTimer.unref?.();

      for (const event of backlog) {
        send(event);
        if (closed) return;
      }
      let pendingDurable = false;
      for (const event of pending) {
        if (isTransientEvent(event)) send(event);
        else pendingDurable = true;
        if (closed) return;
      }
      pending.length = 0;
      backlogDone = true;
      if (pendingDurable) requestDurablePump();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function matchesEvent(event: ChiliEvent, options: EventStreamOptions): boolean {
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  return true;
}

const MAX_SSE_FRAME_BYTES = 4_000_000;
const MAX_SSE_RESYNC_FRAME_BYTES = 4_096;

function formatSse(event: ChiliEvent): Uint8Array {
  const payload = JSON.stringify(event);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const prefix = `${!isTransientEvent(event) ? `id: ${event.id}\n` : ""}event: chili.event\ndata: `;
  const suffix = "\n\n";
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const frameBytes = prefixBytes + payloadBytes + Buffer.byteLength(suffix, "utf8");
  if (frameBytes > MAX_SSE_FRAME_BYTES) {
    const error = new Error(`Runtime event ${event.id} exceeds the ${MAX_SSE_FRAME_BYTES}-byte SSE frame boundary`);
    error.name = "RuntimeEventTransportLimitError";
    throw error;
  }
  const frame = Buffer.allocUnsafe(frameBytes);
  let offset = frame.write(prefix, 0, "utf8");
  offset += frame.write(payload, offset, "utf8");
  frame.write(suffix, offset, "utf8");
  return frame;
}

function formatSseResync(event: ChiliEvent): Uint8Array {
  const payload = JSON.stringify({
    reason: "event_transport_limit",
    afterEventId: event.id,
    message: `Runtime event ${event.id} exceeded the ${MAX_SSE_FRAME_BYTES}-byte transport boundary. An authoritative resync is required.`,
  });
  const frame = `event: chili.resync\ndata: ${payload}\n\n`;
  const bytes = Buffer.byteLength(frame, "utf8");
  if (bytes > MAX_SSE_RESYNC_FRAME_BYTES) {
    const error = new Error("Runtime event resync control frame exceeds its byte boundary");
    error.name = "RuntimeEventTransportLimitError";
    throw error;
  }
  return Buffer.from(frame, "utf8");
}

function isRuntimeEventTransportLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "RuntimeEventTransportLimitError";
}

function serializeSubmitPromptResult(result: SubmitPromptResult): RuntimePromptResult {
  const turns = result.turns.map(serializeTurnResult);
  if (result.status === "completed") {
    const completed: Extract<RuntimePromptResult, { status: "completed" }> = { status: "completed", turns };
    if (result.finishReason) completed.finishReason = normalizeDiagnosticText(result.finishReason);
    return completed;
  }

  const failed: Extract<RuntimePromptResult, { status: "failed" | "cancelled" | "max_turns" }> = {
    status: result.status,
    turns,
  };
  if (result.error) failed.error = serializeError(result.error);
  if (result.finishReason) failed.finishReason = normalizeDiagnosticText(result.finishReason);
  return failed;
}

function serializeTaskFollowupResult(result: AgentTaskFollowupResult): { task: AgentTaskRow; result: RuntimePromptResult } {
  return {
    task: result.task,
    result: serializeSubmitPromptResult(result.result),
  };
}

function serializeTurnResult(result: SubmitPromptResult["turns"][number]): RuntimeTurnResult {
  if (result.status === "completed") {
    const completed: Extract<RuntimeTurnResult, { status: "completed" }> = {
      status: "completed",
      turnId: result.turnId,
      assistantMessageId: result.assistantMessageId,
    };
    if (result.finishReason) completed.finishReason = normalizeDiagnosticText(result.finishReason);
    return completed;
  }

  const failed: Extract<RuntimeTurnResult, { status: "failed" | "cancelled" }> = {
    status: result.status,
    turnId: result.turnId,
    error: serializeError(result.error),
  };
  if (result.assistantMessageId) failed.assistantMessageId = result.assistantMessageId;
  return failed;
}

function serializeError(error: Error): { name: string; message: string } {
  const normalized = normalizePersistedError(error);
  return {
    name: normalized.name,
    message: normalized.message,
  };
}

function normalizeDiagnosticText(value: string): string {
  return normalizePersistedError(new Error(value)).message;
}

async function requireSession(store: EventStore, sessionId: SessionId): Promise<Awaited<ReturnType<EventStore["sessions"]>>[number]> {
  const sessions = await store.sessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw notFound(`Session not found: ${sessionId}`);
  }
  return session;
}

async function mcpScopeFromRequest(
  options: RuntimeHttpHandlerOptions,
  url: URL,
): Promise<RuntimeMcpScopeInput> {
  rejectUnknownQueryParameters(url, ["sessionId"]);
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  if (!sessionId) return {};

  await options.service.assertSessionReadAllowed(sessionId);
  const session = await requireSession(options.store, sessionId);
  return { cwd: await authoritativeRequestCwd(session.cwd, undefined) };
}

async function withMcpMutationScope<T>(
  options: RuntimeHttpHandlerOptions,
  url: URL,
  mutate: (scope: RuntimeMcpScopeInput) => Promise<T>,
): Promise<T> {
  rejectUnknownQueryParameters(url, ["sessionId"]);
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  if (!sessionId) return mutate({});

  return options.service.withSessionOperation(sessionId, async (operation) => {
    await options.service.assertSessionTurnAllowed(sessionId);
    const session = await requireSession(options.store, sessionId);
    const scope = { cwd: await authoritativeRequestCwd(session.cwd, undefined) };
    operation.assertCurrent();
    return mutate(scope);
  });
}

async function authoritativeRequestCwd(sessionCwd: string, requestedCwd: unknown): Promise<string> {
  const workspace = await canonicalWorkspacePath(sessionCwd);
  if (requestedCwd === undefined) return workspace;

  const requestedWorkspace = await requestWorkspaceCwd(requestedCwd);
  if (requestedWorkspace !== workspace) {
    throw {
      status: 409,
      message:
        `Request workspace does not match the session workspace. Expected ${workspace}; received ${requestedWorkspace}. ` +
        "Start a new session to use another workspace.",
    } satisfies HttpError;
  }
  return workspace;
}

async function requestWorkspaceCwd(value: unknown): Promise<string> {
  if (typeof value !== "string") throw badRequest("cwd must be a string when provided");
  if (value.trim().length === 0) throw badRequest("cwd must not be empty");
  if (value.includes("\0")) throw badRequest("cwd must be a valid filesystem path");
  return canonicalWorkspacePath(value);
}

function requestSessionId(value: unknown, field = "sessionId"): SessionId {
  return requestIdentifier<SessionId>(value, field);
}

function requestIdentifier<T extends string = string>(value: unknown, field = "id"): T {
  if (typeof value !== "string") throw badRequest(`${field} must be a string when provided`);
  const identifier = value.trim();
  if (!identifier) throw badRequest(`${field} must not be empty`);
  if (identifier.length > 512) throw badRequest(`${field} must not exceed 512 characters`);
  if (/[\u0000-\u001f\u007f]/u.test(identifier)) throw badRequest(`${field} must be valid text`);
  return identifier as T;
}

function requestAgentPath(value: unknown, field: string): AgentPath {
  const path = requestIdentifier<string>(value, field);
  if (!path.startsWith("/")) throw badRequest(`${field} must be an absolute agent path`);
  return path as AgentPath;
}

function requestIdentifierArray<T extends string>(value: unknown, field: string): T[] {
  return parseRuntimeArray(value, (item, itemPath) => requestIdentifier<T>(item, itemPath), `body.${field}`);
}

function requestUserInputId(value: unknown): UserInputId {
  if (typeof value !== "string") throw badRequest("inputId must be a string");
  const inputId = value.trim();
  if (!inputId) throw badRequest("inputId must not be empty");
  if (inputId.length > 512) throw badRequest("inputId must not exceed 512 characters");
  if (/[\u0000-\u001f\u007f]/u.test(inputId)) throw badRequest("inputId must be valid text");
  return inputId as UserInputId;
}

async function canonicalWorkspacePath(value: string): Promise<string> {
  const absolute = resolve(value);
  const missingSegments: string[] = [];
  let candidate = absolute;

  while (true) {
    try {
      const canonicalBase = await realpath(candidate);
      return resolve(canonicalBase, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const MAX_RUNTIME_HTTP_JSON_BODY_BYTES = 32_000_000;

async function readJson<T>(request: Request, allowedFields?: readonly string[]): Promise<T> {
  const contentType = request.headers.get("content-type");
  if (contentType !== null && !isJsonMediaType(contentType)) {
    throw { status: 415, message: "content-type must be application/json" } satisfies HttpError;
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === "0") return {} as T;
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw badRequest("content-length must be a non-negative integer");
    if (bytes > MAX_RUNTIME_HTTP_JSON_BODY_BYTES) {
      throw { status: 413, message: `JSON body must not exceed ${MAX_RUNTIME_HTTP_JSON_BODY_BYTES} bytes` } satisfies HttpError;
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw badRequest("JSON body could not be read");
  }
  if (utf8Bytes(text) > MAX_RUNTIME_HTTP_JSON_BODY_BYTES) {
    throw { status: 413, message: `JSON body must not exceed ${MAX_RUNTIME_HTTP_JSON_BODY_BYTES} bytes` } satisfies HttpError;
  }
  if (text.trim().length === 0) return {} as T;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw badRequest("JSON body must contain valid JSON");
  }
  const record = parseRuntimeRecord(value, "body");
  if (allowedFields) rejectRuntimeUnknownFields(record, allowedFields, "body");
  return record as T;
}

function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonError(status: number, message: string): Response {
  return json({ error: { message: normalizeDiagnosticText(message) } }, status);
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": "Bearer",
    },
  });
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Event stream limits must be positive finite numbers");
  }
  return Math.trunc(value);
}

function configuredAuthTokenDigest(authToken: unknown): Uint8Array | undefined {
  if (authToken === undefined) return undefined;
  if (typeof authToken !== "string" || authToken.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(authToken)) {
    throw new TypeError("authToken must be a non-empty string when provided");
  }
  return tokenDigest(authToken);
}

function hasValidBearerToken(request: Request, expectedDigest: Uint8Array): boolean {
  const authorization = request.headers.get("authorization");
  const match = authorization ? /^Bearer +(\S+)$/i.exec(authorization) : null;
  const candidateDigest = tokenDigest(match?.[1] ?? "");
  const tokensMatch = timingSafeEqual(expectedDigest, candidateDigest);
  return match !== null && tokensMatch;
}

function tokenDigest(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

function badRequest(message: string): HttpError {
  return { status: 400, message };
}

function notFound(message: string): HttpError {
  return { status: 404, message };
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof RuntimeValidationError) {
    return { status: 400, message: error.message };
  }
  if (isHttpError(error)) {
    return { status: error.status, message: normalizeDiagnosticText(error.message) };
  }
  const rawError = error instanceof Error ? error : new Error(String(error));
  const normalized = normalizePersistedError(rawError);
  const err = {
    name: normalized.name,
    message: normalized.message,
  };
  if (
    err.name === "RuntimeServiceClosedError"
    || err.name === "AgentTaskControlServiceClosedError"
    || err.name === "LocalSubagentManagerClosedError"
    || err.name === "RuntimeEventWindowCapacityError"
  ) {
    return { status: 503, message: err.message };
  }
  if (err.name === "AgentTaskNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentTaskNotRunnableError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "AgentTaskWaitTimeoutError") {
    return { status: 408, message: err.message };
  }
  if (err.name === "AbortError") {
    return { status: 499, message: err.message };
  }
  if (err.name === "AgentMailboxNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentMailboxNotDeliverableError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "AgentMessageRecipientNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentMessageRecipientAmbiguousError" || err.name === "AgentMessageConflictError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "AgentMessageRecipientTerminalError" || err.name === "AgentMessageRecipientMetadataError") {
    return { status: 422, message: err.message };
  }
  if (err.name === "TeamNotFoundError" || err.name === "TeamMemberNotFoundError" || err.name === "TeamTaskNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "TeamAlreadyExistsError" || err.name === "TeamTaskAlreadyExistsError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamTaskClaimError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamTaskDispatchAuthorityError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamSessionAuthorityError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamMemberSessionOwnershipError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamTaskWorkerMutationError") {
    return { status: 403, message: err.message };
  }
  if (err.name === "TeamMessageDeliveryError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamMemberTargetAmbiguousError" || err.name === "TeamMessageConflictError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamMessageSenderUnauthorizedError") {
    return { status: 403, message: err.message };
  }
  if (err.name === "RuntimeBusyError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "RuntimeSubagentSessionAccessError") {
    return { status: 409, message: err.message };
  }
  if (
    err.name === "RuntimeSessionAlreadyExistsError" ||
    err.name === "RuntimeSessionCreationConflictError" ||
    err.name === "RuntimeSessionInactiveError"
  ) {
    return { status: 409, message: err.message };
  }
  if (rawError instanceof RuntimeSessionNotFoundError || err.name === "RuntimeSessionNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "GoalAlreadyExistsError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "GoalNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (rawError instanceof PromptCommandNotFoundError) {
    return { status: 404, message: err.message };
  }
  if (rawError instanceof PromptCommandUsageError) {
    return { status: 400, message: err.message };
  }
  return { status: 500, message: err.message };
}

function diagnosticHostname(hostname: string): string {
  if (hostname.length > 200) return "<unsafe-hostname>";
  if (/^[A-Za-z0-9_*.-]+$/u.test(hostname)) return hostname;
  if (/^\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?\]$/u.test(hostname)) return hostname;
  if (/^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?$/u.test(hostname) && hostname.includes(":")) {
    return hostname;
  }
  return "<unsafe-hostname>";
}

function hasExplicitTlsCredentials(tls: Bun.TLSOptions | Bun.TLSOptions[] | undefined): boolean {
  if (tls === undefined) return false;
  const configurations = Array.isArray(tls) ? tls : [tls];
  return configurations.length > 0 && configurations.every((configuration) => (
    isRecord(configuration) &&
    hasNonEmptyTlsMaterial(configuration.cert) &&
    hasNonEmptyTlsMaterial(configuration.key)
  ));
}

function hasNonEmptyTlsMaterial(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => !Array.isArray(entry) && hasNonEmptyTlsMaterialEntry(entry));
  }
  return hasNonEmptyTlsMaterialEntry(value);
}

function hasNonEmptyTlsMaterialEntry(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (ArrayBuffer.isView(value)) return value.byteLength > 0;
  if (value instanceof ArrayBuffer) return value.byteLength > 0;
  if (value instanceof Blob) return value.size > 0;
  return false;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

function asSessionId(value: string | null, parameterName = "sessionId"): SessionId | undefined {
  if (value === null) return undefined;
  return requestSessionId(value, parameterName);
}

function requireModelControl(options: RuntimeHttpHandlerOptions): Required<Pick<RuntimeHttpService, "listModels" | "getModelConfig" | "setModel" | "setReasoning">> {
  const service = options.service;
  if (!service.listModels || !service.getModelConfig || !service.setModel || !service.setReasoning) {
    throw { status: 501, message: "No model control service is configured" } satisfies HttpError;
  }
  return {
    listModels: service.listModels.bind(service),
    getModelConfig: service.getModelConfig.bind(service),
    setModel: service.setModel.bind(service),
    setReasoning: service.setReasoning.bind(service),
  };
}

function requireServiceTierControl(options: RuntimeHttpHandlerOptions): Required<Pick<RuntimeHttpService, "setServiceTier">> {
  const service = options.service;
  if (!service.setServiceTier) {
    throw { status: 501, message: "No service tier control service is configured" } satisfies HttpError;
  }
  return {
    setServiceTier: service.setServiceTier.bind(service),
  };
}

function requireDelegationControl(options: RuntimeHttpHandlerOptions): Required<Pick<RuntimeHttpService, "getDelegationConfig" | "setDelegationPolicy">> {
  const service = options.service;
  if (!service.getDelegationConfig || !service.setDelegationPolicy) {
    throw { status: 501, message: "No delegation control service is configured" } satisfies HttpError;
  }
  return {
    getDelegationConfig: service.getDelegationConfig.bind(service),
    setDelegationPolicy: service.setDelegationPolicy.bind(service),
  };
}

function requireGoalControl(options: RuntimeHttpHandlerOptions): Required<Pick<RuntimeHttpService, "getGoal" | "setGoal" | "updateGoal" | "clearGoal">> {
  const service = options.service;
  if (!service.getGoal || !service.setGoal || !service.updateGoal || !service.clearGoal) {
    throw { status: 501, message: "No goal control service is configured" } satisfies HttpError;
  }
  return {
    getGoal: service.getGoal.bind(service),
    setGoal: service.setGoal.bind(service),
    updateGoal: service.updateGoal.bind(service),
    clearGoal: service.clearGoal.bind(service),
  };
}

function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value)
    && typeof value.provider === "string"
    && value.provider.trim().length > 0
    && typeof value.model === "string"
    && value.model.trim().length > 0;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultra";
}

function isDelegationPolicy(value: unknown): value is DelegationPolicy {
  return typeof value === "string" && (DELEGATION_POLICIES as readonly string[]).includes(value);
}

function isServiceTier(value: unknown): value is ServiceTier {
  return value === "standard" || value === "fast";
}

function isRuntimePermissionProfileId(value: unknown): value is RuntimePermissionProfileId {
  return typeof value === "string" && RUNTIME_PERMISSION_PROFILE_IDS.includes(value as RuntimePermissionProfileId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireTaskControl(options: RuntimeHttpHandlerOptions): RuntimeTaskControlService {
  if (!options.tasks) throw { status: 501, message: "No task control service is configured" } satisfies HttpError;
  return options.tasks;
}

function requireCommandControl(options: RuntimeHttpHandlerOptions): PromptCommandControl {
  if (!options.commands) throw { status: 501, message: "No command control service is configured" } satisfies HttpError;
  return options.commands;
}

function requireMcpControl(options: RuntimeHttpHandlerOptions): RuntimeMcpControlService {
  if (!options.mcp) throw { status: 501, message: "No MCP control service is configured" } satisfies HttpError;
  return options.mcp;
}

async function mcpServerDescriptor(
  control: RuntimeMcpControlService,
  server: string,
  scope: RuntimeMcpScopeInput = {},
): Promise<RuntimeMcpServerDescriptor> {
  const descriptor = control.get
    ? await control.get(server, scope)
    : (await control.list(scope)).servers.find((candidate) => candidate.name === server);
  if (!descriptor) throw notFound(`MCP server not found: ${server}`);
  return descriptor;
}

function statusFromMcpList(result: RuntimeMcpListResponse): RuntimeMcpStatusResponse {
  return {
    servers: result.servers,
    summary: {
      total: result.servers.length,
      running: result.servers.filter((server) => server.status === "running").length,
      disabled: result.servers.filter((server) => !server.enabled || server.status === "disabled").length,
      authRequired: result.servers.filter((server) => server.status === "auth_required" || (server.auth?.required && !server.auth.authenticated)).length,
      errored: result.servers.filter((server) => server.status === "error").length,
    },
  };
}

function requireAgentTree(options: RuntimeHttpHandlerOptions): RuntimeAgentTreeService {
  if (!options.agents) throw { status: 501, message: "No agent tree service is configured" } satisfies HttpError;
  return options.agents;
}

function requireTeams(options: RuntimeHttpHandlerOptions): RuntimeTeamService {
  if (!options.teams) throw { status: 501, message: "No team service is configured" } satisfies HttpError;
  return options.teams;
}

function requireTeamDispatcher(options: RuntimeHttpHandlerOptions): RuntimeTeamDispatcherService {
  if (!options.teamDispatcher) throw { status: 501, message: "No team dispatcher is configured" } satisfies HttpError;
  return options.teamDispatcher;
}

function requireTeamRunner(options: RuntimeHttpHandlerOptions): RuntimeTeamExecutionRunnerService {
  if (!options.teamRunner) throw { status: 501, message: "No team execution runner is configured" } satisfies HttpError;
  return options.teamRunner;
}

function requireTeamMerger(options: RuntimeHttpHandlerOptions): RuntimeTeamMergeService {
  if (!options.teamMerger) throw { status: 501, message: "No team merge service is configured" } satisfies HttpError;
  return options.teamMerger;
}

async function resolveHttpTeamAuthority(
  options: RuntimeHttpHandlerOptions,
  teamId: TeamId,
  requestedSessionId: SessionId | undefined,
  requestedCwd: string | undefined,
): Promise<{ sessionId: SessionId; cwd: string }> {
  const team = await requireHttpTeam(options, teamId);
  return resolveTeamSessionAuthority({
    team,
    tasks: [],
    ...(requestedSessionId ? { requestedSessionId } : {}),
    ...(requestedCwd !== undefined ? { requestedCwd } : {}),
    resolveSession: (sessionId) => resolveHttpInteractiveSession(options, sessionId),
  });
}

async function requireHttpTeam(options: RuntimeHttpHandlerOptions, teamId: TeamId) {
  const team = (await requireTeams(options).listTeams()).find((candidate) => candidate.id === teamId);
  if (!team) throw { status: 404, message: `Team not found: ${teamId}` } satisfies HttpError;
  return team;
}

async function resolveHttpInteractiveSession(options: RuntimeHttpHandlerOptions, sessionId: SessionId) {
  await options.service.assertSessionTurnAllowed(sessionId);
  const session = await requireSession(options.store, sessionId);
  if (session.status !== "active") throw new Error(`Session ${sessionId} is not active (${session.status})`);
  if (session.source === "subagent") throw new Error(`Session ${sessionId} is reserved for a subagent`);
  return session;
}

async function resolveHttpActiveActorSession(options: RuntimeHttpHandlerOptions, sessionId: SessionId) {
  const session = await requireSession(options.store, sessionId);
  if (session.status !== "active") {
    throw { status: 409, message: `Session ${sessionId} is not active (${session.status})` } satisfies HttpError;
  }
  return session;
}

async function withHttpTeamOwnerMutation<T>(
  options: RuntimeHttpHandlerOptions,
  teamId: TeamId,
  requestedSessionId: SessionId | undefined,
  mutate: (authority: { sessionId: SessionId; cwd: string }) => Promise<T>,
): Promise<T> {
  const authority = await resolveHttpTeamAuthority(options, teamId, requestedSessionId, undefined);
  return options.service.withSessionOperation(authority.sessionId, async (operation) => {
    const current = await resolveHttpTeamAuthority(
      options,
      teamId,
      authority.sessionId,
      undefined,
    );
    operation.assertCurrent();
    return mutate(current);
  });
}

async function assertHttpTeamReconcileAuthority(
  options: RuntimeHttpHandlerOptions,
  input: TeamTaskReconcileInput,
): Promise<void> {
  const teams = input.teamId
    ? [await requireHttpTeam(options, input.teamId)]
    : (await requireTeams(options).listTeams()).filter((team) => team.status === "active");
  for (const team of teams) {
    const authority = await resolveHttpTeamAuthority(options, team.id, input.sessionId, undefined);
    if (input.teamId) input.sessionId = authority.sessionId;
  }
}

function teamContext(body: TeamContextBody): TeamEventContextInput {
  const input: TeamEventContextInput = {};
  if (body.sessionId !== undefined) input.sessionId = requestSessionId(body.sessionId);
  if (body.teamId !== undefined) requestIdentifier<TeamId>(body.teamId, "teamId");
  if (body.taskId !== undefined) requestIdentifier<TaskId>(body.taskId, "taskId");
  return input;
}

interface TeamEventContextInput {
  sessionId?: SessionId;
}

function mcpAddInput(body: McpAddBody): RuntimeMcpAddServerRequest {
  if (typeof body.name !== "string" || body.name.trim().length === 0) throw badRequest("name is required");
  const input: RuntimeMcpAddServerRequest = { name: body.name.trim() };
  const transport = mcpTransport(body.transport);
  if (transport) input.transport = transport;
  if (body.command !== undefined) input.command = stringField(body.command, "command");
  if (body.args !== undefined) input.args = stringArrayField(body.args, "args");
  if (body.env !== undefined) input.env = stringRecordField(body.env, "env");
  if (body.cwd !== undefined) input.cwd = stringField(body.cwd, "cwd");
  if (body.url !== undefined) input.url = stringField(body.url, "url");
  if (body.headers !== undefined) input.headers = stringRecordField(body.headers, "headers");
  if (body.description !== undefined) input.description = stringField(body.description, "description");
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw badRequest("enabled must be a boolean");
    input.enabled = body.enabled;
  }
  return input;
}

function mcpAddCreatesStdioServer(input: RuntimeMcpAddServerRequest): boolean {
  return input.transport === "stdio" || input.command !== undefined;
}

function mcpAuthInput(body: McpAuthBody): RuntimeMcpAuthRequest {
  const input: RuntimeMcpAuthRequest = {};
  if (body.callbackUrl !== undefined) input.callbackUrl = stringField(body.callbackUrl, "callbackUrl");
  if (body.scopes !== undefined) input.scopes = stringArrayField(body.scopes, "scopes");
  return input;
}

function mcpTransport(value: unknown): RuntimeMcpTransport | undefined {
  if (value === undefined) return undefined;
  if (value === "stdio" || value === "http" || value === "sse") return value;
  throw badRequest("transport must be stdio, http, or sse");
}

function teamCreateInput(body: TeamCreateBody): CreateTeamInput {
  const input: CreateTeamInput = {
    ...teamContext(body),
    name: stringField(body.name, "name"),
    leadPath: requestAgentPath(body.leadPath, "leadPath"),
  };
  if (body.teamId !== undefined) input.teamId = requestIdentifier<TeamId>(body.teamId, "teamId");
  if (body.description !== undefined) input.description = stringField(body.description, "description");
  if (body.leadName !== undefined) input.leadName = stringField(body.leadName, "leadName");
  if (body.leadRole !== undefined) input.leadRole = stringField(body.leadRole, "leadRole");
  const leadStatus = teamMemberStatus(body.leadStatus);
  if (leadStatus) input.leadStatus = leadStatus;
  if (body.leadWriteScope !== undefined) input.leadWriteScope = stringArrayField(body.leadWriteScope, "leadWriteScope");
  return input;
}

function teamMemberInput(teamId: TeamId, body: TeamMemberBody): AddTeamMemberInput {
  const input: AddTeamMemberInput = {
    ...teamContext(body),
    teamId,
    path: requestAgentPath(body.path, "path"),
    name: stringField(body.name, "name"),
    role: stringField(body.role, "role"),
  };
  const status = teamMemberStatus(body.status);
  if (status) input.status = status;
  if (body.childSessionId !== undefined) input.childSessionId = requestSessionId(body.childSessionId, "childSessionId");
  if (body.model !== undefined) input.model = stringField(body.model, "model");
  if (body.toolScope !== undefined) input.toolScope = stringArrayField(body.toolScope, "toolScope");
  if (body.writeScope !== undefined) input.writeScope = stringArrayField(body.writeScope, "writeScope");
  return input;
}

function teamTaskCreateInput(teamId: TeamId, body: TeamTaskCreateBody): CreateTeamTaskInput {
  const input: CreateTeamTaskInput = {
    ...teamContext(body),
    teamId,
    title: stringField(body.title, "title"),
  };
  if (body.taskId !== undefined) input.taskId = requestIdentifier<TaskId>(body.taskId, "taskId");
  if (body.description !== undefined) input.description = stringField(body.description, "description");
  if (body.createdBy !== undefined) input.createdBy = requestAgentPath(body.createdBy, "createdBy");
  if (body.ownerPath !== undefined) input.ownerPath = requestAgentPath(body.ownerPath, "ownerPath");
  if (body.dependsOn !== undefined) input.dependsOn = requestIdentifierArray<TaskId>(body.dependsOn, "dependsOn");
  const status = teamTaskStatus(body.status);
  if (status) input.status = status;
  if (body.metadata !== undefined) input.metadata = parseRuntimeRecord(body.metadata, "body.metadata");
  return input;
}

function teamTaskAssignInput(teamId: TeamId, taskId: TaskId, body: TeamTaskAssignBody): AssignTeamTaskInput {
  const input: AssignTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
    ownerPath: requestAgentPath(body.ownerPath, "ownerPath"),
  };
  if (body.assignedBy !== undefined) input.assignedBy = requestAgentPath(body.assignedBy, "assignedBy");
  if (body.message !== undefined) input.message = stringField(body.message, "message");
  const delivery = teamMessageDelivery(body.messageDelivery);
  if (delivery) input.messageDelivery = delivery;
  if (body.messageSummary !== undefined) input.messageSummary = stringField(body.messageSummary, "messageSummary");
  return input;
}

function teamTaskClaimInput(teamId: TeamId, taskId: TaskId, body: TeamTaskClaimBody): ClaimTeamTaskInput {
  const input: ClaimTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
    ownerPath: requestAgentPath(body.ownerPath, "ownerPath"),
  };
  if (body.claimedBy !== undefined) input.claimedBy = requestAgentPath(body.claimedBy, "claimedBy");
  return input;
}

function teamTaskDispatchInput(teamId: TeamId, taskId: TaskId, body: TeamTaskDispatchBody): TeamTaskDispatchInput {
  const input: TeamTaskDispatchInput = {
    ...teamContext(body),
    teamId,
    taskId,
  };
  if (body.ownerPath !== undefined) input.ownerPath = requestAgentPath(body.ownerPath, "ownerPath");
  if (body.cwd !== undefined) {
    const cwd = stringField(body.cwd, "cwd");
    if (cwd.includes("\0")) throw badRequest("cwd must be a valid filesystem path");
    input.cwd = cwd;
  }
  if (body.prompt !== undefined) input.prompt = stringField(body.prompt, "prompt");
  const mode = localSubagentMode(body.mode);
  if (mode) input.mode = mode;
  return input;
}

function teamTaskSyncInput(teamId: TeamId, taskId: TaskId, body: TeamContextBody): TeamTaskSyncInput {
  return {
    ...teamContext(body),
    teamId,
    taskId,
  };
}

function teamTaskReconcileInput(teamId: TeamId | undefined, body: TeamTaskReconcileBody): TeamTaskReconcileInput {
  const input: TeamTaskReconcileInput = {
    ...teamContext(body),
  };
  if (teamId) input.teamId = teamId;
  if (body.limit !== undefined) input.limit = positiveInteger(body.limit, "limit");
  return input;
}

function teamRunLoopInput(teamId: TeamId, body: TeamRunLoopBody): TeamExecutionRunInput {
  const input: TeamExecutionRunInput = {
    ...teamContext(body),
    teamId,
  };
  if (body.cwd !== undefined) input.cwd = teamRequestCwd(body.cwd);
  const mode = localSubagentMode(body.mode);
  if (mode) input.mode = mode;
  if (body.once !== undefined) input.once = parseRuntimeBoolean(body.once, "body.once");
  if (body.maxCycles !== undefined) input.maxCycles = positiveInteger(body.maxCycles, "maxCycles");
  if (body.timeoutMs !== undefined) input.timeoutMs = positiveInteger(body.timeoutMs, "timeoutMs");
  if (body.pollIntervalMs !== undefined) input.pollIntervalMs = nonNegativeInteger(body.pollIntervalMs, "pollIntervalMs");
  return input;
}

function teamMergeInput(teamId: TeamId, body: TeamMergeBody): TeamMergeInput {
  const input: TeamMergeInput = {
    ...teamContext(body),
    teamId,
  };
  if (body.taskId !== undefined) input.taskId = requestIdentifier<TaskId>(body.taskId, "taskId");
  if (body.cwd !== undefined) input.cwd = teamRequestCwd(body.cwd);
  return input;
}

function teamRequestCwd(value: unknown): string {
  const cwd = stringField(value, "cwd");
  if (cwd.includes("\0")) throw badRequest("cwd must be a valid filesystem path");
  return cwd;
}

function teamTaskUpdateInput(teamId: TeamId, taskId: TaskId, body: TeamTaskUpdateBody): UpdateTeamTaskInput {
  const input: UpdateTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
  };
  const status = teamTaskStatus(body.status);
  if (status) input.status = status;
  if (body.ownerPath !== undefined) input.ownerPath = requestAgentPath(body.ownerPath, "ownerPath");
  if (body.title !== undefined) input.title = stringField(body.title, "title");
  if (body.description !== undefined) input.description = stringField(body.description, "description");
  if (body.dependsOn !== undefined) input.dependsOn = requestIdentifierArray<TaskId>(body.dependsOn, "dependsOn");
  if (body.summary !== undefined) input.summary = stringField(body.summary, "summary");
  if (body.error !== undefined) input.error = stringField(body.error, "error");
  if (body.metadata !== undefined) input.metadata = parseRuntimeRecord(body.metadata, "body.metadata");
  return input;
}

function teamMessageInput(teamId: TeamId, body: TeamMessageBody): SendTeamMessageInput {
  const from = stringField(body.from, "from");
  const to = stringField(body.to, "to");
  const content = stringField(body.content, "content");
  const input: SendTeamMessageInput = {
    ...teamContext(body),
    teamId,
    from: from as SendTeamMessageInput["from"],
    to: to as SendTeamMessageInput["to"],
    content,
  };
  if (body.messageId !== undefined) input.messageId = requestIdentifier(body.messageId, "messageId");
  const kind = teamMessageKind(body.kind);
  if (kind) input.kind = kind;
  const delivery = teamMessageDelivery(body.delivery);
  if (delivery) input.delivery = delivery;
  if (body.taskId !== undefined) input.taskId = requestIdentifier<TaskId>(body.taskId, "taskId");
  if (body.summary !== undefined) input.summary = stringField(body.summary, "summary");
  if (body.metadata !== undefined) input.metadata = parseRuntimeRecord(body.metadata, "body.metadata");
  return input;
}

function agentTreeQueryFromUrl(url: URL): AgentTreeSnapshotQuery {
  const query: AgentTreeSnapshotQuery = {};
  const rootPath = url.searchParams.get("rootPath");
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  const includeConsumedMailbox = booleanParam(url.searchParams.get("includeConsumedMailbox"));
  const limit = numberParam(url.searchParams.get("limit"));
  if (rootPath) query.rootPath = rootPath as AgentPath;
  if (sessionId) query.sessionId = sessionId;
  if (includeConsumedMailbox !== undefined) query.includeConsumedMailbox = includeConsumedMailbox;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function agentRunQueryFromUrl(url: URL): AgentRunQuery {
  const query: AgentRunQuery = {};
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"), "childSessionId");
  const path = url.searchParams.get("path");
  const status = url.searchParams.get("status");
  const limit = numberParam(url.searchParams.get("limit"));
  if (sessionId) query.sessionId = sessionId;
  if (childSessionId) query.childSessionId = childSessionId;
  if (path) query.path = path as AgentPath;
  if (status === "running" || status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled") {
    query.status = status;
  }
  if (limit !== undefined) query.limit = limit;
  return query;
}

function mailboxQueryFromUrl(url: URL): AgentMailboxQuery {
  rejectUnknownQueryParameters(url, ["messageId", "taskId", "status", "path", "recipientSessionId", "limit"]);
  const query: AgentMailboxQuery = {};
  const messageId = url.searchParams.get("messageId");
  const taskId = url.searchParams.get("taskId");
  const status = url.searchParams.get("status");
  const path = url.searchParams.get("path");
  const recipientSessionId = asSessionId(url.searchParams.get("recipientSessionId"), "recipientSessionId");
  const limit = numberParam(url.searchParams.get("limit"));
  if (messageId) query.messageId = messageId;
  if (taskId) query.taskId = taskId as TaskId;
  if (status === "queued" || status === "delivering" || status === "consumed" || status === "discarded") {
    query.status = status;
  }
  if (path) query.path = path as AgentPath;
  if (recipientSessionId) query.recipientSessionId = recipientSessionId;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function taskQueryFromUrl(url: URL): AgentTaskQuery {
  const query: AgentTaskQuery = {};
  const status = taskStatus(url.searchParams.get("status"));
  const parentSessionId = asSessionId(url.searchParams.get("parentSessionId"), "parentSessionId");
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"), "childSessionId");
  const limit = numberParam(url.searchParams.get("limit"));
  if (status) query.status = status;
  if (parentSessionId) query.parentSessionId = parentSessionId;
  if (childSessionId) query.childSessionId = childSessionId;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function taskStatus(value: string | null): AgentTaskStatus | undefined {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "incomplete" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}

function teamMemberStatus(value: unknown): AddTeamMemberInput["status"] | undefined {
  if (value === undefined) return undefined;
  if (value === "idle" || value === "running" || value === "waiting" || value === "blocked" || value === "closed") {
    return value;
  }
  throw badRequest("member status must be idle, running, waiting, blocked, or closed");
}

function teamTaskStatus(value: unknown): CreateTeamTaskInput["status"] | undefined {
  if (value === undefined) return undefined;
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw badRequest("task status must be pending, in_progress, blocked, completed, failed, or cancelled");
}

function teamMessageKind(value: unknown): SendTeamMessageInput["kind"] | undefined {
  if (value === undefined) return undefined;
  if (value === "text" || value === "task_assignment" || value === "system") return value;
  throw badRequest("message kind must be text, task_assignment, or system");
}

function teamMessageDelivery(value: unknown): TeamMessageDelivery | undefined {
  if (value === undefined) return undefined;
  if (value === "queueOnly" || value === "triggerTurn") return value;
  throw badRequest("message delivery must be queueOnly or triggerTurn");
}

function localSubagentMode(value: unknown): TeamTaskDispatchInput["mode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "one_shot" || value === "resumable" || value === "background") return value;
  throw badRequest("mode must be one_shot, resumable, or background");
}

function serializeTeamTaskDispatchResult(result: TeamTaskDispatchResult): Record<string, unknown> {
  const agentTask = result.agentTask ? serializeLocalSubagentTask(result.agentTask) : undefined;
  return {
    status: result.status,
    teamTask: result.teamTask,
    team_task: result.teamTask,
    reason: result.reason,
    agentTask,
    agent_task: agentTask,
  };
}

function serializeLocalSubagentTask(task: NonNullable<TeamTaskDispatchResult["agentTask"]>): Record<string, unknown> {
  return {
    ...task,
    error: task.error ? normalizePersistedError(task.error).message : undefined,
  };
}

function closeStatus(value: unknown): AgentTaskFinalStatus {
  if (value === undefined) return "cancelled";
  if (value === "completed" || value === "incomplete" || value === "failed" || value === "cancelled") return value;
  throw badRequest("status must be completed, incomplete, failed, or cancelled");
}

function reconcileStaleInput(body: TaskReconcileStaleBody): AgentTaskReconcileStaleInput {
  // HTTP is a cross-process boundary. Never expose the single-process unsafe
  // mode that can close a task before its durable worker lease is committed.
  const input: AgentTaskReconcileStaleInput = { requireLeaseEvidence: true };
  if (body.parentSessionId !== undefined) {
    input.parentSessionId = requestSessionId(body.parentSessionId);
  }
  if (body.staleAfterMs !== undefined) {
    input.staleAfterMs = nonNegativeInteger(body.staleAfterMs, "staleAfterMs");
  }
  if (body.limit !== undefined) input.limit = positiveInteger(body.limit, "limit");
  if (body.summary !== undefined) input.summary = stringField(body.summary, "summary");
  if (body.error !== undefined) input.error = stringField(body.error, "error");
  if (body.modes !== undefined) {
    if (!Array.isArray(body.modes)) throw badRequest("modes must be an array");
    input.modes = body.modes.map((mode) => {
      if (mode !== "one_shot" && mode !== "resumable" && mode !== "background") {
        throw badRequest("modes must contain one_shot, resumable, or background");
      }
      return mode as AgentTaskMode;
    });
  }
  return input;
}

function numberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanParam(value: string | null): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}
