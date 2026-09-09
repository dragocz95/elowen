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

/** The plugin that owns SkillLoad — a reserved cross-plugin contract (see RESERVED_TOOL_OWNERS), named here
 * because the skills catalog and the skills PROMPT text both have to agree on it. */
export const SKILLS_PLUGIN = 'skills';

/** Whether SkillLoad is composed for a session AND permitted by `toolPolicy`: the one authority behind the
 * `<available_skills>` catalog, `/skill:name` expansion and the skills plugin's own loading guidance, so
 * none of them can announce what another one withholds. `composed` is a lookup rather than a list because
 * each caller asks its own registry — the spawner the definitions it has just built, a live turn the
 * grant-filtered set for the writer. */
export function skillLoadVisible(
  toolOwner: ReadonlyMap<string, string> | undefined,
  composed: (name: string) => boolean,
  toolPolicy?: ToolPolicy,
): boolean {
  // The catalog and its loader are one capability, even when a skill came from another plugin. SkillLoad is
  // a reserved cross-plugin contract; accepting a same-named tool from another owner would be a false positive.
  if (toolOwner?.get('SkillLoad') !== SKILLS_PLUGIN) return false;
  return composed('SkillLoad') && toolPermitted('SkillLoad', toolPolicy);
}

/** The skills ToolSearch may REPORT for one turn: entries from the LIVE `skillCatalog` host control,
 *  reduced to what the model could actually act on. Same one-capability rule as the prompt catalog —
 *  a turn that may not load skills gets no suggestions — and manual-only entries stay hidden, exactly
 *  as formatSkillsForPrompt drops them from the announcement. Resolved per call so a plugin reload's
 *  fresh catalog and the turn's live policy are both honored; never a captured registry generation. */
export async function searchableSkills(
  plugins: PluginRegistry | undefined,
  composed: (name: string) => boolean,
  toolPolicy?: ToolPolicy,
): Promise<{ name: string; description: string }[]> {
  const control = plugins?.control('skillCatalog');
  if (!plugins || !control) return [];
  if (!skillLoadVisible(plugins.toolOwner, composed, toolPolicy)) return [];
  return control.visibleSkills()
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({ name: skill.name, description: skill.description }));
}

/** The plugin system-prompt fragments a session carries. The skills plugin's `<skill_loading>` block is an
 * instruction — load every advertised skill through SkillLoad — so a session whose policy hides that tool is
 * left with a standing order it can only fail, and nothing in the prompt says why. Dropped only where ONE
 * policy governs the whole session: a shared room decides per writer, and its live per-turn catalog already
 * narrows what it announces to each of them. */
export function sessionPromptFragments(
  fragments: readonly string[],
  owners: readonly string[],
  skillLoad: 'advertised' | 'hidden' | 'per-writer',
): string[] {
  if (skillLoad !== 'hidden') return [...fragments];
  return fragments.filter((_, index) => owners[index] !== SKILLS_PLUGIN);
}

async function resolvedTurnSkills(
  deps: TurnSkillDeps,
  contributionUserId: number | null,
  toolPolicy?: ToolPolicy,
): Promise<{ plugins: PluginRegistry; skills: PluginSkill[] } | null> {
  const plugins = await deps.plugins?.();
  if (!plugins) return null;
  const user = contributionUserId == null ? null : deps.users.get(contributionUserId);
  const visible = skillLoadVisible(
    plugins.toolOwner,
    (name) => plugins.toolsFor(contributionUserId, user).some((tool) => tool.name === name),
    toolPolicy,
  );
  if (!visible) return null;
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
