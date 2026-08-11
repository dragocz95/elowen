import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '../shared/logger.js';
import { stripControlChars } from '../shared/text.js';
import type { ThemeBrand } from '../shared/brand.js';

/** White-label theme packages: one folder per theme under `<dataDir>/themes/<name>/`, holding a
 *  `theme.json` manifest plus optional PNG assets. A theme is DATA, never code — no CSS or JS file is
 *  read from it, and every value is validated here before any public endpoint may serve it, because the
 *  payload is exposed unauthenticated (the login screen needs the brand before any token exists) and
 *  the web injects the color values into a `<style>` tag. */

const log = logger('theme');

/** One lowercase path segment, no traversal possible. Slightly looser than the plugin/marketplace name
 *  rule (`{1,63}` there — two chars minimum): a one-letter theme name is fine. Exported so the config
 *  store reuses the SAME object for `theme.active` — the two grammars drifting apart would fail silently
 *  (a name one layer accepts and the other rejects resolves to the built-in brand with no error). */
export const THEME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The only files a theme may serve as assets. A fixed whitelist (not a pattern) because these names are
 *  part of the public URL contract and nothing else in the folder must ever be reachable. */
export const THEME_ASSET_FILES = ['logo.png', 'icon.png', 'icon-192.png', 'icon-512.png'] as const;
export type ThemeAssetFile = (typeof THEME_ASSET_FILES)[number];

/** The design-token suffixes a theme may override — exactly the `--color-*` names in the web's
 *  tokens.css `@theme` block, plus `accent-rgb` (the `R G B` triple the shadow/glow tokens compose
 *  with). A contract test keeps this list a subset of tokens.css so a theme can never invent a token
 *  the UI does not consume. */
export const THEME_COLOR_KEYS = [
  'bg', 'document', 'surface', 'elevated', 'overlay', 'border', 'border-strong',
  'accent', 'accent-hot', 'ember', 'accent-rgb',
  'text', 'text-muted', 'text-subtle',
  'danger', 'success', 'warning', 'error', 'info', 'approve', 'cancelled',
] as const;

const COLOR_KEY_SET = new Set<string>(THEME_COLOR_KEYS);
/** Hex colors only — the value lands inside a server-rendered `<style>` block, so the grammar is kept
 *  too narrow to ever close the declaration or smuggle another one in. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** `accent-rgb` is a bare `R G B` triple (composed into `rgb(<triple> / a)` by the token definitions). */
const RGB_TRIPLE_RE = /^\d{1,3} \d{1,3} \d{1,3}$/;
/** Font stacks are free-ish text but still CSS-embedded: names, quotes, commas, hyphens — no braces,
 *  no semicolons, no url()/expression() material. */
