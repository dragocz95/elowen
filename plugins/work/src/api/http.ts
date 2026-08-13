import type { PluginApiRequest, PluginHttpResponse } from '../../../../src/plugins/api.js';

export type ApiAuth = PluginApiRequest['auth'];

/** JSON response shorthand for the plugin API handlers (mirrors the core `c.json(body, status)`). */
export const json = (body: object, status = 200): PluginHttpResponse => ({ status, body });

/** Whether the verified caller may see/operate the given project — the core canAccessProject rule,
 *  rebuilt from the dispatcher's tenancy block. `accessibleProjects` is that block's precomputed set:
 *  an agent-scoped token carries its live working set, a tenant its assignments, and `null` means "not
 *  scoped". `null` covers TWO different callers, which is why it is not a blanket allow: the admin and
 *  open mode (auth off entirely — one identity, everything reachable, `admin` true), but also SETUP
 *  MODE, where the users store exists and holds nobody yet, so the request arrives with no identity at
 *  all (`admin` false). Core refused that caller every per-project route (`!!u && …`); it must keep
 *  refusing, or an onboarding daemon lets an unauthenticated request write into any project. LIST
 *  scoping is a separate question and stays on the raw set, exactly as core had it. */
export const canProject = (auth: ApiAuth, projectId: number): boolean =>
  (auth.accessibleProjects === null ? auth.admin : auth.accessibleProjects.includes(projectId));

/** A path under one of this plugin's mounts that no route here serves. A mount is a PREFIX, so a request
 *  for an endpoint that does not exist still reaches the handler of its family root; core answered such a
 *  path with a plain 404 — and, for an agent-scoped token, with the 403 its verb allow-list gave before
 *  routing ever happened. Keep both answers: an agent must not learn the shape of what it may not call. */
export const unknownSubPath = (auth: ApiAuth): PluginHttpResponse =>
  auth.tokenScope === 'agent' ? json({ error: 'forbidden' }, 403) : json({ error: 'not found' }, 404);
