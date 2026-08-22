/** THE definition of "administers this instance" — the authority behind every owner-gated surface (the
 *  shell and its background processes, publishing a host path into a conversation, instance MCP servers,
 *  raw platform APIs, instance-scoped automation).
 *
 *  It lives here as a pure rule rather than in one of its callers because it is minted on two independent
 *  surfaces: inside a turn (`IdentityResolver.isOwner`, which knows the configured platform owner) and on
 *  an authenticated HTTP call (`dispatchPluginApi`, which knows the request's account). Those two used to
 *  disagree — HTTP compared the caller against the FIRST admin by creation order, so a second admin passed
 *  every owner gate in a tool and was refused the identical gate on a plugin route.
 *
 *  An ADMIN ACCOUNT counts as an operator: admins already hold all-access policy, which makes the path
 *  guard skip project roots entirely, so they read and write every byte on the box through the ordinary
 *  file tools regardless. Refusing them the owner surfaces withheld convenience, not capability.
 *
 *  It is NOT the same authority as an admin-mapped ROOM ROLE. The `isAdmin` argument must come from the
 *  ACCOUNT (`users.is_admin`); a role policy carrying `admin: true` for a whole channel must never be
 *  passed in here, or anyone able to type into that channel would reach these surfaces.
 *
 *  With no operator configured at all (single-user daemon, tests, first run) every known account counts,
 *  preserving the pre-identity behaviour. An absent account fails closed. */
export function operatesInstance(opts: { userId?: number; ownerId?: number; isAdmin?: boolean }): boolean {
  if (opts.userId === undefined) return false;
  if (opts.ownerId === undefined) return true;
  return opts.userId === opts.ownerId || opts.isAdmin === true;
}
