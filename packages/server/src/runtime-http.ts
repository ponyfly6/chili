import type {
  ChiliEvent,
  AgentPath,
  AgentTaskMode,
  AgentTaskStatus,
  RuntimeInterruptResult,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimeApprovalResolveResult,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  RuntimeTurnResult,
  ModelSelection,
  ReasoningLevel,
  SessionId,
  ThreadId,
  TaskId,
  TeamId,
  TeamMessageDelivery,
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
import type { EventPublisher, EventStore } from "@chili/store";
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

export interface RuntimeHttpService {
  createSession(input?: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string }): Promise<RuntimeSessionRef>;
  listModels?(input?: { provider?: string }): Promise<RuntimeModelDescriptor[]>;
  getModelConfig?(sessionId: SessionId): Promise<RuntimeModelConfig>;
  setModel?(input: { sessionId: SessionId; threadId?: ThreadId; modelSelection: ModelSelection }): Promise<RuntimeModelConfig>;
  setReasoning?(input: { sessionId: SessionId; threadId?: ThreadId; reasoningLevel: ReasoningLevel }): Promise<RuntimeModelConfig>;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  submitPromptAsync(input: SubmitPromptInput, onError?: RuntimeBackgroundErrorHandler): void;
  interrupt(sessionId: SessionId, reason?: string): Promise<boolean>;
  archiveSession(sessionId: SessionId): Promise<void>;
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

export interface RuntimeHttpHandlerOptions {
  service: RuntimeHttpService;
  store: EventStore & EventPublisher;
  tasks?: RuntimeTaskControlService;
  agents?: RuntimeAgentTreeService;
  teams?: RuntimeTeamService;
  teamDispatcher?: RuntimeTeamDispatcherService;
  teamMerger?: RuntimeTeamMergeService;
  teamRunner?: RuntimeTeamExecutionRunnerService;
  approvals?: ApprovalResolver;
  maxBacklogEvents?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface ApprovalResolver {
  resolve(input: {
    approvalId: import("@chili/protocol").ApprovalId;
    decision: "allow_once" | "allow_always" | "deny";
    feedback?: string;
  }): boolean | Promise<boolean>;
}

export interface StartRuntimeHttpServerOptions extends RuntimeHttpHandlerOptions {
  hostname?: string;
  port?: number;
  idleTimeout?: number;
}

export interface RuntimeHttpServer {
  url: string;
  close(): void;
}

export function createRuntimeHttpHandler(options: RuntimeHttpHandlerOptions): (request: Request) => Promise<Response> {
  const maxBacklogEvents = options.maxBacklogEvents ?? 5000;

  return async function runtimeHttpHandler(request: Request): Promise<Response> {
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

      if (route.name === "listTasks") {
        const tasks = requireTaskControl(options);
        return json(await tasks.listTasks(taskQueryFromUrl(url)));
      }

      if (route.name === "tasksReconcileStale") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskReconcileStaleBody>(request);
        return json(await tasks.reconcileStaleTasks(reconcileStaleInput(body)));
      }

      if (route.name === "task") {
        const tasks = requireTaskControl(options);
        return json(await tasks.getTask(route.taskId));
      }

      if (route.name === "taskFollowup") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskFollowupBody>(request);
        if (!body.text) throw badRequest("text is required");
        const input: AgentTaskFollowupInput = {
          taskId: route.taskId,
          text: body.text,
        };
        if (body.maxTurns !== undefined) input.maxTurns = body.maxTurns;
        if (body.system) input.system = body.system;
        return json(serializeTaskFollowupResult(await tasks.followupTask(input)));
      }

      if (route.name === "taskWait") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskWaitBody>(request);
        const input: AgentTaskWaitInput = { taskId: route.taskId };
        if (body.timeoutMs !== undefined) input.timeoutMs = body.timeoutMs;
        return json(await tasks.waitForTask(input));
      }

      if (route.name === "taskClose") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskCloseBody>(request);
        const input: AgentTaskCloseInput = {
          taskId: route.taskId,
          status: closeStatus(body.status),
        };
        if (body.summary) input.summary = body.summary;
        if (body.error) input.error = body.error;
        if (body.interrupt !== undefined) input.interrupt = body.interrupt;
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
        const query = {
          limit: maxBacklogEvents,
        } as {
          sessionId?: SessionId;
          limit: number;
        };
        if (route.sessionId) query.sessionId = route.sessionId;
        const events = await options.store.events(query);
        return json(projectRuntimeAgents(events, route.sessionId));
      }

      if (route.name === "listTeams") {
        const teams = requireTeams(options);
        return json(await teams.listTeams());
      }

      if (route.name === "createTeam") {
        const teams = requireTeams(options);
        const body = await readJson<TeamCreateBody>(request);
        if (!body.name) throw badRequest("name is required");
        if (!body.leadPath) throw badRequest("leadPath is required");
        return json(await teams.createTeam(teamCreateInput(body)), 201);
      }

      if (route.name === "teamReconcileDispatches") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamTaskReconcileBody>(request);
        return json(await dispatcher.reconcileTasks(teamTaskReconcileInput(route.teamId, body)));
      }

      if (route.name === "teamRunLoop") {
        const runner = requireTeamRunner(options);
        const body = await readJson<TeamRunLoopBody>(request);
        const input = teamRunLoopInput(route.teamId, body);
        input.signal = request.signal;
        return json(await runner.run(input));
      }

      if (route.name === "teamMerge") {
        const merger = requireTeamMerger(options);
        const body = await readJson<TeamMergeBody>(request);
        const input = teamMergeInput(route.teamId, body);
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
        const body = await readJson<TeamMemberBody>(request);
        if (!body.path) throw badRequest("path is required");
        if (!body.name) throw badRequest("name is required");
        if (!body.role) throw badRequest("role is required");
        return json(await teams.addMember(teamMemberInput(route.teamId, body)), 201);
      }

      if (route.name === "teamTasks") {
        const teams = requireTeams(options);
        return json(await teams.tasks(route.teamId));
      }

      if (route.name === "teamCreateTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskCreateBody>(request);
        if (!body.title) throw badRequest("title is required");
        return json(await teams.createTask(teamTaskCreateInput(route.teamId, body)), 201);
      }

      if (route.name === "teamAssignTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskAssignBody>(request);
        if (!body.ownerPath) throw badRequest("ownerPath is required");
        return json(await teams.assignTask(teamTaskAssignInput(route.teamId, route.taskId, body)));
      }

      if (route.name === "teamClaimTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskClaimBody>(request);
        if (!body.ownerPath) throw badRequest("ownerPath is required");
        return json(await teams.claimTask(teamTaskClaimInput(route.teamId, route.taskId, body)));
      }

      if (route.name === "teamDispatchTask") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamTaskDispatchBody>(request);
        return json(
          serializeTeamTaskDispatchResult(await dispatcher.dispatchTask(teamTaskDispatchInput(route.teamId, route.taskId, body))),
        );
      }

      if (route.name === "teamSyncTask") {
        const dispatcher = requireTeamDispatcher(options);
        const body = await readJson<TeamContextBody>(request);
        return json(await dispatcher.syncTask(teamTaskSyncInput(route.teamId, route.taskId, body)));
      }

      if (route.name === "teamUpdateTask") {
        const teams = requireTeams(options);
        const body = await readJson<TeamTaskUpdateBody>(request);
        return json(await teams.updateTask(teamTaskUpdateInput(route.teamId, route.taskId, body)));
      }

      if (route.name === "teamMessages") {
        const teams = requireTeams(options);
        return json(await teams.messages(route.teamId));
      }

      if (route.name === "teamSendMessage") {
        const teams = requireTeams(options);
        const body = await readJson<TeamMessageBody>(request);
        if (!body.from) throw badRequest("from is required");
        if (!body.to) throw badRequest("to is required");
        if (!body.content) throw badRequest("content is required");
        return json(await teams.sendMessage(teamMessageInput(route.teamId, body)), 201);
      }

      if (route.name === "createSession") {
        const body = await readJson<CreateSessionBody>(request);
        const input: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string } = {};
        if (body.sessionId) input.sessionId = body.sessionId;
        if (body.threadId) input.threadId = body.threadId;
        if (body.cwd) input.cwd = body.cwd;
        return json(await options.service.createSession(input), 201);
      }

      if (route.name === "messages") {
        return json(await options.store.messages(route.sessionId));
      }

      if (route.name === "modelConfig") {
        await requireSession(options.store, route.sessionId);
        return json(await requireModelControl(options).getModelConfig(route.sessionId));
      }

      if (route.name === "setModel") {
        await requireSession(options.store, route.sessionId);
        const body = await readJson<ModelBody>(request);
        if (!isModelSelection(body.modelSelection)) throw badRequest("modelSelection with provider and model is required");
        return json(await requireModelControl(options).setModel({
          sessionId: route.sessionId,
          ...(body.threadId ? { threadId: body.threadId } : {}),
          modelSelection: body.modelSelection,
        }));
      }

      if (route.name === "setReasoning") {
        await requireSession(options.store, route.sessionId);
        const body = await readJson<ReasoningBody>(request);
        if (!isReasoningLevel(body.reasoningLevel)) {
          throw badRequest("reasoningLevel must be off, minimal, low, medium, high, or xhigh");
        }
        return json(await requireModelControl(options).setReasoning({
          sessionId: route.sessionId,
          ...(body.threadId ? { threadId: body.threadId } : {}),
          reasoningLevel: body.reasoningLevel,
        }));
      }

      if (route.name === "prompt" || route.name === "promptAsync") {
        const body = await readJson<PromptBody>(request);
        if (!body.threadId) throw badRequest("threadId is required");
        if (!body.text) throw badRequest("text is required");
        await requireSession(options.store, route.sessionId);

        const input = buildSubmitPromptInput(route.sessionId, body);

        if (route.name === "prompt") {
          return json(serializeSubmitPromptResult(await options.service.submitPrompt(input)));
        }

        options.service.submitPromptAsync(input, options.onBackgroundError);
        const accepted: RuntimePromptAccepted = {
          status: "accepted",
          sessionId: route.sessionId,
          threadId: body.threadId,
        };
        return json(accepted, 202);
      }

      if (route.name === "interrupt") {
        const body = await readJson<InterruptBody>(request);
        const result: RuntimeInterruptResult = {
          interrupted: await options.service.interrupt(route.sessionId, body.reason),
        };
        return json(result);
      }

      if (route.name === "archive") {
        await options.service.archiveSession(route.sessionId);
        return new Response(null, { status: 204 });
      }

      if (route.name === "resolveApproval") {
        if (!options.approvals) return jsonError(501, "No approval resolver is configured");
        const body = await readJson<ResolveApprovalBody>(request);
        if (!body.decision) throw badRequest("decision is required");
        const resolveInput: {
          approvalId: import("@chili/protocol").ApprovalId;
          decision: "allow_once" | "allow_always" | "deny";
          feedback?: string;
        } = {
          approvalId: route.approvalId,
          decision: body.decision,
        };
        if (body.feedback) resolveInput.feedback = body.feedback;
        const resolved = await options.approvals.resolve(resolveInput);
        if (!resolved) {
          return jsonError(409, "Approval is not pending in this runtime. It may have been handled already or orphaned by a server restart.");
        }
        const result: RuntimeApprovalResolveResult = { resolved };
        return json(result);
      }

      if (route.name === "events") {
        const streamOptions: EventStreamOptions = {
          store: options.store,
          request,
          maxBacklogEvents,
        };
        const sessionId = asSessionId(url.searchParams.get("sessionId"));
        const threadId = asThreadId(url.searchParams.get("threadId"));
        const afterEventId = url.searchParams.get("afterEventId");
        if (sessionId) streamOptions.sessionId = sessionId;
        if (threadId) streamOptions.threadId = threadId;
        if (afterEventId) streamOptions.afterEventId = afterEventId;
        return eventStream(streamOptions);
      }

      return jsonError(404, "Not found");
    } catch (error) {
      const err = toHttpError(error);
      return jsonError(err.status, err.message);
    }
  };
}

