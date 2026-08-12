import { useEffect, useState } from 'react';
import { Code2 } from 'lucide-react';
import { runtime } from './runtime';
import { ProjectEditor } from './editor/ProjectEditor';

const { useProjects, usePluginStrings } = runtime().hooks;
const { ModuleHeader, EmptyState } = runtime().components;
const { navigate } = runtime();

function initialProjectId(): number | null {
  const value = new URLSearchParams(window.location.search).get('project');
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function EditorPage() {
  const projects = useProjects();
  const s = usePluginStrings('editor');
  const [requestedProject] = useState(initialProjectId);
  const [selectedProject, setSelectedProject] = useState<number | null>(requestedProject);
  const [commit] = useState(() => new URLSearchParams(window.location.search).get('commit'));
  const [working] = useState(() => new URLSearchParams(window.location.search).get('working') === '1');

  useEffect(() => {
    if (selectedProject == null && projects.data?.[0]) setSelectedProject(projects.data[0].id);
  }, [projects.data, selectedProject]);

  const projectId = projects.data?.some((project) => project.id === selectedProject) ? selectedProject : null;
  return (
    <>
      <ModuleHeader title={s.title ?? 'Editor'} icon={Code2} />
      <div className="flex h-[calc(100dvh-9rem)] min-h-[32rem] flex-col gap-3 px-4 pb-4 md:px-6">
        <label className="flex max-w-sm items-center gap-2 text-sm text-text-muted">
          <span>{s.project ?? 'Project'}</span>
          <select value={projectId ?? ''} onChange={(event) => setSelectedProject(Number(event.target.value) || null)} className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-text">
            {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.slug}</option>)}
          </select>
        </label>
        <div className="min-h-0 flex-1">
          {projectId == null
            ? <EmptyState title={s.empty ?? 'No available project'} icon={Code2} />
            : <ProjectEditor key={`${projectId}:${commit ?? ''}:${working}`} projectId={projectId} initialCommit={commit} initialWorking={working} onClose={() => navigate('/projects')} fill />}
        </div>
      </div>
    </>
  );
}
