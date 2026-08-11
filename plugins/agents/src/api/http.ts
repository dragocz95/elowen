import type { PluginApiRequest, PluginHttpResponse } from '../../../../src/plugins/api.js';

export type ApiAuth = PluginApiRequest['auth'];

/** JSON response shorthand for the plugin API handlers (mirrors the core `c.json(body, status)`). */
export const json = (body: object, status = 200): PluginHttpResponse => ({ status, body });

/** Whether the verified caller may see/operate the given project. `accessibleProjects` is the
 *  dispatcher's precomputed tenancy set: null = unrestricted (admin / open mode), an agent-scoped
 *  token carries its live working set — the same semantics the core canAccessProject had. */
export const canProject = (auth: ApiAuth, projectId: number): boolean =>
  auth.accessibleProjects === null || auth.accessibleProjects.includes(projectId);