export function startRuntimeHttpServer(options: StartRuntimeHttpServerOptions): RuntimeHttpServer {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: options.idleTimeout ?? 255,
    fetch: createRuntimeHttpHandler(options),
  });

  return {
    url: server.url.href,
    close: () => server.stop(true),
  };
}

type Route =
  | { name: "health" }
  | { name: "events" }
  | { name: "agents"; sessionId?: SessionId }
  | { name: "listSessions" }
  | { name: "listTasks" }
  | { name: "tasksReconcileStale" }
  | { name: "models" }
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
  | { name: "modelConfig"; sessionId: SessionId }
  | { name: "setModel"; sessionId: SessionId }
  | { name: "setReasoning"; sessionId: SessionId }
  | { name: "prompt"; sessionId: SessionId }
  | { name: "promptAsync"; sessionId: SessionId }
  | { name: "interrupt"; sessionId: SessionId }
  | { name: "archive"; sessionId: SessionId }
  | { name: "resolveApproval"; approvalId: import("@chili/protocol").ApprovalId }
  | { name: "notFound" };

interface CreateSessionBody {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

interface PromptBody {
  threadId?: ThreadId;
  text?: string;
  cwd?: string;
  maxTurns?: number;
  system?: string[];
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
}

interface ModelBody {
  threadId?: ThreadId;
  modelSelection?: unknown;
}

interface ReasoningBody {
  threadId?: ThreadId;
  reasoningLevel?: unknown;
}

interface TaskFollowupBody {
  text?: string;
  maxTurns?: number;
  system?: string[];
}

interface TaskWaitBody {
  timeoutMs?: number;
}

interface TaskCloseBody {
  status?: unknown;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

interface TaskReconcileStaleBody {
  staleAfterMs?: number;
  modes?: unknown;
  limit?: number;
  summary?: string;
  error?: string;
}

interface TeamContextBody {
  sessionId?: SessionId;
  threadId?: ThreadId;
}

interface TeamCreateBody extends TeamContextBody {
  teamId?: TeamId;
  name?: string;
  leadPath?: AgentPath;
  description?: string;
  leadName?: string;
  leadRole?: string;
  leadStatus?: unknown;
  leadWriteScope?: string[];
}

interface TeamMemberBody extends TeamContextBody {
  path?: AgentPath;
  name?: string;
  role?: string;
  status?: unknown;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
}

interface TeamTaskCreateBody extends TeamContextBody {
  taskId?: TaskId;
  title?: string;
  description?: string;
  createdBy?: AgentPath;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
  status?: unknown;
  metadata?: Record<string, unknown>;
}

interface TeamTaskAssignBody extends TeamContextBody {
  ownerPath?: AgentPath;
  assignedBy?: AgentPath;
  message?: string;
  messageDelivery?: unknown;
  messageSummary?: string;
}

interface TeamTaskClaimBody extends TeamContextBody {
  ownerPath?: AgentPath;
  claimedBy?: AgentPath;
}

interface TeamTaskDispatchBody extends TeamContextBody {
  ownerPath?: AgentPath;
  cwd?: string;
  mode?: string;
  prompt?: string;
}

interface TeamTaskReconcileBody extends TeamContextBody {
  limit?: number;
}

interface TeamRunLoopBody extends TeamContextBody {
  cwd?: string;
  mode?: string;
  once?: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface TeamMergeBody extends TeamContextBody {
  taskId?: TaskId;
  cwd?: string;
}

interface TeamTaskUpdateBody extends TeamContextBody {
  status?: unknown;
  ownerPath?: AgentPath;
  title?: string;
  description?: string;
  dependsOn?: TaskId[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface TeamMessageBody extends TeamContextBody {
  messageId?: string;
  from?: AgentPath;
  to?: AgentPath | "*";
  content?: string;
  kind?: unknown;
  delivery?: unknown;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
}

interface InterruptBody {
  reason?: string;
}

interface ResolveApprovalBody {
  decision?: "allow_once" | "allow_always" | "deny";
  feedback?: string;
}

interface EventStreamOptions {
  store: EventStore & EventPublisher;
  request: Request;
  sessionId?: SessionId;
  threadId?: ThreadId;
  afterEventId?: string;
  maxBacklogEvents: number;
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
  if (method === "GET" && path === "/models") return { name: "models" };
  if (method === "GET" && path === "/tasks") return { name: "listTasks" };
  if (method === "POST" && path === "/tasks/reconcile_stale") return { name: "tasksReconcileStale" };
  if (method === "POST" && path === "/sessions") return { name: "createSession" };

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

  const sessionRoute = /^\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
  if (!sessionRoute) return { name: "notFound" };

  const sessionId = decodeURIComponent(sessionRoute[1] ?? "") as SessionId;
  const action = sessionRoute[2];
  if (method === "GET" && action === "agents") return { name: "agents", sessionId };
  if (method === "GET" && action === "messages") return { name: "messages", sessionId };
  if (method === "GET" && action === "model") return { name: "modelConfig", sessionId };
  if (method === "POST" && action === "model") return { name: "setModel", sessionId };
  if (method === "POST" && action === "reasoning") return { name: "setReasoning", sessionId };
  if (method === "POST" && action === "prompt") return { name: "prompt", sessionId };
  if (method === "POST" && action === "prompt_async") return { name: "promptAsync", sessionId };
  if (method === "POST" && action === "interrupt") return { name: "interrupt", sessionId };
  if (method === "POST" && action === "archive") return { name: "archive", sessionId };
  return { name: "notFound" };
}

function buildSubmitPromptInput(sessionId: SessionId, body: PromptBody): SubmitPromptInput {
  const input: SubmitPromptInput = {
    sessionId,
    threadId: body.threadId as ThreadId,
    text: body.text ?? "",
  };
  if (body.cwd) input.cwd = body.cwd;
  if (body.maxTurns !== undefined) input.maxTurns = body.maxTurns;
  if (body.system) input.system = body.system;
  if (isModelSelection(body.modelSelection)) input.modelSelection = body.modelSelection;
  if (isReasoningLevel(body.reasoningLevel)) input.reasoningLevel = body.reasoningLevel;
  return input;
}

async function eventStream(options: EventStreamOptions): Promise<Response> {
  const encoder = new TextEncoder();
  const sentIds = new Set<string>();
  const pending: ChiliEvent[] = [];
  let backlogDone = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closeController: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    closeController?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChiliEvent): void => {
        if (closed || sentIds.has(event.id) || !matchesEvent(event, options)) return;
        sentIds.add(event.id);
        controller.enqueue(encoder.encode(formatSse(event)));
      };

      unsubscribe = options.store.subscribe((event) => {
        if (backlogDone) {
          send(event);
        } else {
          pending.push(event);
        }
      });

      closeController = (): void => {
        try {
          controller.close();
        } catch {
          // The client may have closed first.
        }
      };

      options.request.signal.addEventListener("abort", cleanup, { once: true });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 5_000);

