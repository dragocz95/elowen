import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitSha } from '../../src/shared/gitSha.js';

// A plugin compile unit may take only TYPES from core, so whatever it needs at RUNTIME it carries as
// its own copy. Those copies have to be held in step by hand, which is what this file is for. It
// DISCOVERS them rather than naming the plugins that have one: the previous version checked the editor
// and nothing else, so the work plugin could arrive with two fresh copies and no guard at all.
//
// Drift here is silent in the worst direction. The editor extraction narrowed its hash shape to
// /^[0-9a-f]{7,64}$/, which still accepted every full hash — so nothing looked broken — while every
// abbreviated hash the UI passes through (git abbreviates to as few as 4) started returning an EMPTY
// diff instead of a commit.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `plugins/<name>/src/**` TypeScript file, so a new plugin's copy is covered the day it lands. */
function pluginSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (full.endsWith('.ts')) out.push(full);
    }
  };
  for (const plugin of readdirSync(resolve(repoRoot, 'plugins'))) {
    const src = resolve(repoRoot, 'plugins', plugin, 'src');
    try { if (statSync(src).isDirectory()) walk(src); } catch { /* a JavaScript plugin has no src/ */ }
  }
  return out;
}

const HEX_SHAPE = /\/\^\[0-9a-f\]\{(\d+),(\d+)\}\$\/i/;

const hexShape = (source: string): string => {
  const match = HEX_SHAPE.exec(source);
  if (!match) throw new Error('no hex-shape regex literal found');
  return `${match[1]},${match[2]}`;
};

/** Comparable form of a copied implementation: comments stripped (a copy documents why it exists, and
 *  that prose is allowed to differ) and whitespace flattened, so only the CODE is compared. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

/** One exported function, by name, from a module's source — signature and body. */
const fn = (source: string, name: string): string => {
  const asyncAt = source.indexOf(`export async function ${name}(`);
  const from = asyncAt === -1 ? source.indexOf(`export function ${name}(`) : asyncAt;
  if (from === -1) throw new Error(`no exported function ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', from); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return code(source.slice(from, i + 1));
  }
  throw new Error(`unterminated function ${name}`);
};

describe('plugin copies of core runtime code', () => {
  const hostGitSha = readFileSync(resolve(repoRoot, 'src/shared/gitSha.ts'), 'utf8');
  const copies = pluginSources().filter((f) => HEX_SHAPE.test(readFileSync(f, 'utf8')));

  it('finds the git-sha copies it is meant to guard', () => {
    // A guard that silently matches nothing is worse than no guard: it reports green forever.
    // The editor's copy left with the plugin when it moved to the registry; the equivalent check lives
    // there now (tests/editorGitShaParity.test.ts), comparing BEHAVIOUR against the published package,
    // because a registry checkout has the daemon's compiled dist/ but not its TypeScript sources.
    expect(copies.map((f) => relative(repoRoot, f)).sort()).toEqual([
      'plugins/work/src/lib/gitSha.ts',
    ]);
  });

  it.each(copies.map((f) => [relative(repoRoot, f), f]))('%s accepts exactly the hash shapes the host accepts', (_name, file) => {
    expect(hexShape(readFileSync(file, 'utf8'))).toBe(hexShape(hostGitSha));
  });

  it('covers the abbreviated hashes git itself produces', () => {
    const [min] = hexShape(hostGitSha).split(',').map(Number);
    expect(min).toBe(4);
    expect(isGitSha('c6e8')).toBe(true);
    expect(isGitSha('c6e8c59b')).toBe(true);
    expect(isGitSha('zzzz')).toBe(false);
    expect(isGitSha('--all')).toBe(false);
  });

  // Tools MOVED out of core promised to keep producing byte-identical requests and error text, and
  // that promise lives entirely in this copied-forward client: the headers, the GET/HEAD body rule and
  // the defensive parse that must never throw on a non-JSON body. DISCOVERED, not named — pinning one
  // plugin by hand is the exact mistake this file exists to end, and the next plugin to move a
  // REST-calling tool would otherwise inherit a copy nobody compares.
  const apiCopies = pluginSources().filter((f) => /export async function callElowenApi\(/.test(readFileSync(f, 'utf8')));

  it('finds the api-client copies it is meant to guard', () => {
    expect(apiCopies.map((f) => relative(repoRoot, f)).sort()).toEqual([
      'plugins/work/src/lib/apiClient.ts',
    ]);
  });

  it.each(apiCopies.map((f) => [relative(repoRoot, f), f]))('%s forwards HTTP exactly like the daemon client', (_name, file) => {
    const host = readFileSync(resolve(repoRoot, 'src/shared/apiClient.ts'), 'utf8');
    expect(fn(readFileSync(file, 'utf8'), 'callElowenApi')).toBe(fn(host, 'callElowenApi'));
  });
});
