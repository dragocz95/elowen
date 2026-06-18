'use client';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { ProjectsView } from '../../modules/projects/ProjectsView';

export default function ProjectsPage() {
  return (
    <ModuleShell moduleId="projects">
      <ProjectsView />
    </ModuleShell>
  );
}
