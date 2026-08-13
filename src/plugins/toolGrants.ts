import { isPluginAllowedForUser } from '../shared/pluginAccess.js';
import type { PluginAccessUser } from '../shared/pluginAccess.js';
import type { PluginRegistry } from './registry.js';

/**
 * The tool names a user must not reach because they hold no grant for the plugin that owns them.
 *
 * Expressed as tool NAMES rather than as a new gating layer on purpose: a ToolPolicy `deny` list is
 * already applied after `allow`, already generalizes to every tool, and is already enforced at execute
 * time by the shared gate — so a grant needs no mechanism of its own, only the right names.
 *
 * Only plugins that opted into `userGrantable` can contribute names here, so a daemon whose plugins all
 * predate grants produces an empty list and behaves exactly as before.
 *
 * `user` is REQUIRED, unlike in the HTTP predicate where a missing user means open mode: inside a turn
 * there is always either an account or an anonymous sender, and an anonymous one must be described as
 * `{ is_admin, granted_plugins: [] }` so it fails closed instead of inheriting open-mode permissiveness.
 */
export function ungrantedPluginTools(
  user: PluginAccessUser,
  registry: PluginRegistry | undefined,
): string[] {
  if (!registry || registry.userGrantable.size === 0) return [];
  const denied: string[] = [];
  for (const [tool, owner] of registry.toolOwner) {
    if (!registry.userGrantable.has(owner)) continue;
    if (!isPluginAllowedForUser(user, { name: owner, userGrantable: true })) denied.push(tool);
  }
  return denied;
}
