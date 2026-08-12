import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { elowenClient } from '../../lib/elowenClient';
import { QUERY_KEYS } from '../../lib/queries';

/** The API client and the react-query cache keys are pure plumbing: nothing about them fails at runtime
 *  when a piece stops being used, so a wrapper for a route no component calls — or an invalidation for a
 *  key no query registers — sits there looking load-bearing and silently rots. Both are checked here
 *  against the real source tree, because both are only detectable by looking for the missing consumer. */

const WEB_ROOT = resolve(process.cwd());
const SOURCE_DIRS = ['app', 'components', 'lib', 'modules'];
const CLIENT = join(WEB_ROOT, 'lib', 'elowenClient.ts');
/** A plugin's browser bundle is a first-class consumer: it reaches the very same client through the UI
 *  runtime (`utils.elowenClient`), so a wrapper only the extracted work views call is live code, not a
 *  dead route. Scanning them here is what keeps this guard honest as pages move out of core. */
const PLUGIN_ROOT = resolve(WEB_ROOT, '..', 'plugins');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every bundle source under plugins/<name>/web-src, tests excluded (see the note in the first case). */
function pluginSources(): string[] {
  return readdirSync(PLUGIN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(PLUGIN_ROOT, entry.name, 'web-src');
      try { return walk(dir); } catch { return []; }
    })
    .filter((path) => !/\.test\.tsx?$/.test(path));
}

/** Both guards read call sites, and prose is not a call site: a method named in a doc comment has no
 *  consumer, and an `invalidateQueries()` written in a comment is not an invalidation. `[^:]` keeps
 *  `https://` inside a string from being mistaken for the start of a line comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Read a capture the pattern makes mandatory. Narrowed rather than asserted, so an edit that turns the
 *  group optional fails here with the offending match instead of at the use site. */
function captured(match: RegExpMatchArray, group: number): string {
  const value = match[group];
  if (value === undefined) throw new Error(`pattern matched "${match[0]}" without capture group ${group}`);
  return value;
}

const sources = [...SOURCE_DIRS.flatMap((dir) => walk(join(WEB_ROOT, dir))), ...pluginSources()]
  // The client cannot vouch for itself, and its own key-less source has nothing else the guards want.
  .filter((path) => path !== CLIENT)
  .map((path) => stripComments(readFileSync(path, 'utf8')));

// `(?<![\w$/])` drops the module specifier in `from './elowenClient'` — a path is not a reference. The
// trailing context is a lookahead so the match stays 12 characters wide: consuming it would swallow a
// second reference sitting on the same line.
const CLIENT_REFERENCE = /(?<![\w$/])elowenClient\b(?=([^\n]{0,32}))/g;
/** The shapes a reference is allowed to take: a property access (which names the method it uses), the
 *  named import (or runtime destructure) specifier that brought the binding in, and — in a plugin
 *  bundle, which is handed the client through the UI runtime rather than importing it — the property
 *  signature declaring the shape it narrowed the client to. A type member is not a call site. */
const CLIENT_ACCESS = /^\s*\.\s*([A-Za-z_$][\w$]*)/;
const CLIENT_IMPORT = /^\s*[,}]/;
const CLIENT_TYPE_MEMBER = /^\s*:\s*\{/;

describe('elowenClient surface', () => {
  // A method nothing calls is a dead route wrapper: it keeps a removed feature's endpoint and DTOs alive
  // across the whole web bundle. Matching the property ACCESS rather than the bare method name is what
  // makes this a real check — `ready` read as used for as long as that word appeared anywhere in the tree.
  // Tests are deliberately not scanned: a wrapper exercised only by its own transport test still has no
  // product consumer.
  it('has no method that no web source calls', () => {
    const called = new Set(
      sources.flatMap((src) => [...src.matchAll(CLIENT_REFERENCE)]
        .map((m) => CLIENT_ACCESS.exec(captured(m, 1)))
        .filter((access): access is RegExpExecArray => access !== null)
        .map((access) => captured(access, 1))),
    );
    expect(Object.keys(elowenClient).filter((name) => !called.has(name))).toEqual([]);
  });

  // Property access is the only shape the scan above can follow, so every other way of reaching the client
  // — an `as` alias, a rebinding, a destructure, a computed `elowenClient[name]` — would hide a consumer
  // from it. Those fail here rather than quietly turning the dead-method check into a guess.
  it('is reached only by direct property access', () => {
    const opaque = sources.flatMap((src) => [...src.matchAll(CLIENT_REFERENCE)]
      .map((m) => captured(m, 1))
      .filter((tail) => !CLIENT_ACCESS.test(tail) && !CLIENT_IMPORT.test(tail) && !CLIENT_TYPE_MEMBER.test(tail))
      .map((tail) => `elowenClient${tail}`));
    expect(opaque).toEqual([]);
  });
});

/** The head (first element) of each named key, so a `QUERY_KEYS.x` reference resolves to what it actually
 *  invalidates. Membership in QUERY_KEYS proves nothing on its own — a named key no query registers is
 *  exactly as dead as a literal one. */
const KEY_HEADS: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(QUERY_KEYS).map(([name, key]) => [name, key[0]]),
);

