import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { PluginAccessUser } from '../../shared/pluginAccess.js';

/** The `<available_skills>` announcement for ONE turn, built for the account whose personal contributions
 *  that turn may reach (`contributionOwnerForSession`). Used by the surface that cannot announce once at
 *  spawn — a shared room, where the writer changes between turns (see `announcesSkillsPerTurn`).
 *
 *  It is deliberately the WHOLE block, not the personal delta on top of a cached instance block. The
 *  authorisation this announcement promises is resolved per turn from one id; splitting the announcement
 *  across two places keyed on two different ids is precisely how a model ends up being told about a skill
 *  it cannot load. One block, one id, one decision.
 *
 *  `formatSkillsForPrompt` drops disable-model-invocation skills, so a manual-only skill is never named. */
export async function turnSkillsBlock(deps: {
  plugins?: () => Promise<PluginRegistry | undefined>;
  users: { get(userId: number): Partial<PluginAccessUser> | null | undefined };
  /** WHOSE personal skills this turn may load, or null for the instance-wide set alone. */
  contributionUserId: number | null;
}): Promise<string> {
  const plugins = await deps.plugins?.();
  if (!plugins) return '';
  const user = deps.contributionUserId == null ? null : deps.users.get(deps.contributionUserId);
  const skills = plugins.skillsFor(deps.contributionUserId, user);
  if (skills.length === 0) return '';
  // Block-framed with its own trailing blank line, like every other leading part of composeTurnPrompt —
  // that framing is what lets the parts be concatenated as-is rather than joined by a second opinion.
  return `${formatSkillsForPrompt(skills).trimEnd()}\n\n`;
}
