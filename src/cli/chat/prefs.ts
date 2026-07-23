import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../../shared/paths.js';
import type { ComposeLocale } from './composeLabels.js';

/** Local (per-machine) chat-TUI preferences. The terminal theme is a property of THIS terminal — dark
 *  themes on a light terminal differ per machine — so it persists beside the token cache instead of in
 *  the per-user server settings. Corrupt or missing file degrades to defaults, never crashes the TUI. */
export interface CliPrefs {
  theme?: string;
  /** Render the model's Thought rows in the transcript (default true) — toggled by `/reasoning show`. */
  showThoughts?: boolean;
  /** Custom keybinds: action id → chord spec (see DEFAULT_KEYBINDS in keys.ts for the grammar).
   *  Edited by hand; /keybinds lists the effective map and flags invalid entries. */
  keybinds?: Record<string, string>;
  /** Language for localized CLI action labels (the composing-tool hint). When unset the locale is
   *  auto-detected from the `LC_ALL`/`LC_MESSAGES`/`LANG` environment (see {@link resolveLocale}). */
  language?: ComposeLocale;
}

/** Where the prefs live. Hand-editing this file's `keybinds` map still works alongside the interactive
 *  /keybinds editor — both write the same shape. */
function prefsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'cli-prefs.json');
}

export function loadPrefs(env: NodeJS.ProcessEnv = process.env): CliPrefs {
  try {
    const parsed = JSON.parse(readFileSync(prefsFilePath(env), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CliPrefs) : {};
  } catch { return {}; }
}

/** The effective CLI locale: the explicit `language` pref when set, else auto-detected from the POSIX
 *  locale environment (`LC_ALL` → `LC_MESSAGES` → `LANG`, a `cs*`/`sk*` value meaning Czech/Slovak),
 *  else English. */
export function resolveLocale(prefs: CliPrefs, env: NodeJS.ProcessEnv = process.env): ComposeLocale {
  if (prefs.language === 'cs' || prefs.language === 'en' || prefs.language === 'sk') return prefs.language;
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  if (/^cs\b|^cs[_.@-]/i.test(raw)) return 'cs';
  if (/^sk\b|^sk[_.@-]/i.test(raw)) return 'sk';
  return 'en';
}

/** Merge `patch` into the stored prefs. Best-effort — a read-only config dir must not break the TUI. */
export function savePrefs(patch: Partial<CliPrefs>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(dirname(prefsFilePath(env)), { recursive: true });
    writeFileSync(prefsFilePath(env), JSON.stringify({ ...loadPrefs(env), ...patch }));
  } catch { /* best-effort persistence */ }
}
