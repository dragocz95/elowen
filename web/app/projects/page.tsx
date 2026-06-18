'use client';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { ProjectsView } from '../../modules/projects/ProjectsView';

export default function ProjectsPage() {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="projects">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.projects} />
        <ProjectsView />
      </div>
    </ModuleShell>
  );
}
