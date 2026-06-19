import { cpSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Installing the orca plugin into a (same-host) Hermes instance: copy the plugin dir,
 *  write its per-instance config, and enable it in Hermes's config.yaml — all without
 *  rewriting that YAML (we edit it as text so comments/formatting survive). */

const PLUGIN_NAME = 'orca';

export interface HermesStatus {
  home: string;
  exists: boolean;
  pluginsDir: boolean;
  pluginInstalled: boolean;
  enabled: boolean;
}

export interface HermesInstallInput {
  home: string;        // Hermes home (contains plugins/ and config.yaml), e.g. /var/www/.hermes
  pluginSrc: string;   // path to the plugin source dir (…/hermes-plugin/orca)
  url: string;         // orca API base URL to bake into the plugin config
  token: string;       // orca bearer token
  timeout?: number;
}

export interface HermesInstallResult {
  pluginDir: string;
  copied: boolean;
  alreadyEnabled: boolean;
  enabled: boolean;
  backedUp: boolean;
}

/** Plugin names listed under `plugins.enabled:` in a Hermes config.yaml (text-parsed,
 *  so we never have to round-trip the whole document). */
export function enabledPlugins(text: string): string[] {
  const out: string[] = [];
  let inPlugins = false;
  let inEnabled = false;
  for (const line of text.split('\n')) {
    if (/^plugins:\s*$/.test(line)) { inPlugins = true; inEnabled = false; continue; }
    if (!inPlugins) continue;
    if (line.trim() === '') continue;
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
    if (indent === 0) { inPlugins = false; inEnabled = false; continue; } // next top-level key
    const key = line.match(/^\s*([A-Za-z0-9_-]+):\s*$/);
    if (key) { inEnabled = key[1] === 'enabled'; continue; }
    if (inEnabled) {
      const item = line.match(/^\s*-\s*(\S+)/);
      if (item?.[1]) out.push(item[1]);
    }
  }
  return out;
}

/** Insert `- <name>` into the plugins.enabled list, preserving the rest of the file.
 *  Returns the original text unchanged if already present (or if there's no enabled list). */
export function enableInConfig(text: string, name = PLUGIN_NAME): { text: string; changed: boolean; already: boolean } {
  if (enabledPlugins(text).includes(name)) return { text, changed: false, already: true };
  const lines = text.split('\n');
  let inPlugins = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^plugins:\s*$/.test(line)) { inPlugins = true; continue; }
    if (!inPlugins) continue;
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
    if (line.trim() !== '' && indent === 0) break; // left the plugins block without finding enabled
    if (/^\s*enabled:\s*$/.test(line)) {
      // Match the existing item indentation (look at the following list item), else enabled's indent.
      const enabledIndent = line.match(/^(\s*)/)?.[1] ?? '';
      const next = (lines[i + 1] ?? '').match(/^(\s*)-\s/);
      const itemIndent = next?.[1] ?? enabledIndent;
      lines.splice(i + 1, 0, `${itemIndent}- ${name}`);
      return { text: lines.join('\n'), changed: true, already: false };
    }
  }
  return { text, changed: false, already: false }; // no enabled list to extend
}

/** Render the plugin's per-instance config.yaml (small fixed shape — no YAML lib needed). */
export function renderPluginConfig(url: string, token: string, timeout = 30): string {
  const esc = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '# Written by orca — Settings → Hermes → Install plugin.',
    'orca:',
    `  url: ${esc(url)}`,
    `  token: ${esc(token)}`,
    `  timeout: ${Number.isFinite(timeout) ? timeout : 30}`,
    '',
  ].join('\n');
}

export function hermesStatus(home: string): HermesStatus {
  const pluginDir = join(home, 'plugins', PLUGIN_NAME);
  const cfgPath = join(home, 'config.yaml');
  let enabled = false;
  try { if (existsSync(cfgPath)) enabled = enabledPlugins(readFileSync(cfgPath, 'utf8')).includes(PLUGIN_NAME); } catch { /* ignore */ }
  return {
    home,
    exists: existsSync(home) && safeIsDir(home),
    pluginsDir: existsSync(join(home, 'plugins')),
    pluginInstalled: existsSync(pluginDir),
    enabled,
  };
}

export function installHermesPlugin(input: HermesInstallInput): HermesInstallResult {
  const { home, pluginSrc, url, token } = input;
  if (!existsSync(home) || !safeIsDir(home)) throw new Error('hermes home not found');
  const pluginsDir = join(home, 'plugins');
  if (!existsSync(pluginsDir)) throw new Error('hermes plugins dir not found');
  if (!existsSync(pluginSrc)) throw new Error('plugin source not found');

  // Copy the plugin (skip Python caches), overwriting any prior install.
  const pluginDir = join(pluginsDir, PLUGIN_NAME);
  cpSync(pluginSrc, pluginDir, { recursive: true, filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc') });

  // Per-instance config with the orca url + token.
  writeFileSync(join(pluginDir, 'config.yaml'), renderPluginConfig(url, token, input.timeout), 'utf8');

  // Enable it in Hermes config.yaml (text-edit, backing up first).
  const cfgPath = join(home, 'config.yaml');
  let alreadyEnabled = false; let changed = false; let backedUp = false;
  if (existsSync(cfgPath)) {
    const original = readFileSync(cfgPath, 'utf8');
    const res = enableInConfig(original);
    alreadyEnabled = res.already;
    if (res.changed) {
      writeFileSync(`${cfgPath}.orca-bak`, original, 'utf8'); backedUp = true;
      writeFileSync(cfgPath, res.text, 'utf8'); changed = true;
    }
  }
  return { pluginDir, copied: true, alreadyEnabled, enabled: alreadyEnabled || changed, backedUp };
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