      const query = {
        limit: options.maxBacklogEvents,
      } as {
        sessionId?: SessionId;
        threadId?: ThreadId;
        afterEventId?: string;
        limit: number;
      };
      if (options.sessionId) query.sessionId = options.sessionId;
      if (options.threadId) query.threadId = options.threadId;
      if (options.afterEventId) query.afterEventId = options.afterEventId;
      const backlog = await options.store.events(query);
      for (const event of backlog) send(event as ChiliEvent);
      backlogDone = true;
      for (const event of pending.splice(0)) send(event);
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
  if (options.threadId && event.threadId !== options.threadId) return false;
  return true;
}

function formatSse(event: ChiliEvent): string {
  return [`id: ${event.id}`, "event: chili.event", `data: ${JSON.stringify(event)}`, "", ""].join("\n");
}

function serializeSubmitPromptResult(result: SubmitPromptResult): RuntimePromptResult {
  const turns = result.turns.map(serializeTurnResult);
  if (result.status === "completed") {
    const completed: Extract<RuntimePromptResult, { status: "completed" }> = { status: "completed", turns };
    if (result.finishReason) completed.finishReason = result.finishReason;
    return completed;
  }

  const failed: Extract<RuntimePromptResult, { status: "failed" | "cancelled" | "max_turns" }> = {
    status: result.status,
    turns,
  };
  if (result.error) failed.error = serializeError(result.error);
  if (result.finishReason) failed.finishReason = result.finishReason;
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
    if (result.finishReason) completed.finishReason = result.finishReason;
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
  return {
    name: error.name || "Error",
    message: error.message,
  };
}

async function requireSession(store: EventStore, sessionId: SessionId): Promise<void> {
  const sessions = await store.sessions();
  if (!sessions.some((session) => session.id === sessionId)) {
    throw notFound(`Session not found: ${sessionId}`);
  }
}

async function readJson<T>(request: Request): Promise<T> {
  if (request.headers.get("content-length") === "0") return {} as T;
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: { message } }, status);
}

function badRequest(message: string): HttpError {
  return { status: 400, message };
}

function notFound(message: string): HttpError {
  return { status: 404, message };
}

function toHttpError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (err.name === "AgentTaskNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentTaskNotRunnableError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "AgentTaskWaitTimeoutError") {
    return { status: 408, message: err.message };
  }
  if (err.name === "AgentMailboxNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentMailboxNotDeliverableError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamNotFoundError" || err.name === "TeamMemberNotFoundError" || err.name === "TeamTaskNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "TeamTaskClaimError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "TeamMessageDeliveryError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "RuntimeBusyError") {
    return { status: 409, message: err.message };
  }
  return { status: 500, message: err.message };
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

function asSessionId(value: string | null): SessionId | undefined {
  return value ? (value as SessionId) : undefined;
}

function asThreadId(value: string | null): ThreadId | undefined {
  return value ? (value as ThreadId) : undefined;
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
    || value === "xhigh";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireTaskControl(options: RuntimeHttpHandlerOptions): RuntimeTaskControlService {
  if (!options.tasks) throw { status: 501, message: "No task control service is configured" } satisfies HttpError;
  return options.tasks;
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

function teamContext(body: TeamContextBody): TeamEventContextInput {
  const input: TeamEventContextInput = {};
  if (body.sessionId) input.sessionId = body.sessionId;
  if (body.threadId) input.threadId = body.threadId;
  return input;
}

type TeamEventContextInput = Pick<CreateTeamInput, "sessionId" | "threadId">;

function teamCreateInput(body: TeamCreateBody): CreateTeamInput {
  const input: CreateTeamInput = {
    ...teamContext(body),
    name: body.name ?? "",
    leadPath: body.leadPath as AgentPath,
  };
  if (body.teamId) input.teamId = body.teamId;
  if (body.description) input.description = body.description;
  if (body.leadName) input.leadName = body.leadName;
  if (body.leadRole) input.leadRole = body.leadRole;
  const leadStatus = teamMemberStatus(body.leadStatus);
  if (leadStatus) input.leadStatus = leadStatus;
  if (body.leadWriteScope) input.leadWriteScope = body.leadWriteScope;
  return input;
}

function teamMemberInput(teamId: TeamId, body: TeamMemberBody): AddTeamMemberInput {
  const input: AddTeamMemberInput = {
    ...teamContext(body),
    teamId,
    path: body.path as AgentPath,
    name: body.name ?? "",
    role: body.role ?? "",
  };
  const status = teamMemberStatus(body.status);
  if (status) input.status = status;
  if (body.childSessionId) input.childSessionId = body.childSessionId;
  if (body.childThreadId) input.childThreadId = body.childThreadId;
  if (body.model) input.model = body.model;
  if (body.toolScope) input.toolScope = body.toolScope;
  if (body.writeScope) input.writeScope = body.writeScope;
  return input;
}

function teamTaskCreateInput(teamId: TeamId, body: TeamTaskCreateBody): CreateTeamTaskInput {
  const input: CreateTeamTaskInput = {
    ...teamContext(body),
    teamId,
    title: body.title ?? "",
  };
  if (body.taskId) input.taskId = body.taskId;
  if (body.description) input.description = body.description;
  if (body.createdBy) input.createdBy = body.createdBy;
  if (body.ownerPath) input.ownerPath = body.ownerPath;
  if (body.dependsOn) input.dependsOn = body.dependsOn;
  const status = teamTaskStatus(body.status);
  if (status) input.status = status;
  if (body.metadata) input.metadata = body.metadata;
  return input;
}

function teamTaskAssignInput(teamId: TeamId, taskId: TaskId, body: TeamTaskAssignBody): AssignTeamTaskInput {
  const input: AssignTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
    ownerPath: body.ownerPath as AgentPath,
  };
  if (body.assignedBy) input.assignedBy = body.assignedBy;
  if (body.message) input.message = body.message;
  const delivery = teamMessageDelivery(body.messageDelivery);
  if (delivery) input.messageDelivery = delivery;
  if (body.messageSummary) input.messageSummary = body.messageSummary;
  return input;
}

function teamTaskClaimInput(teamId: TeamId, taskId: TaskId, body: TeamTaskClaimBody): ClaimTeamTaskInput {
  const input: ClaimTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
    ownerPath: body.ownerPath as AgentPath,
  };
  if (body.claimedBy) input.claimedBy = body.claimedBy;
  return input;
}

function teamTaskDispatchInput(teamId: TeamId, taskId: TaskId, body: TeamTaskDispatchBody): TeamTaskDispatchInput {
  const input: TeamTaskDispatchInput = {
    ...teamContext(body),
    teamId,
    taskId,
  };
  if (body.ownerPath) input.ownerPath = body.ownerPath;
  if (body.cwd) input.cwd = body.cwd;
  if (body.prompt) input.prompt = body.prompt;
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
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit <= 0) throw badRequest("limit must be a positive integer");
    input.limit = body.limit;
  }
  return input;
}

