import type { ReactNode } from "react";
import type { DesktopProject } from "../shared/contracts.js";

export function ProjectSidebar({ projects, activeId, disabled, onActivate, onNewSession, children }: {
  projects: readonly DesktopProject[];
  activeId: string | undefined;
  disabled: boolean;
  onActivate: (projectId: string, sessionId?: string) => void;
  onNewSession: () => void;
  children: ReactNode;
}) {
  if (projects.length === 0) return <>{children}</>;
  return <div className="project-list" aria-label="Projects">
    {projects.map((project) => {
      const active = project.id === activeId;
      const name = project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path;
      return <section className={`project-group ${active ? "project-active" : ""}`} key={project.id}>
        <div className="project-heading-row"><button className="project-heading" type="button" aria-label={`Open project ${name}`} aria-current={active ? "true" : undefined}
          disabled={disabled} title={project.path} onClick={() => onActivate(project.id)}>
          <span className="project-folder" aria-hidden="true">{active ? "▾" : "▸"}</span>
          <span className="project-name"><strong>{name}</strong></span>
          {project.attentionCount > 0 ? <span className="project-badge attention" title="Tasks need your attention">{project.attentionCount}</span>
            : project.runningCount > 0 ? <span className="project-badge running" title="Running in this project">{project.runningCount}</span>
              : <span className={`mini-status phase-${project.phase}`} aria-label={project.phase} />}
        </button>{active ? <button className="icon-button directory-new" type="button" aria-label={`在 ${name} 新建会话`} disabled={disabled} onClick={onNewSession}>+</button> : null}</div>
        {active ? children : <div className="project-task-preview">
          {project.recentTasks.filter((task) => task.status === "active").slice(0, 4).map((task) => <button key={task.id}
            type="button" disabled={disabled} title={task.title} aria-label={`Open ${task.title} in ${name}`}
            onClick={() => onActivate(project.id, task.id)}>{task.title}</button>)}
          {!project.tasksLoaded ? <span>打开以查看会话</span> : project.recentTasks.length === 0 ? <span>还没有会话</span> : null}
        </div>}
      </section>;
    })}
  </div>;
}
