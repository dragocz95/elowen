'use client';
import { Code2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useProjects } from '../../lib/queries';
import { useProjectFilter } from '../../lib/useProjectFilter';
import { useMobile } from '../../lib/useMobile';
import { ProjectFilterPills } from '../../components/ui/ProjectFilterPills';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { ProjectEditor } from '../projects/editor/ProjectEditor';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { WorkspaceHeader, WorkspacePage } from '../../components/ui/WorkspacePrimitives';

/** Standalone code-editor page: the very same ProjectEditor that Projects opens as an overlay, here
 *  driven by the shared project-filter pills. The editor needs one concrete project, so an 'all' (or
 *  unset) filter falls back to the first accessible project. */
export function EditorView() {
  const { t } = useTranslation();
  const router = useRouter();
  const mobile = useMobile();
  const projects = useProjects();
  const { selectedProject, setProject } = useProjectFilter('elowen.editor.project');
  const list = projects.data ?? [];
  const projectId = selectedProject === 'all' ? (list[0]?.id ?? null) : selectedProject;
  const project = list.find((item) => item.id === projectId) ?? null;

  // On mobile the editor auto-fullscreens and covers the app nav, so without a way out it traps the
  // user. Give it an onClose that leaves the editor back to the app (history if any, else the
  // dashboard). On desktop the sidebar is always visible, so no close affordance is needed.
  const onClose = mobile
    ? () => { if (typeof window !== 'undefined' && window.history.length > 1) router.back(); else router.push('/dash'); }
    : undefined;

  return (
    <>
      <ModuleHeader title={t.page.editor} icon={Code2} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.editor.workspaceEyebrow}
          title={t.page.editor}
          description={t.editor.workspaceIntro}
          icon={Code2}
          status={project ? <span className="workspace-status">{t.editor.workspaceReady.replace('{project}', project.slug)}</span> : undefined}
          action={<ProjectFilterPills value={projectId ?? 'all'} onChange={setProject} includeAll={false} variant="dropdown" />}
        />
        <div className="workspace-content">
          <MotionPresence mode="wait">
            {projectId == null
              ? <MotionLayoutItem key="empty"><EmptyState title={t.editor.noProjects} description={t.editor.noProjectsDescription} icon={Code2} /></MotionLayoutItem>
              : <MotionLayoutItem key={projectId}><ProjectEditor projectId={projectId} onClose={onClose} fill /></MotionLayoutItem>}
          </MotionPresence>
        </div>
      </WorkspacePage>
    </>
  );
}
