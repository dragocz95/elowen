'use client';
import { usePersistentState } from './usePersistentState';
import { useProjects } from './queries';

/** A persisted project key is either 'all' or a numeric project id — a static shape, so it validates
 *  on mount without waiting for the (async) project list to load. */
const KEY_OK = (v: string) => v === 'all' || /^\d+$/.test(v);

/** Persisted project-filter selection shared by Tasks and Kanban — the single source of truth for
 *  "which project is the list scoped to, remembered across reloads". Restores the stored project via
 *  a static key check (not the async project list, which would reject it on first render), and clamps
 *  to 'all' once the list is known if the stored project no longer exists (a deleted project must not
 *  leave an invisible active filter returning an empty list). */
export function useProjectFilter(storageKey: string): {
  selectedProject: number | 'all';
  setProject: (value: number | 'all') => void;
} {
  const projects = useProjects();
  const [projectKey, setProjectKey] = usePersistentState<string>(storageKey, 'all', KEY_OK);
  const asNum: number | 'all' = projectKey === 'all' ? 'all' : Number(projectKey);
  const selectedProject: number | 'all' =
    asNum === 'all' ? 'all'
    // While the list is still loading keep the stored id (the scoped fetch is fine if it exists);
    // once loaded, an unknown id falls back to 'all'.
    : projects.data && !projects.data.some((p) => p.id === asNum) ? 'all'
    : asNum;
  return {
    selectedProject,
    setProject: (value) => setProjectKey(value === 'all' ? 'all' : String(value)),
  };
}
