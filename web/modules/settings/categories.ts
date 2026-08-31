import { Boxes, BrainCircuit, Database, LayoutDashboard, Puzzle, Server, Trash2, type LucideIcon } from 'lucide-react';

/** Single source of truth for the Settings sections. Labels are resolved by the consumer via
 *  `t.settings[id]`, so this stays i18n-free; order defines the page's section navigation. Plugin-owned
 *  settings are contributed at runtime instead of being hard-coded here. A stale ?cat= deep-link to any
 *  removed section falls back to 'system' via the isSectionId validator. */
export const SETTINGS_CATEGORY_VALUES = ['system', 'brain', 'models', 'plugins', 'memory', 'dashboard', 'data'] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_VALUES)[number];

export const SETTINGS_SECTIONS: { id: SettingsCategory; icon: LucideIcon }[] = [
  { id: 'system', icon: Server },
  { id: 'brain', icon: BrainCircuit },
  { id: 'models', icon: Boxes },
  { id: 'plugins', icon: Puzzle },
  { id: 'memory', icon: Database },
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'data', icon: Trash2 },
];
