import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setPluginPromptSources } from '../../src/prompts/index.js';
import { setPluginPromptCatalog, type PromptCatalogEntry } from '../../src/prompts/catalog.js';

// A plugin owns whole prompt templates (the agents plugin owns worker*/agent-guide*/pilot/overseer/
// code-review/decision-*). In production the daemon installs the plugin prompt overlay right after
// loading plugins (brainCore), so the core renderer NEVER resolves those names without it. This setup
// installs the same overlay for every test file — a test that exercises overlay mechanics still swaps
// it out itself.
//
// It DISCOVERS the catalogs instead of naming one: this file runs before every single test file, so a
// static import of a plugin would make the entire core suite unbootable the moment that plugin is
// renamed, moved out of the repo or unbundled — thousands of tests that have nothing to do with it.
// Only the repo's own plugins are scanned; the core suite must never depend on what an operator
// happens to have installed in their data directory.

const pluginsDir = join(import.meta.dirname, '..', '..', 'plugins');

/** A prompt catalog module exports its entry list and the absolute dir holding the `.md` templates.
 *  Matched by SHAPE rather than by export name so the convention is "a plugin may ship
 *  `src/promptCatalog.ts`", not "a plugin must use the names this file happens to know". */
function readCatalog(mod: Record<string, unknown>, file: string): { entries: PromptCatalogEntry[]; dir: string } {
  const values = Object.values(mod);
  const entries = values.find((v): v is PromptCatalogEntry[] =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof (e as PromptCatalogEntry)?.name === 'string'));
  const dir = values.find((v): v is string => typeof v === 'string' && existsSync(v));
  // Loud, not skipped: a catalog that exports neither would otherwise leave its templates unresolvable
  // in every test, and the failure would surface far from its cause.
  if (!entries || !dir) throw new Error(`${file}: expected an exported prompt-entry array and an exported template directory path`);
  return { entries, dir };
}

const catalog: PromptCatalogEntry[] = [];
const sources = new Map<string, string>();

for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  const file = join(pluginsDir, plugin.name, 'src', 'promptCatalog.ts');
  if (!existsSync(file)) continue;
  const { entries, dir } = readCatalog(await import(file) as Record<string, unknown>, file);
  for (const entry of entries) {
    catalog.push({ ...entry });
    sources.set(entry.name, join(dir, `${entry.name}.md`));
  }
}

setPluginPromptCatalog(catalog);
setPluginPromptSources(sources);
