import { useEffect, useId, useState, type ReactNode } from "react";
import type { DesktopProject } from "../shared/contracts.js";
import { SESSION_PAGE_SIZE } from "./SessionList.js";

interface ProjectSidebarProps {
  projects: readonly DesktopProject[];
  activeId: string | undefined;
  selectedSessionId: string | undefined;
  revealKey: string;
  disabled: boolean;
  onActivate: (projectId: string, sessionId?: string) => void;
  onNewSession: () => void;
  children: (initialLimit: number) => ReactNode;
}

export function ProjectSidebar({ projects, activeId, ...props }: ProjectSidebarProps) {
  const { children } = props;
  if (projects.length === 0) return <>{children(SESSION_PAGE_SIZE)}</>;
  return <div className="project-list" aria-label="Projects">
    {projects.map((project) => <ProjectGroup key={project.id} project={project} active={project.id === activeId} {...props} />)}
  </div>;
}

function ProjectGroup({ project, active, selectedSessionId, revealKey, disabled, onActivate, onNewSession, children }:
  Omit<ProjectSidebarProps, "projects" | "activeId"> & { project: DesktopProject; active: boolean }) {
  const [expanded, setExpanded] = useState(active);
  const [initialLimit, setInitialLimit] = useState(SESSION_PAGE_SIZE);
  const contentId = useId();
  const name = project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path;
  const recentTasks = project.recentTasks.filter((task) => task.status === "active");
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active, selectedSessionId, revealKey]);
  const activate = (sessionId?: string) => {
    setExpanded(true);
    onActivate(project.id, sessionId);
  };
  const toggle = () => {
    setInitialLimit(SESSION_PAGE_SIZE);
    setExpanded((value) => !value);
  };
  return <section className={`project-group ${active ? "project-active" : ""}`}>
    <div className="project-heading-row">
      <button className="project-disclosure" type="button" aria-label={`${expanded ? "收起" : "展开"} ${name} 的会话`}
        aria-expanded={expanded} aria-controls={contentId} onClick={toggle}>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      <button className="project-heading" type="button" aria-label={`Open project ${name}`} aria-current={active ? "true" : undefined}
        aria-expanded={expanded} aria-controls={contentId}
        disabled={disabled} title={project.path} onClick={() => { if (active) toggle(); else { setInitialLimit(SESSION_PAGE_SIZE); activate(); } }}>
        <span className="project-name"><strong>{name}</strong></span>
        {project.attentionCount > 0 ? <span className="project-badge attention" title="Tasks need your attention">{project.attentionCount}</span>
          : project.runningCount > 0 ? <span className="project-badge running" title="Running in this project">{project.runningCount}</span>
            : <span className={`mini-status phase-${project.phase}`} aria-label={project.phase} />}
      </button>
      {active ? <button className="icon-button directory-new" type="button" aria-label={`在 ${name} 新建会话`} disabled={disabled}
        onClick={() => { setExpanded(true); onNewSession(); }}>+</button> : null}
    </div>
    <div id={contentId} hidden={!expanded}>
      {expanded ? active ? children(initialLimit) : <div className="project-task-preview">
        {recentTasks.slice(0, SESSION_PAGE_SIZE).map((task) => <button key={task.id}
          type="button" disabled={disabled} title={task.title} aria-label={`Open ${task.title} in ${name}`}
          onClick={() => { setInitialLimit(SESSION_PAGE_SIZE); activate(task.id); }}>{task.title}</button>)}
        {project.tasksLoaded && recentTasks.length === 0 && project.recentTasks.length < 8 ? <span>还没有会话</span> : null}
        {!project.tasksLoaded || recentTasks.length > SESSION_PAGE_SIZE || project.recentTasks.length === 8 ? <button className="session-list-more" type="button"
          disabled={disabled} onClick={() => { setInitialLimit(project.tasksLoaded ? SESSION_PAGE_SIZE * 2 : SESSION_PAGE_SIZE); activate(); }}>
          {project.tasksLoaded ? "展开更多会话" : "打开以查看会话"}</button> : null}
      </div> : null}
    </div>
  </section>;
}
