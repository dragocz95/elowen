'use client';
import { Code2 } from 'lucide-react';
import { useProjects } from '../../lib/queries';
import { useProjectFilter } from '../../lib/useProjectFilter';
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
  const projects = useProjects();
  const { selectedProject, setProject } = useProjectFilter('orca.editor.project');
  const list = projects.data ?? [];
  const projectId = selectedProject === 'all' ? (list[0]?.id ?? null) : selectedProject;

  return (
    <>
      <ModuleHeader title={t.page.editor} icon={Code2}>
        <ProjectFilterPills value={selectedProject} onChange={setProject} />
      </ModuleHeader>
      {projectId == null
        ? <EmptyState title={t.editor.noProjects} description={t.editor.noProjectsDescription} icon={Code2} />
        : <ProjectEditor key={projectId} projectId={projectId} />}
    </>
  );
}
