import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** elowen-plugin-shared is the one piece of this repository that ships to npm SEPARATELY and is then
 *  imported by plugins living in another repository. That makes three things breakable in ways nothing
 *  else here can catch:
 *
 *   - the daemon could be published against a version of the shared package that is not on npm, or one
 *     whose contents differ from what this checkout tested (a range like ^0.1.0 silently allows that);
 *   - the package could export a path that has no file behind it — invisible in this repo, where the
 *     workspace symlink makes every relative path work, and fatal for an installed plugin;
 *   - a plugin could import a subpath the package does not export, which again only fails once the
 *     plugin is installed rather than symlinked.
 *
 *  All three are cheap to assert and expensive to discover in production. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkgDir = join(repoRoot, 'packages', 'plugin-shared');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

const rootPkg = readJson(join(repoRoot, 'package.json'));
const sharedPkg = readJson(join(pkgDir, 'package.json'));
const declared = (rootPkg.dependencies as Record<string, string>)['elowen-plugin-shared'];
const exportsMap = sharedPkg.exports as Record<string, string>;

describe('elowen-plugin-shared package contract', () => {
  it('the daemon depends on the EXACT version this checkout contains', () => {
    // A range would let `npm i elowen` resolve a shared package this repo never ran a test against,
    // while every parity test here keeps passing against the local copy.
    expect(declared).toBe(sharedPkg.version);
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is a runtime dependency, not a dev one — an installed daemon needs it on disk', () => {
    expect((rootPkg.devDependencies as Record<string, string>)['elowen-plugin-shared']).toBeUndefined();
  });

  it('every export points at a file that exists, and every module is exported', () => {
    const files = readdirSync(pkgDir).filter((f) => f.endsWith('.mjs'));
    for (const [subpath, target] of Object.entries(exportsMap)) {
      expect(files, `${subpath} -> ${target}`).toContain(target.replace('./', ''));
    }
    // The reverse direction: a helper added to the package but left out of `exports` is unreachable for
    // an installed plugin, even though a relative import inside this repo would find it.
    const exported = new Set(Object.values(exportsMap).map((t) => t.replace('./', '')));
    expect([...files].filter((f) => !exported.has(f))).toEqual([]);
  });

  it('the published file list covers every exported module', () => {
    const files = new Set(sharedPkg.files as string[]);
    for (const target of Object.values(exportsMap)) expect(files).toContain(target.replace('./', ''));
  });

  // Every consumer of this package now lives in the plugin registry — the chat adapters and cronjob took
  // their imports with them. So this repo can no longer check "does a plugin import a subpath that
  // exists"; what it can still check is that the package it PUBLISHES is coherent, which the tests above
  // do. This one pins the remaining half of that: nothing bundled here reaches into the package by a
  // path it does not export, and — the part that would otherwise rot silently — the day something
  // bundled starts importing it again, that import is held to the same rule.
  it('nothing bundled imports a subpath the package does not export', () => {
    const specifiers = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); continue; }
        if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts')) continue;
        for (const m of readFileSync(path, 'utf-8').matchAll(/from '(elowen-plugin-shared[^']*)'/g)) {
          specifiers.add(m[1]!);
        }
      }
    };
    walk(join(repoRoot, 'plugins'));
    const valid = new Set(Object.keys(exportsMap).map((k) => k.replace('.', 'elowen-plugin-shared')));
    expect([...specifiers].filter((s) => !valid.has(s))).toEqual([]);
  });

  it('has at least one exported subpath to hold consumers to', () => {
    // Guards the guard above, which is now vacuous by design: with no bundled importer left, an empty
    // exports map would make it pass while proving nothing about the package we publish.
    expect(Object.keys(exportsMap).length).toBeGreaterThan(3);
  });
});
