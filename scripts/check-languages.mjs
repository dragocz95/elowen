/**
 * Translation consistency check (`npm run languages-check`) — runs before every build and in CI.
 *
 * Locales are DETECTED, never listed here: every `web/lib/i18n/dictionaries/<lang>.ts` (plus any
 * `plugins/<name>/i18n/<lang>.json`) brings its language into the checked set automatically.
 * English is the reference everywhere — the `en` dictionary on the web, the manifest's own
 * strings for plugins.
 *
 * Web dictionaries:
 *  - every key present in `en` must exist in each other locale, and vice versa (no orphans),
 *  - the value shapes must match (string vs nested object),
 *  - `{placeholder}` tokens must be the same set in both locales (`{s}`, the English plural
 *    suffix, may legitimately be absent from a translation).
 *
 * Plugin manifests (plugins/<name>/): each detected locale's `i18n/<lang>.json` must translate
 * ALL manifest strings (description + each config field's label/hint/option labels) and must not
 * carry orphan keys for fields or options that no longer exist in the manifest.
 *
 * Loaded via `node --experimental-strip-types` so the TS dictionaries import directly.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

// ---------------------------------------------------------------------------
// Web dictionaries — one <lang>.ts per locale, named-exported as the locale code.
// ---------------------------------------------------------------------------
const dictDirUrl = new URL('../web/lib/i18n/dictionaries/', import.meta.url);
const dictFiles = readdirSync(fileURLToPath(dictDirUrl)).filter((file) => /^[a-z]{2}\.ts$/.test(file)).sort();

const dictionaries = {};
for (const file of dictFiles) {
  const lang = file.slice(0, 2);
  const mod = await import(new URL(file, dictDirUrl));
  if (!mod[lang] || typeof mod[lang] !== 'object') {
    errors.push(`web: dictionaries/${file} must export \`const ${lang}\``);
    continue;
  }
  dictionaries[lang] = mod[lang];
}
if (!dictionaries.en) {
  console.error('languages-check: web/lib/i18n/dictionaries/en.ts (the reference locale) not found');
  process.exit(1);
}

const placeholders = (value) => new Set(String(value).match(/\{[a-zA-Z0-9_]+\}/g) ?? []);

function compareDicts(a, b, aName, bName, path = '') {
  for (const key of Object.keys(a)) {
    const at = a[key];
    const bt = b[key];
    const keyPath = path ? `${path}.${key}` : key;
    if (!(key in b)) {
      errors.push(`web: ${keyPath} exists in ${aName} but is missing in ${bName}`);
      continue;
    }
    const aObj = at !== null && typeof at === 'object';
    const bObj = bt !== null && typeof bt === 'object';
    if (aObj !== bObj) {
      errors.push(`web: ${keyPath} is ${aObj ? 'an object' : 'a string'} in ${aName} but ${bObj ? 'an object' : 'a string'} in ${bName}`);
      continue;
    }
    if (aObj) compareDicts(at, bt, aName, bName, keyPath);
  }
}

function comparePlaceholders(enDict, other, lang, path = '') {
  for (const key of Object.keys(enDict)) {
    const at = enDict[key];
    const bt = other[key];
    if (bt === undefined) continue; // reported by compareDicts already
    const keyPath = path ? `${path}.${key}` : key;
    if (at !== null && typeof at === 'object' && bt !== null && typeof bt === 'object') {
      comparePlaceholders(at, bt, lang, keyPath);
    } else if (typeof at === 'string' && typeof bt === 'string') {
      const ap = placeholders(at);
      const bp = placeholders(bt);
      // `{s}` is the English plural suffix (replaced with ''/'s' in code); other languages
      // pluralize with different wording, so it may legitimately be absent from a translation.
      const missing = [...ap].filter((p) => !bp.has(p) && p !== '{s}');
      const extra = [...bp].filter((p) => !ap.has(p));
      if (missing.length > 0 || extra.length > 0) {
        errors.push(`web: ${keyPath} placeholder mismatch (en: ${[...ap].join(' ') || '—'} | ${lang}: ${[...bp].join(' ') || '—'})`);
      }
    }
  }
}

const webLocales = Object.keys(dictionaries).filter((lang) => lang !== 'en');
for (const lang of webLocales) {
  compareDicts(dictionaries.en, dictionaries[lang], 'en', lang);
  compareDicts(dictionaries[lang], dictionaries.en, lang, 'en');
  comparePlaceholders(dictionaries.en, dictionaries[lang], lang);
}

// ---------------------------------------------------------------------------
// Dead keys — dictionary leaves no web source ever references.
// A leaf counts as used when its NAME appears anywhere in the web sources (conservative: a name
// shared between namespaces marks all of them used — zero false positives over completeness).
// Namespaces indexed with computed keys (`t.ns[value]`) can't be seen by a name scan; list them
// here WITH the access site so the exemption stays verifiable.
// ---------------------------------------------------------------------------
const DYNAMIC_NAMESPACES = [
  'activity',          // TaskContextLine: t.activity[activity]
  'agent',             // AgentStatusDot: t.agent[state]
  'agents',            // AgentsTable: t.agents[a.status]
  'brain.limits',      // BrainLimitsModal: t.brain.limits[f.key] + t.brain.limits[`${f.key}Hint`]
  'brain.runtime',     // RuntimeLimitsModal: t.brain.runtime[f.key] + t.brain.runtime[`${f.key}Hint`]
  'brain.toolLoading.reason', // ToolDeferralModal: t.brain.toolLoading.reason[reason]
  'brain.retention',   // MemoryRetentionModal: t.brain.retention[field.key] + t.brain.retention[`${field.key}Hint`]
  'brain.types',       // BrainSection: t.brain.types[type] — daemon-driven provider type set
  'kanban',            // KanbanBoard: t.kanban[col.labelKey]
  'nav',               // useShellNavigation/TopBar: t.nav[world.id] / t.nav[module.id]
  'page',              // CommandPalette: t.page[m.id]
  'plugins',           // PluginsSection: t.plugins[CATEGORY_META[c].key]
  'providers',         // settings/page + pickers: t.providers[p.id]
  'settings',          // settings/page deck sections: t.settings[id] per category
  'stats.contextCategory', // StatsModal: t.stats.contextCategory[category.id] — the context breakdown's categories
  'terminal.fonts',    // TerminalSection: t.terminal.fonts[id]
  'terminal.palette',  // TerminalSection: t.terminal.palette[key] — 21 palette slot labels
];

function collectLeaves(dict, path = '', out = []) {
  for (const [key, value] of Object.entries(dict)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (value !== null && typeof value === 'object') collectLeaves(value, keyPath, out);
    else out.push({ path: keyPath, name: key });
  }
  return out;
}

const webDir = join(root, 'web');
const sourceRoots = ['app', 'components', 'modules', 'lib'].map((dir) => join(webDir, dir));
const dictionariesDir = fileURLToPath(dictDirUrl);
let sourceBlob = '';
function readTree(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.startsWith(dictionariesDir.replace(/\/$/, ''))) continue; // the dictionaries themselves
    const stats = statSync(full);
    if (stats.isDirectory()) readTree(full);
    else if (/\.(tsx?|mjs)$/.test(entry)) sourceBlob += readFileSync(full, 'utf-8') + '\n';
  }
}
for (const dir of sourceRoots) readTree(dir);
// Plugin web bundles (plugins/*/web-src) consume the core dictionaries through the runtime's
// useTranslation — their key references are as live as the app's own, so scan them too.
for (const name of readdirSync(join(root, 'plugins'))) {
  const webSrc = join(root, 'plugins', name, 'web-src');
  if (existsSync(webSrc) && statSync(webSrc).isDirectory()) readTree(webSrc);
}
const sourceIdentifiers = new Set(sourceBlob.match(/[A-Za-z0-9_]+/g));