const FONT_STACK_RE = /^[\w \-,'"]{1,200}$/;
/** An UNBALANCED quote in a font stack opens a CSS bad-string that eats the rest of the rule — not an
 *  escape, but it silently kills every later declaration in the injected `<style>` block. */
function quotesBalanced(v: string): boolean {
  return (v.match(/"/g) ?? []).length % 2 === 0 && (v.match(/'/g) ?? []).length % 2 === 0;
}

const MANIFEST_MAX_BYTES = 32 * 1024;
/** Exported because the asset route re-checks the byte count AFTER reading — the stat-time check alone
 *  is TOCTOU-racy (a file grown between stat and read would be buffered and cached whole). */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_LANG_RE = /^[a-z]{2}$/;
const TEXT_KEY_RE = /^[a-zA-Z0-9.]{1,64}$/;
const TEXT_VALUE_MAX = 200;
const NAME_MAX = 60;

export interface ThemeManifest {
  displayName: string;
  brand: ThemeBrand;
  colors: Record<string, string>;
  fonts: { sans?: string; mono?: string };
  /** Per-locale shallow UI text overrides (documented key: `appName`). */
  text: Record<string, Record<string, string>>;
}

export interface ThemeInfo {
  name: string;
  displayName: string;
  valid: boolean;
  /** Why an invalid manifest was rejected — shown in the admin list so a hand-written theme is debuggable. */
  error?: string;
}

export interface LoadedTheme {
  name: string;
  manifest: ThemeManifest;
  /** Asset files actually present on disk (and within the size limit). */
  assets: ThemeAssetFile[];
  /** Content-version fingerprint over the manifest and asset mtimes — the public payload's cache-buster. */
  version: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Brand names cross two sensitive sinks: terminals (control chars would be a title/OSC injection) and
 *  the system prompt, where `agentName` lands inside `<name>…</name>` — so `<`/`>` are stripped too, or a
 *  40-char name like `</name><system>…` could break the prompt's structure. No legitimate display name
 *  contains either class. */
function cleanName(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const cleaned = stripControlChars(v).replace(/[<>]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

/** Validate + normalize a parsed theme.json. Throws with a human reason on the first violation —
 *  a theme is either fully valid or not offered at all, so a partially-applied brand can never ship. */
export function sanitizeThemeManifest(raw: unknown): ThemeManifest {
  if (!isRecord(raw)) throw new Error('theme.json must be a JSON object');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('unsupported theme version (expected 1)');
  const displayName = cleanName(raw.displayName, NAME_MAX);
  if (!displayName) throw new Error('displayName is required');

  const brandRaw = isRecord(raw.brand) ? raw.brand : {};
  const brand: ThemeBrand = {};
  const agentName = cleanName(brandRaw.agentName, 40);
  const productName = cleanName(brandRaw.productName, 60);
  if (agentName) brand.agentName = agentName;
  if (productName) brand.productName = productName;

  const colors: Record<string, string> = {};
  if (raw.colors !== undefined) {
    if (!isRecord(raw.colors)) throw new Error('colors must be an object');
    for (const [key, value] of Object.entries(raw.colors)) {
      if (!COLOR_KEY_SET.has(key)) throw new Error(`unknown color key "${key}"`);
      if (typeof value !== 'string') throw new Error(`color "${key}" must be a string`);
      const ok = key === 'accent-rgb'
        ? RGB_TRIPLE_RE.test(value) && value.split(' ').every((n) => Number(n) <= 255)
        : HEX_COLOR_RE.test(value);
      if (!ok) throw new Error(`color "${key}" must be ${key === 'accent-rgb' ? 'an "R G B" triple (0-255 each)' : 'a hex color'}`);
      colors[key] = value;
    }
  }

  const fonts: ThemeManifest['fonts'] = {};
  if (raw.fonts !== undefined) {
    if (!isRecord(raw.fonts)) throw new Error('fonts must be an object');
    for (const slot of ['sans', 'mono'] as const) {
      const value = raw.fonts[slot];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !FONT_STACK_RE.test(value) || !quotesBalanced(value)) throw new Error(`font "${slot}" must be a plain font-family string with balanced quotes`);
      fonts[slot] = value;
    }
  }

  const text: ThemeManifest['text'] = {};
  if (raw.text !== undefined) {
    if (!isRecord(raw.text)) throw new Error('text must be an object');
    for (const [lang, entries] of Object.entries(raw.text)) {
      if (!TEXT_LANG_RE.test(lang)) throw new Error(`text locale "${lang}" must be a two-letter code`);
      if (!isRecord(entries)) throw new Error(`text.${lang} must be an object`);
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (!TEXT_KEY_RE.test(key)) throw new Error(`text key "${key}" is not a valid dictionary key`);
        if (typeof value !== 'string') throw new Error(`text.${lang}.${key} must be a string`);
        out[key] = stripControlChars(value).slice(0, TEXT_VALUE_MAX);
      }
      text[lang] = out;
    }
  }

  return { displayName, brand, colors, fonts, text };
}

interface CacheEntry {
  mtimeMs: number;
  manifest: ThemeManifest | null;
  error?: string;
}

export class ThemeStore {
  /** Keyed by theme name; invalidated per-read when theme.json's mtime moves, so a hand-edited theme
   *  applies on the next request without any restart. */
  private cache = new Map<string, CacheEntry>();

  constructor(private themesDir: string) {}

  /** Every folder under themes/ with a well-formed name, validity included — the admin picker list. */
  list(): ThemeInfo[] {
    let entries: string[];
    try {
      entries = readdirSync(this.themesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { return []; } // no themes/ dir yet — a fresh install with no custom theme
    return entries
      .filter((name) => THEME_NAME_RE.test(name))
      .sort()
      .map((name) => {
        const entry = this.load(name);
        if (entry?.manifest) return { name, displayName: entry.manifest.displayName, valid: true };
        return { name, displayName: name, valid: false, ...(entry?.error ? { error: entry.error } : {}) };
      });
  }

  /** The validated theme, or null when it does not exist or fails validation (never throws — the brand
   *  resolver and the public endpoint fall back to the built-in default). Assets are re-stat'ed on every
   *  call — deliberately OUTSIDE the manifest cache, so swapping a logo.png alone still moves `version`
   *  (the public payload's cache-buster) without the user having to touch theme.json. */
  get(name: string): LoadedTheme | null {
    if (!THEME_NAME_RE.test(name)) return null;
    const entry = this.load(name);
    if (!entry?.manifest) return null;
    const assets: ThemeAssetFile[] = [];
    const assetStamps: string[] = [];
    for (const file of THEME_ASSET_FILES) {
      try {
        // lstat, not stat: a SYMLINK at an asset name must not count. stat follows it, and a link like
        // `logo.png -> ../../elowen.db` would otherwise export any daemon-readable file ≤ 2 MiB through
        // the unauthenticated asset route. lstat reports the link itself, so isFile() rejects it.
        const stat = lstatSync(join(this.themesDir, name, file));
        if (stat.isFile() && stat.size <= ASSET_MAX_BYTES) {
          assets.push(file);
          assetStamps.push(`${file}:${stat.mtimeMs}:${stat.size}`);
        }
      } catch { /* asset absent — the built-in default covers it */ }
    }
    const version = createHash('sha256')
      .update(JSON.stringify(entry.manifest)).update('\0').update(assetStamps.join(','))
      .digest('hex').slice(0, 16);
    return { name, manifest: entry.manifest, assets, version };
  }

  /** Absolute path of a whitelisted asset of a VALID theme. Null for anything else: an unknown file
   *  name, a missing/oversized file, or an invalid theme. The file name is compared against the fixed
   *  whitelist, never joined from user input as a pattern — path traversal has no surface here. */
  resolveAsset(name: string, file: string): { path: string; mtimeMs: number } | null {
    const theme = this.get(name);
    if (!theme || !(THEME_ASSET_FILES as readonly string[]).includes(file)) return null;
    if (!theme.assets.includes(file as ThemeAssetFile)) return null;
    const path = join(this.themesDir, name, file);
    try {
      const stat = lstatSync(path); // no symlink following — see the asset loop in get()
      return stat.isFile() ? { path, mtimeMs: stat.mtimeMs } : null;
    } catch { return null; }
  }

  private load(name: string): CacheEntry | null {
    // The theme folder itself must be a REAL directory: a symlinked folder would make every path below
    // resolve inside an attacker-chosen tree (lstat on the leaf cannot see an intermediate link).
    try {
      if (!lstatSync(join(this.themesDir, name)).isDirectory()) return null;
    } catch { return null; }
    const manifestPath = join(this.themesDir, name, 'theme.json');
    let mtimeMs: number;
    try {
      const stat = lstatSync(manifestPath); // symlinked theme.json rejected below via isFile()
      if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) {
        const error = stat.size > MANIFEST_MAX_BYTES ? `theme.json exceeds ${MANIFEST_MAX_BYTES} bytes` : 'theme.json is not a file';
        return { mtimeMs: 0, manifest: null, error };
      }
      mtimeMs = stat.mtimeMs;
    } catch { return null; } // no manifest → not a theme
    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let entry: CacheEntry;
    try {
      entry = { mtimeMs, manifest: sanitizeThemeManifest(JSON.parse(readFileSync(manifestPath, 'utf-8'))) };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.warn(`theme "${name}" rejected: ${error}`);
      entry = { mtimeMs, manifest: null, error };
    }
    this.cache.set(name, entry);
    return entry;
  }
}