function teamRunLoopInput(teamId: TeamId, body: TeamRunLoopBody): TeamExecutionRunInput {
  const input: TeamExecutionRunInput = {
    ...teamContext(body),
    teamId,
  };
  if (body.cwd) input.cwd = body.cwd;
  const mode = localSubagentMode(body.mode);
  if (mode) input.mode = mode;
  if (body.once !== undefined) input.once = body.once;
  if (body.maxCycles !== undefined) {
    if (!Number.isInteger(body.maxCycles) || body.maxCycles <= 0) throw badRequest("maxCycles must be a positive integer");
    input.maxCycles = body.maxCycles;
  }
  if (body.timeoutMs !== undefined) {
    if (!Number.isInteger(body.timeoutMs) || body.timeoutMs <= 0) throw badRequest("timeoutMs must be a positive integer");
    input.timeoutMs = body.timeoutMs;
  }
  if (body.pollIntervalMs !== undefined) {
    if (!Number.isInteger(body.pollIntervalMs) || body.pollIntervalMs < 0) throw badRequest("pollIntervalMs must be a non-negative integer");
    input.pollIntervalMs = body.pollIntervalMs;
  }
  return input;
}

function teamMergeInput(teamId: TeamId, body: TeamMergeBody): TeamMergeInput {
  const input: TeamMergeInput = {
    ...teamContext(body),
    teamId,
  };
  if (body.taskId) input.taskId = body.taskId;
  if (body.cwd) input.cwd = body.cwd;
  return input;
}