for (const leaf of collectLeaves(dictionaries.en)) {
  if (DYNAMIC_NAMESPACES.some((ns) => leaf.path.startsWith(`${ns}.`))) continue;
  if (!sourceIdentifiers.has(leaf.name)) {
    errors.push(`web: ${leaf.path} is never referenced by any web source (dead key — delete it from every locale, or add its namespace to DYNAMIC_NAMESPACES if it is accessed with a computed key)`);
  }
}

// ---------------------------------------------------------------------------
// Plugin manifests + i18n overrides
// ---------------------------------------------------------------------------
const pluginsDir = join(root, 'plugins');
const pluginNames = readdirSync(pluginsDir).filter((name) => {
  const dir = join(pluginsDir, name);
  return statSync(dir).isDirectory() && existsSync(join(dir, 'elowen-plugin.json'));
});

// Every locale the app knows anywhere (web dictionaries beyond en, or any plugin's i18n file)
// must be complete in EVERY plugin — a partially-translated locale is worse than none.
const pluginLocales = new Set(webLocales);
for (const name of pluginNames) {
  const dir = join(pluginsDir, name, 'i18n');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const match = /^([a-z]{2})\.json$/.exec(file);
    if (match) pluginLocales.add(match[1]);
  }
}

for (const name of pluginNames) {
  const dir = join(pluginsDir, name);
  const manifest = JSON.parse(readFileSync(join(dir, 'elowen-plugin.json'), 'utf-8'));
  const schema = Array.isArray(manifest.configSchema) ? manifest.configSchema : [];
  const fieldByKey = new Map(schema.map((field) => [field.key, field]));

  for (const locale of [...pluginLocales].sort()) {
    const file = join(dir, 'i18n', `${locale}.json`);
    if (!existsSync(file)) {
      errors.push(`plugin ${name}: missing i18n/${locale}.json`);
      continue;
    }
    let i18n;
    try {
      i18n = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      errors.push(`plugin ${name}: i18n/${locale}.json is not valid JSON`);
      continue;
    }

    // Orphans — keys that translate nothing in the manifest anymore.
    for (const key of Object.keys(i18n)) {
      if (key !== 'description' && key !== 'fields' && key !== 'web') {
        errors.push(`plugin ${name} (${locale}): unknown top-level key "${key}" (only description/fields/web are read)`);
      }
    }
    // Inside the `web` block only these four are read (pluginUi.ts localized()); anything else is a
    // typo that silently translates nothing — the same orphan rule the top-level keys get.
    for (const key of Object.keys(i18n.web ?? {})) {
      if (!['label', 'nav', 'settings', 'strings'].includes(key)) {
        errors.push(`plugin ${name} (${locale}): unknown web key "${key}" (only label/nav/settings/strings are read)`);
      }
    }
    // The world's own name in the left menu (manifest `web.label`): coverage BOTH ways, like every other
    // menu string. A plugin that declares a label and a locale that does not translate it renders the
    // English word among translated menu entries; a label translated for a manifest that no longer
    // declares one is an orphan.
    if (manifest.web?.label && !i18n.web?.label) errors.push(`plugin ${name} (${locale}): missing web.label translation`);
    if (i18n.web?.label && !manifest.web?.label) errors.push(`plugin ${name} (${locale}): web.label has no matching manifest web.label`);
    // Browser-UI menu labels (manifest `web` block): every override must name a declared nav route /
    // settings id, and every declared entry needs a translation — same rule as fields.
    const webNavRoutes = new Set((manifest.web?.nav ?? []).map((n) => n.route ?? ''));
    const webSettingsIds = new Set((manifest.web?.settings ?? []).map((s) => s.id));
    for (const route of Object.keys(i18n.web?.nav ?? {})) {
      if (!webNavRoutes.has(route)) errors.push(`plugin ${name} (${locale}): web.nav["${route}"] has no matching manifest web.nav route`);
    }
    for (const id of Object.keys(i18n.web?.settings ?? {})) {
      if (!webSettingsIds.has(id)) errors.push(`plugin ${name} (${locale}): web.settings.${id} has no matching manifest web.settings id`);
    }
    for (const route of webNavRoutes) {
      if (!i18n.web?.nav?.[route]) errors.push(`plugin ${name} (${locale}): missing web.nav["${route}"] translation`);
    }
    for (const id of webSettingsIds) {
      if (!i18n.web?.settings?.[id]) errors.push(`plugin ${name} (${locale}): missing web.settings.${id} translation`);
    }
    // Bundle view strings (manifest `web.strings`): same coverage rule — every manifest key needs a
    // translation, and an i18n key that no longer exists in the manifest is an orphan.
    const webStringKeys = new Set(Object.keys(manifest.web?.strings ?? {}));
    for (const key of Object.keys(i18n.web?.strings ?? {})) {
      if (!webStringKeys.has(key)) errors.push(`plugin ${name} (${locale}): web.strings.${key} has no matching manifest web.strings key`);
    }
    for (const key of webStringKeys) {
      if (!i18n.web?.strings?.[key]) errors.push(`plugin ${name} (${locale}): missing web.strings.${key} translation`);
    }
    for (const [key, override] of Object.entries(i18n.fields ?? {})) {
      const field = fieldByKey.get(key);
      if (!field) {
        errors.push(`plugin ${name} (${locale}): fields.${key} has no matching configSchema field`);
        continue;
      }
      const optionValues = new Set((field.options ?? []).map((option) => option.value));
      for (const value of Object.keys(override.options ?? {})) {
        if (!optionValues.has(value)) {
          errors.push(`plugin ${name} (${locale}): fields.${key}.options.${value} has no matching option in the manifest`);
        }
      }
    }

    // Coverage — every English string in the manifest needs a translation.
    if (typeof manifest.description === 'string' && manifest.description.trim() !== '' && !i18n.description) {
      errors.push(`plugin ${name} (${locale}): missing description translation`);
    }
    for (const field of schema) {
      const override = i18n.fields?.[field.key];
      if (typeof field.label === 'string' && field.label.trim() !== '' && !override?.label) {
        errors.push(`plugin ${name} (${locale}): missing fields.${field.key}.label`);
      }
      if (typeof field.hint === 'string' && field.hint.trim() !== '' && !override?.hint) {
        errors.push(`plugin ${name} (${locale}): missing fields.${field.key}.hint`);
      }
      for (const option of field.options ?? []) {
        if (typeof option.label === 'string' && option.label.trim() !== '' && !override?.options?.[option.value]) {
          errors.push(`plugin ${name} (${locale}): missing fields.${field.key}.options.${option.value}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
if (errors.length > 0) {
  console.error(`languages-check: ${errors.length} problem(s)\n`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
const localeList = [...new Set([...webLocales, ...pluginLocales])].sort().join(', ');
console.log(`languages-check: OK — locales [${localeList}] vs en: web dictionaries in sync, ${pluginNames.length} plugins covered`);
