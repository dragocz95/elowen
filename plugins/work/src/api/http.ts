import type { PluginApiRequest, PluginHttpResponse } from '../../../../src/plugins/api.js';

export type ApiAuth = PluginApiRequest['auth'];

/** JSON response shorthand for the plugin API handlers (mirrors the core `c.json(body, status)`). */
export const json = (body: object, status = 200): PluginHttpResponse => ({ status, body });

/** Whether the verified caller may see/operate the given project. `accessibleProjects` is the
 *  dispatcher's precomputed tenancy set: null = unrestricted (admin / open mode), an agent-scoped token
 *  carries its live working set — the same semantics the core canAccessProject had. */
export const canProject = (auth: ApiAuth, projectId: number): boolean =>
  auth.accessibleProjects === null || auth.accessibleProjects.includes(projectId);

/** A path under one of this plugin's mounts that no route here serves. A mount is a PREFIX, so a request
 *  for an endpoint that does not exist still reaches the handler of its family root; core answered such a
 *  path with a plain 404 — and, for an agent-scoped token, with the 403 its verb allow-list gave before
 *  routing ever happened. Keep both answers: an agent must not learn the shape of what it may not call. */
export const unknownSubPath = (auth: ApiAuth): PluginHttpResponse =>
  auth.tokenScope === 'agent' ? json({ error: 'forbidden' }, 403) : json({ error: 'not found' }, 404);