function teamTaskUpdateInput(teamId: TeamId, taskId: TaskId, body: TeamTaskUpdateBody): UpdateTeamTaskInput {
  const input: UpdateTeamTaskInput = {
    ...teamContext(body),
    teamId,
    taskId,
  };
  const status = teamTaskStatus(body.status);
  if (status) input.status = status;
  if (body.ownerPath) input.ownerPath = body.ownerPath;
  if (body.title) input.title = body.title;
  if (body.description) input.description = body.description;
  if (body.dependsOn) input.dependsOn = body.dependsOn;
  if (body.summary) input.summary = body.summary;
  if (body.error) input.error = body.error;
  if (body.metadata) input.metadata = body.metadata;
  return input;
}

function teamMessageInput(teamId: TeamId, body: TeamMessageBody): SendTeamMessageInput {
  const input: SendTeamMessageInput = {
    ...teamContext(body),
    teamId,
    from: body.from as AgentPath,
    to: body.to as AgentPath | "*",
    content: body.content ?? "",
  };
  if (body.messageId) input.messageId = body.messageId;
  const kind = teamMessageKind(body.kind);
  if (kind) input.kind = kind;
  const delivery = teamMessageDelivery(body.delivery);
  if (delivery) input.delivery = delivery;
  if (body.taskId) input.taskId = body.taskId;
  if (body.summary) input.summary = body.summary;
  if (body.metadata) input.metadata = body.metadata;
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
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
  const path = url.searchParams.get("path");
  const status = url.searchParams.get("status");
  const limit = numberParam(url.searchParams.get("limit"));
  if (sessionId) query.sessionId = sessionId;
  if (childSessionId) query.childSessionId = childSessionId;
  if (path) query.path = path as AgentPath;
  if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") {
    query.status = status;
  }
  if (limit !== undefined) query.limit = limit;
  return query;
}