/** Every head named by one key expression — `['head', …]` literals and `QUERY_KEYS.x` references, wherever
 *  they sit in it, so a ternary key contributes both of its branches. */
function keyHeads(expression: string): string[] {
  const literals = [...expression.matchAll(/\[\s*'([a-z-]+)'/g)].map((m) => captured(m, 1));
  const named = [...expression.matchAll(/\bQUERY_KEYS\.(\w+)/g)].map((m) => {
    const name = captured(m, 1);
    const head = KEY_HEADS[name];
    if (head === undefined) throw new Error(`QUERY_KEYS.${name} does not exist`);
    return head;
  });
  return [...literals, ...named];
}

/** The expression following a `queryKey:`, read up to the comma or bracket that closes it at depth 0.
 *  Balanced rather than line-bounded: a key spread over several lines is one expression, and a line regex
 *  reads only its first line. */
function keyExpression(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === '[' || char === '(' || char === '{') depth += 1;
    else if (char === ']' || char === ')' || char === '}') {
      if (depth === 0) return source.slice(from, i);
      depth -= 1;
    } else if (char === ',' && depth === 0) return source.slice(from, i);
  }
  return source.slice(from);
}

const INVALIDATION = /invalidateQueries\(\{\s*$/;
// Any `…Queries({ queryKey: … })` is an operation ON the cache, so it can never be the registration that
// vouches for a key — including the invalidations themselves.
const CACHE_OPERATION = /\w+Queries\(\{\s*$/;

describe('react-query cache invalidation', () => {
  // react-query silently no-ops an invalidation whose key matches no registered query, so a stale key
  // survives the removal of the query it belonged to and reads like the cache is still being refreshed.
  // Scanned over the whole source tree — an invalidation in a mutation rots exactly like one in the SSE
  // bridge — and resolved through the real key expressions, not the word after `queryKey:`.
  it('invalidates only query keys that some query registers', () => {
    const invalidated = new Set<string>();
    const registered = new Set<string>();
    const unreadable: string[] = [];
    let readSites = 0;

    for (const source of sources) {
      const occurrences = /queryKey:/g;
      let match: RegExpExecArray | null;
      while ((match = occurrences.exec(source)) !== null) {
        const expression = keyExpression(source, match.index + match[0].length);
        const preceding = source.slice(Math.max(0, match.index - 80), match.index);
        if (INVALIDATION.test(preceding)) {
          readSites += 1;
          const heads = keyHeads(expression);
          // A key this scan cannot resolve to any head — `queryKey: someVariable` — names nothing, so it
          // would satisfy the check below without a single key of it ever being checked.
          if (heads.length === 0) unreadable.push(expression.trim());
          for (const head of heads) invalidated.add(head);
        } else if (!CACHE_OPERATION.test(preceding)) {
          for (const head of keyHeads(expression)) registered.add(head);
        }
      }
    }

    // An invalidation this scan cannot read must be visible, never skipped. The one shape that resists a
    // static read is a key held in a variable (`invalidateQueries({ queryKey })`); anything else new
    // breaks this count instead of silently falling outside the check.
    const count = (pattern: RegExp): number => sources.reduce((n, src) => n + [...src.matchAll(pattern)].length, 0);
    const calls = count(/invalidateQueries\(/g);
    expect(calls).toBeGreaterThan(0);
    expect(readSites + count(/invalidateQueries\(\{\s*queryKey\s*\}\)/g)).toBe(calls);
    expect(unreadable).toEqual([]);

    expect([...invalidated].filter((head) => !registered.has(head))).toEqual([]);
  });
});
