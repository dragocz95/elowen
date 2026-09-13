import { Boxes } from 'lucide-react';
import { ProjectEnvironmentSettings } from './ProjectEnvironmentSettings';
import { runtime, type Project } from './runtime';

/** The Project drawer's Environments panel.
 *
 *  A managed project owns a persistent machine, and managing it is what this panel is for. A host
 *  project has no machine of its own: it is the checkout the conversation opens, so the panel states
 *  that rather than drawing an empty register. The panel is declared once for every project, so the
 *  branch has to live here — core decides which panels exist, not which of them apply. */
export function ProjectEnvironmentPanel({ project }: { project: Project }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  if (project.executionKind === 'managed') return <ProjectEnvironmentSettings key={project.id} project={project} />;
  return <C.EmptyState title={s.projectHostTitle} description={s.projectHostHint} icon={Boxes} />;
}
