import type { AgentPath, TaskId, TeamId } from "@chili/protocol";

export type TeamMemberStatus = "idle" | "running" | "waiting" | "blocked" | "closed";
export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export interface TeamMember {
  path: AgentPath;
  role: string;
  status: TeamMemberStatus;
  writeScope?: string[];
}

export interface TeamTask {
  id: TaskId;
  teamId: TeamId;
  title: string;
  status: TeamTaskStatus;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
}

export interface TeamRuntime {
  createTeam(input: CreateTeamInput): Promise<TeamId>;
  addMember(input: AddTeamMemberInput): Promise<TeamMember>;
  createTask(input: CreateTeamTaskInput): Promise<TeamTask>;
  updateTask(input: UpdateTeamTaskInput): Promise<TeamTask>;
}

export interface CreateTeamInput {
  name: string;
  leadPath: AgentPath;
}

export interface AddTeamMemberInput {
  teamId: TeamId;
  path: AgentPath;
  role: string;
  writeScope?: string[];
}

export interface CreateTeamTaskInput {
  teamId: TeamId;
  title: string;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
}

export interface UpdateTeamTaskInput {
  teamId: TeamId;
  taskId: TaskId;
  status: TeamTaskStatus;
}
