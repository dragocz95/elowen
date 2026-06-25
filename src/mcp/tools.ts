import { callOrcaApi } from '../shared/apiClient.js';

/** The Orca MCP toolset, built over the single shared `callOrcaApi` core — exactly the same forward
 *  path as the `orca api` CLI verb, so there is no duplicated request logic and a new REST endpoint
 *  needs zero edits here. `orca_request` is the generic escape hatch (any endpoint works immediately);
 *  the typed helpers are thin fixed-route wrappers that exist only for nicer agent UX. */
export interface OrcaToolDeps { url: string; token: string; call?: typeof callOrcaApi }

export function makeOrcaTools(d: OrcaToolDeps) {
  const call = d.call ?? callOrcaApi;
  const req = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await call(method, path, body, { url: d.url, token: d.token });
    if (!r.ok) throw new Error(`orca ${r.status}: ${r.text || JSON.stringify(r.data)}`);
    return r.data;
  };
  return {
    orca_request: (a: { method: string; path: string; body?: unknown }) => req(a.method, a.path, a.body),
    orca_tasks: () => req('GET', '/tasks'),
    orca_create_task: (a: { title: string; project_id?: number; description?: string }) => req('POST', '/tasks', a),
    orca_plan: (a: { goal: string; project_id?: number }) => req('POST', '/tasks/plan', a),
    orca_sessions: () => req('GET', '/sessions'),
    orca_note_add: (a: { target: string; body: string }) => req('POST', '/notes', { scope: 'mission', target: a.target, body: a.body }),
    orca_notes: (a: { target: string }) => req('GET', `/notes?scope=mission&target=${encodeURIComponent(a.target)}`),
  };
}
