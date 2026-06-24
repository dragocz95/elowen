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

/** Standalone code-editor page: the very same ProjectEditor that Projects opens as an overlay, here
 *  driven by the shared project-filter pills. The editor needs one concrete project, so an 'all' (or
 *  unset) filter falls back to the first accessible project. */
export function EditorView() {
  const { t } = useTranslation();
  const router = useRouter();
  const mobile = useMobile();
  const projects = useProjects();
  const { selectedProject, setProject } = useProjectFilter('orca.editor.project');
  const list = projects.data ?? [];
  const projectId = selectedProject === 'all' ? (list[0]?.id ?? null) : selectedProject;

  // On mobile the editor auto-fullscreens and covers the app nav, so without a way out it traps the
  // user. Give it an onClose that leaves the editor back to the app (history if any, else the
  // dashboard). On desktop the sidebar is always visible, so no close affordance is needed.
  const onClose = mobile
    ? () => { if (typeof window !== 'undefined' && window.history.length > 1) router.back(); else router.push('/dash'); }
    : undefined;

  return (
    <>
      <ModuleHeader title={t.page.editor} icon={Code2}>
        {/* The editor always edits one concrete project — never "All" — so drop that pill and bind the
            picker to the resolved project id (falls back to the first accessible project). */}
        <ProjectFilterPills value={projectId ?? 'all'} onChange={setProject} includeAll={false} />
      </ModuleHeader>
      {projectId == null
        ? <EmptyState title={t.editor.noProjects} description={t.editor.noProjectsDescription} icon={Code2} />
        : <ProjectEditor key={projectId} projectId={projectId} onClose={onClose} />}
    </>
  );
}
