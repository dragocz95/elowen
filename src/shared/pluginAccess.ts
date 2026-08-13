/**
 * Single source of truth for per-user PLUGIN permission — the sibling of `shared/execs.ts`, shared by
 * the API dispatcher, the plugin UI listing, the brain's tool policy and the plugin runtime.
 *
 * A plugin is reachable by everyone unless its manifest opts in with `userGrantable`. For one that
 * does, non-admins are deny-by-default and an admin hands it out per user (`users.granted_plugins`).
 *
 * Note the deliberate asymmetry with `allowed_execs`, where an EMPTY personal list means "everything
 * the global list allows". Here an empty list means "nothing granted": an exec list narrows a catalog
 * the user already reaches, whereas a grant opens a subsystem they otherwise cannot. Inverting either
 * one would silently widen access, so the two never share a helper.
 */

/** The user fields the predicates need — structural, so both the daemon's `User` and a row projection fit. */
export interface PluginAccessUser {
  is_admin: boolean;
  granted_plugins: readonly string[];
}

/** The manifest fields the predicates need. */
export interface PluginAccessManifest {
  name: string;
  userGrantable?: boolean;
}

/**
 * Whether `user` may use `plugin`. `user` null/undefined = open mode (no user store / setup), which is
 * permitted exactly as the exec predicate does it — the surrounding route guards own that case.
 * Admins always pass: a grant list is how an admin delegates, not a way to lock themselves out.
 */
export function isPluginAllowedForUser(
  user: PluginAccessUser | null | undefined,
  plugin: PluginAccessManifest | null | undefined,
): boolean {
  if (!plugin?.userGrantable) return true;
  if (!user || user.is_admin) return true;
  return user.granted_plugins.includes(plugin.name);
}

/** The subset of `plugins` a user may use — the display filter behind menus and pickers. Same rule as
 *  the gate (unlike execs, where the picker narrows for admins too: a grant is not a preference). */
export function allowedPluginsForUser<T extends PluginAccessManifest>(
  user: PluginAccessUser | null | undefined,
  plugins: readonly T[],
): T[] {
  return plugins.filter((p) => isPluginAllowedForUser(user, p));
}

/** Plugin names an admin can hand out — the source for the users-panel grant picker. */
export function grantablePluginNames(plugins: readonly PluginAccessManifest[]): string[] {
  return plugins.filter((p) => p.userGrantable).map((p) => p.name);
}
