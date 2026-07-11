import { Boxes, Plug, BrainCircuit, Database, Puzzle, Bot, Github, Server, Trash2, type LucideIcon } from 'lucide-react';

/** Single source of truth for the Settings sections — consumed by the Settings page (which section to
 *  render) AND the sidebar (the nested sub-items under "Nastavení"). Labels are resolved by the consumer
 *  via `t.settings[id]`, so this stays i18n-free. Order defines both the sidebar list and the page. */
export const SETTINGS_CATEGORY_VALUES = ['models', 'providers', 'brain', 'memory', 'plugins', 'autopilot', 'github', 'data', 'system'] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_VALUES)[number];

export const SETTINGS_SECTIONS: { id: SettingsCategory; icon: LucideIcon }[] = [
  { id: 'models', icon: Boxes },
  { id: 'providers', icon: Plug },
  { id: 'brain', icon: BrainCircuit },
  { id: 'memory', icon: Database },
  { id: 'plugins', icon: Puzzle },
  { id: 'autopilot', icon: Bot },
  { id: 'github', icon: Github },
  { id: 'data', icon: Trash2 },
  { id: 'system', icon: Server },
];
