import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { formatSkillsForPrompt, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { PluginSkill } from '../../plugins/api.js';
import type { PluginAccessUser } from '../../shared/pluginAccess.js';
import { splitFrontmatter } from '../../shared/frontmatter.js';
import {
  currentContributionUserId,
  currentToolPolicy,
  toolPermitted,
  type ToolPolicy,
} from '../../plugins/policyContext.js';

interface TurnSkillDeps {
  plugins?: () => Promise<PluginRegistry | undefined>;
  users: { get(userId: number): Partial<PluginAccessUser> | null | undefined };
}

async function resolvedTurnSkills(
  deps: TurnSkillDeps,
  contributionUserId: number | null,
  toolPolicy?: ToolPolicy,
): Promise<{ plugins: PluginRegistry; skills: PluginSkill[] } | null> {
  const plugins = await deps.plugins?.();
  if (!plugins) return null;
  const user = contributionUserId == null ? null : deps.users.get(contributionUserId);
  // The catalog and its loader are one capability, even when a skill came from another plugin. SkillLoad is
  // a reserved cross-plugin contract; accepting a same-named tool from another owner would be a false positive.
  if (plugins.toolOwner.get('SkillLoad') !== 'skills') return null;
  if (!plugins.toolsFor(contributionUserId, user).some((tool) => tool.name === 'SkillLoad')) return null;
  if (!toolPermitted('SkillLoad', toolPolicy)) return null;
  return { plugins, skills: plugins.skillsFor(contributionUserId, user) };
}

/** The `<available_skills>` announcement for ONE turn, built from the same grant-, owner- and policy-filtered
 * catalog that SkillLoad and explicit `/skill:name` invocation use. */
export async function turnSkillsBlock(deps: TurnSkillDeps & {
  contributionUserId: number | null;
  toolPolicy?: ToolPolicy;
}): Promise<string> {
  const resolved = await resolvedTurnSkills(deps, deps.contributionUserId, deps.toolPolicy);
  if (!resolved || resolved.skills.length === 0) return '';
  // PI's formatter drops disable-model-invocation skills, so manual-only entries are never advertised.
  return `${formatSkillsForPrompt(resolved.skills).trimEnd()}\n\n`;
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function unavailableSkill(name: string): string {
  return `<skill-unavailable name="${xmlAttribute(name)}">\n`
    + `The user explicitly invoked this skill, but it is not available in the current turn. Continue without it and tell the user.\n`
    + '</skill-unavailable>';
}

/** Expand an explicit `/skill:name` against the LIVE catalog instead of PI's session-start snapshot.
 * Exported so grant revocation, policy denial and filesystem containment are regression-testable without a
 * provider call. Unknown or newly revoked skills become an explicit model-visible refusal rather than passing
 * through to PI, whose stale resource loader might otherwise expand them. */
export async function expandTurnSkillCommand(
  text: string,
  deps: TurnSkillDeps,
  contributionUserId: number | null,
  toolPolicy?: ToolPolicy,
): Promise<string> {
  if (!text.startsWith('/skill:')) return text;
  const spaceIndex = text.indexOf(' ');
  const name = (spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex)).trim();
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
  const resolved = await resolvedTurnSkills(deps, contributionUserId, toolPolicy);
  const skill = resolved?.skills.find((candidate) => candidate.name === name);
  if (!resolved || !skill) return unavailableSkill(name);

  const directory = resolved.plugins.skillCanonicalBaseDir(skill);
  let file: string;
  try { file = realpathSync(skill.filePath); } catch { return unavailableSkill(name); }
  if (directory === null || (file !== directory && !file.startsWith(directory + sep))) {
    return unavailableSkill(name);
  }

  try {
    const body = splitFrontmatter(readFileSync(file, 'utf-8')).body.trim();
    const skillBlock = `<skill name="${xmlAttribute(skill.name)}" location="${xmlAttribute(file)}">\n`
      + `References are relative to ${directory}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch {
    return unavailableSkill(name);
  }
}

/** Intercept PI input before its native static skill expansion. The AsyncLocal turn scope supplies the same
 * contribution owner and ToolPolicy that gate tool execution on owner chat, platform rooms and delegated turns. */
export function liveSkillCommandExtension(deps: TurnSkillDeps): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('input', async (event) => {
      if (!event.text.startsWith('/skill:')) return { action: 'continue' };
      const text = await expandTurnSkillCommand(
        event.text,
        deps,
        currentContributionUserId(),
        currentToolPolicy(),
      );
      return { action: 'transform', text, ...(event.images ? { images: event.images } : {}) };
    });
  };
}
