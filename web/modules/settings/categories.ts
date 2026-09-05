import { Boxes, BrainCircuit, LayoutDashboard, Puzzle, Server, Trash2, type LucideIcon } from 'lucide-react';
import type { LocaleDict } from '../../lib/i18n/types';

/** Single source of truth for the Settings sections. The order defines the sub-menu the sidebar draws
 *  under Settings and the panels the page mounts behind it. Plugin-owned
 *  settings are contributed at runtime instead of being hard-coded here. A stale ?cat= deep-link to any
 *  removed section falls back to 'system' via the isSectionId validator, unless {@link SECTION_ALIASES}
 *  names a successor for it. */
export const SETTINGS_CATEGORY_VALUES = ['system', 'brain', 'models', 'plugins', 'dashboard', 'data'] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_VALUES)[number];

/** Retired section ids and where their content actually went. Resolved BEFORE the validity check, so an
 *  old link, a bookmark or a remembered category lands on the successor rather than falling back to
 *  System. `memory` held nothing but the embedding and categorization models, which are now roles in
 *  Settings → Models. */
export const SECTION_ALIASES: Record<string, SettingsCategory> = { memory: 'models' };

export const SETTINGS_SECTIONS: { id: SettingsCategory; icon: LucideIcon }[] = [
  { id: 'system', icon: Server },
  { id: 'brain', icon: BrainCircuit },
  { id: 'models', icon: Boxes },
  { id: 'plugins', icon: Puzzle },
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'data', icon: Trash2 },
];

/** Where a settings section is addressed. The one rule, so the menu row, a cross-link and the page's own
 *  history rewrite cannot spell the same section three ways. */
export const settingsSectionHref = (id: string): string => `/settings?cat=${id}`;

export interface SettingsSectionDescriptor {
  id: SettingsCategory;
  icon: LucideIcon;
  label: string;
  description: string;
}

/** The sections with their translated names, resolved once for the two surfaces that show them: the
 *  sidebar's sub-menu and the page's own hero. The assistant's section is named after the assistant, so
 *  its label arrives already interpolated — this module stays free of the brand. */
export function settingsSections(t: LocaleDict, agentAiLabel: string): SettingsSectionDescriptor[] {
  const hints: Record<SettingsCategory, string> = {
    system: t.settings.systemSectionHint,
    brain: t.settings.brainSectionHint,
    models: t.settings.modelsSectionHint,
    plugins: t.settings.pluginsSectionHint,
    dashboard: t.settings.dashboardSectionHint,
    data: t.settings.dataSectionHint,
  };
  return SETTINGS_SECTIONS.map(({ id, icon }) => ({
    id,
    icon,
    label: id === 'brain' ? agentAiLabel : t.settings[id],
    description: hints[id],
  }));
}
