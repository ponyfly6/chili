import type { ReactNode } from "react";
import type { DesktopProject } from "../shared/contracts.js";

export function ProjectSidebar({ projects, activeId, disabled, onActivate, children }: {
  projects: readonly DesktopProject[];
  activeId: string | undefined;
  disabled: boolean;
  onActivate: (projectId: string, sessionId?: string) => void;
  children: ReactNode;
}) {
  if (projects.length === 0) return <>{children}</>;
  return <div className="project-list" aria-label="Projects">
    {projects.map((project) => {
      const active = project.id === activeId;
      const name = project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path;
      return <section className={`project-group ${active ? "project-active" : ""}`} key={project.id}>
        <button className="project-heading" type="button" aria-label={`Open project ${name}`} aria-current={active ? "true" : undefined}
          disabled={disabled} title={project.path} onClick={() => onActivate(project.id)}>
          <span className="project-folder" aria-hidden="true">{active ? "▾" : "▸"}</span>
          <span className="project-name"><strong>{name}</strong><small>{project.path}</small></span>
          {project.attentionCount > 0 ? <span className="project-badge attention" title="Tasks need your attention">{project.attentionCount}</span>
            : project.runningCount > 0 ? <span className="project-badge running" title="Running in this project">{project.runningCount}</span>
              : <span className={`mini-status phase-${project.phase}`} aria-label={project.phase} />}
        </button>
        {active ? children : <div className="project-task-preview">
          {project.recentTasks.filter((task) => task.status === "active").slice(0, 4).map((task) => <button key={task.id}
            type="button" disabled={disabled} title={task.title} aria-label={`Open ${task.title} in ${name}`}
            onClick={() => onActivate(project.id, task.id)}>{task.title}</button>)}
          {!project.tasksLoaded ? <span>Open to load tasks</span> : project.recentTasks.length === 0 ? <span>No tasks yet</span> : null}
        </div>}
      </section>;
    })}
  </div>;
}
