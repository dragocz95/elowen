/** WHAT THE ACCOUNT PAGE IS MADE OF, named once.
 *
 *  The account page is a set of sections addressed as `/account?cat=<id>`. Two surfaces have to agree on
 *  that set: the sidebar, which draws one sub-item per section, and the page itself, which mounts the
 *  matching panel and titles its hero. They used to be the same surface — the page carried its own
 *  section rail — so the list could live inside the view. The rail is gone and the menu is the only way
 *  between sections, which makes a second copy of this order a menu that offers a section the page
 *  cannot open.
 *
 *  Plugin-contributed sections are handed IN rather than resolved here: they come from two live queries
 *  and belong to whoever already holds them. What this module owns is the core sections, their labels,
 *  and the one order both surfaces draw. */
import { Bell, Boxes, Brain, KeyRound, Sparkles, SquareTerminal, UserCog, type LucideIcon } from 'lucide-react';
import type { LocaleDict } from '../../lib/i18n/types';
import { parsePluginAccountSectionId, parsePluginUserConfigSectionId } from './pluginSections';

export const CORE_ACCOUNT_SECTIONS = ['profile', 'security', 'notifications', 'personality', 'cli', 'terminal', 'memory'] as const;
export type CoreAccountSection = typeof CORE_ACCOUNT_SECTIONS[number];
export type AccountSection = CoreAccountSection | `plugin-account:${string}` | `plugin-user-config:${string}`;

/** Whether a stored or linked id names a section at all. Shape only — whether the plugin behind a
 *  `plugin-*` id is still installed is a question for the listing, and the page asks it separately. */
export const isAccountSection = (value: string): value is AccountSection =>
  (CORE_ACCOUNT_SECTIONS as readonly string[]).includes(value)
  || parsePluginAccountSectionId(value) !== null
  || parsePluginUserConfigSectionId(value) !== null;

export interface AccountSectionDescriptor {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string;
}

/** Where a section of the account page is addressed. The one rule, so a menu row and a cross-link cannot
 *  disagree about the query parameter or spell the route two ways. */
export const accountSectionHref = (id: string): string => `/account?cat=${id}`;

/** Every section, in draw order: who you are, then whatever the installed plugins contribute, then the
 *  rest of the personal settings — the runtime and what shapes it, the operational pair, and the
 *  cosmetic terminal last. */
export function accountSections(t: LocaleDict, contributed: readonly AccountSectionDescriptor[]): AccountSectionDescriptor[] {
  return [
    { id: 'profile', icon: UserCog, label: t.account.tabProfile, description: t.account.profileHint },
    ...contributed,
    { id: 'cli', icon: Boxes, label: t.account.tabCli, description: t.cli.modelRolesHint },
    { id: 'memory', icon: Brain, label: t.account.tabMemory, description: t.help.memoryRecall },
    { id: 'personality', icon: Sparkles, label: t.account.tabPersonality, description: t.personality.intro },
    { id: 'notifications', icon: Bell, label: t.account.tabNotifications, description: t.help.pushEnable },
    { id: 'security', icon: KeyRound, label: t.account.tabSecurity, description: t.account.passwordHint },
    { id: 'terminal', icon: SquareTerminal, label: t.account.tabTerminal, description: t.terminal.colorsHelp },
  ];
}
