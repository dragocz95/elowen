import { Boxes, BrainCircuit, LayoutDashboard, Puzzle, Server, Trash2, type LucideIcon } from 'lucide-react';

/** Single source of truth for the Settings sections. Labels are resolved by the consumer via
 *  `t.settings[id]`, so this stays i18n-free; order defines the page's section navigation. Plugin-owned
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
