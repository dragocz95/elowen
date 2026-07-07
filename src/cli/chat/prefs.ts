import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.js';

/** Local (per-machine) chat-TUI preferences. The terminal theme is a property of THIS terminal — dark
 *  themes on a light terminal differ per machine — so it persists beside the token cache instead of in
 *  the per-user server settings. Corrupt or missing file degrades to defaults, never crashes the TUI. */
export interface CliPrefs { theme?: string }

function prefsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'cli-prefs.json');
}

export function loadPrefs(env: NodeJS.ProcessEnv = process.env): CliPrefs {
  try {
    const parsed = JSON.parse(readFileSync(prefsFile(env), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CliPrefs) : {};
  } catch { return {}; }
}

/** Merge `patch` into the stored prefs. Best-effort — a read-only config dir must not break the TUI. */
export function savePrefs(patch: Partial<CliPrefs>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(dirname(prefsFile(env)), { recursive: true });
    writeFileSync(prefsFile(env), JSON.stringify({ ...loadPrefs(env), ...patch }));
  } catch { /* best-effort persistence */ }
}