function mailboxQueryFromUrl(url: URL): AgentMailboxQuery {
  const query: AgentMailboxQuery = {};
  const messageId = url.searchParams.get("messageId");
  const taskId = url.searchParams.get("taskId");
  const status = url.searchParams.get("status");
  const path = url.searchParams.get("path");
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
  const limit = numberParam(url.searchParams.get("limit"));
  if (messageId) query.messageId = messageId;
  if (taskId) query.taskId = taskId as TaskId;
  if (status === "queued" || status === "delivering" || status === "consumed") query.status = status;
  if (path) query.path = path as AgentPath;
  if (childSessionId) query.childSessionId = childSessionId;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function taskQueryFromUrl(url: URL): AgentTaskQuery {
  const query: AgentTaskQuery = {};
  const status = taskStatus(url.searchParams.get("status"));
  const parentSessionId = asSessionId(url.searchParams.get("parentSessionId"));
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
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
    error: task.error ? task.error.message : undefined,
  };
}

function closeStatus(value: unknown): AgentTaskFinalStatus {
  if (value === undefined) return "cancelled";
  if (value === "completed" || value === "failed" || value === "cancelled") return value;
  throw badRequest("status must be completed, failed, or cancelled");
}

function reconcileStaleInput(body: TaskReconcileStaleBody): AgentTaskReconcileStaleInput {
  const input: AgentTaskReconcileStaleInput = {};
  if (body.staleAfterMs !== undefined) {
    if (!Number.isInteger(body.staleAfterMs) || body.staleAfterMs < 0) {
      throw badRequest("staleAfterMs must be a non-negative integer");
    }
    input.staleAfterMs = body.staleAfterMs;
  }
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit <= 0) {
      throw badRequest("limit must be a positive integer");
    }
    input.limit = body.limit;
  }
  if (body.summary) input.summary = body.summary;
  if (body.error) input.error = body.error;
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
