import { useRef, useState } from 'react';
import { Code2 } from 'lucide-react';
import { runtime } from './runtime';
import { ProjectEditor } from './editor/ProjectEditor';

const { useProjects, usePluginStrings, useProjectFilter, useFillHeight, useMobile } = runtime().hooks;
const {
  ModuleHeader, EmptyState, WorkspacePage, CompactWorkspaceHeader, ProjectFilterPills,
  ControlSurfaceDocument, MotionPresence, MotionLayoutItem,
} = runtime().components;
const { navigate } = runtime();

/** A deep link from Projects or the Timeline opens one project — and optionally one commit or the
 *  working tree — instead of the remembered filter. */
function linkTarget(): { project: number | null; commit: string | null; working: boolean } {
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get('project'));
  return {
    project: Number.isInteger(id) && id > 0 ? id : null,
    commit: params.get('commit'),
    working: params.get('working') === '1',
  };
}

/** Standalone code-editor page: the very same ProjectEditor that Projects opens as an overlay, here
 *  driven by the shared project-filter pills. The editor needs one concrete project, so an 'all' (or
 *  unset) filter falls back to the first accessible project. */
export function EditorPage() {
  const s = usePluginStrings('editor');
  const mobile = useMobile();
  const projects = useProjects();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(surfaceRef);
  const { selectedProject, setProject } = useProjectFilter('elowen.editor.project');
  const [link] = useState(linkTarget);
  const list = projects.data ?? [];
  const filtered = selectedProject === 'all' ? (list[0]?.id ?? null) : selectedProject;
  // A deep link wins over the remembered filter, but only while its project is one this user can see.
  const projectId = link.project != null && list.some((item) => item.id === link.project) ? link.project : filtered;
  const project = list.find((item) => item.id === projectId) ?? null;

  // On mobile the editor auto-fullscreens and covers the app nav, so without a way out it traps the
  // user. Give it an onClose that leaves the editor back to the app (history if any, else the
  // dashboard). On desktop the sidebar is always visible, so no close affordance is needed.
  const onClose = mobile
    ? () => { if (window.history.length > 1) window.history.back(); else navigate('/dash'); }
    : undefined;

  return (
    <>
      <ModuleHeader title={s.title} icon={Code2} />
      <WorkspacePage>
        <CompactWorkspaceHeader
          eyebrow={s.workspaceEyebrow}
          title={s.title}
          description={s.workspaceIntro}
          icon={Code2}
          status={project ? <span className="workspace-status">{s.workspaceReady.replace('{project}', project.slug)}</span> : undefined}
          action={<ProjectFilterPills value={projectId ?? 'all'} onChange={setProject} includeAll={false} variant="dropdown" />}
        />
        {/* The editor is sized to the window rather than to a fixed 70dvh: on a tall screen that left a
            band of dead space under it, and on a short one it pushed the page past the fold and wrapped
            the whole app in a scrollbar — around an editor that already has one of its own. */}
        <div ref={surfaceRef} className="workspace-content" style={fillHeight ? { height: fillHeight } : undefined}>
          <ControlSurfaceDocument className="editor-control-surface">
            <MotionPresence mode="wait">
              {projectId == null
                ? <MotionLayoutItem key="empty" className="h-full"><EmptyState title={s.noProjects} description={s.noProjectsDescription} icon={Code2} /></MotionLayoutItem>
                : <MotionLayoutItem key={`${projectId}:${link.commit ?? ''}:${link.working}`} className="h-full"><ProjectEditor projectId={projectId} initialCommit={link.commit} initialWorking={link.working} onClose={onClose} fill /></MotionLayoutItem>}
            </MotionPresence>
          </ControlSurfaceDocument>
        </div>
      </WorkspacePage>
    </>
  );
}
