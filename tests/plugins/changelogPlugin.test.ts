import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openDb } from '../../src/store/db.js';
import { compareVersions, isNewerThanSeen, loadEntries, localizeEntry } from '../../plugins/changelog/lib/entries.mjs';
import { registerRoutes } from '../../plugins/changelog/lib/api.mjs';
import type { PluginApiRequest, PluginApiRoute, PluginContext, PluginHttpResponse } from '../../src/plugins/api.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const log = { info() {}, warn() {}, error() {} };

let temps: string[] = [];
afterEach(() => { for (const p of temps) rmSync(p, { recursive: true, force: true }); temps = []; });
const temp = (tag: string) => { const p = mkdtempSync(join(tmpdir(), `elowen-changelog-${tag}-`)); temps.push(p); return p; };

async function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'amy', 'x', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (2, 'bob', 'x', 0)").run();
  const registry = await loadPlugins({
    dirs: [pluginsDir], enabled: ['changelog'], logger: log, dataRoot: temp('data'),
    pluginDb: (name) => makePluginDb(db, name, { canMigrate: true }),
    delegatedTurnsOutOfProcess: () => false,
  });
  return { registry, db };
}

/** Call a route the way the daemon's dispatcher does: resolve it against the registry, hand the handler
 *  a request whose identity the dispatcher has already verified. */
async function call(
  registry: Awaited<ReturnType<typeof setup>>['registry'],
  method: string,
  path: string,
  userId: number | null = 1,
  query: Record<string, string> = {},
): Promise<{ status: number; body: PluginHttpResponse['body']; headers?: PluginHttpResponse['headers'] }> {
  const match = registry.apiRoute('changelog', path, method);
  if (!match) throw new Error(`no route for ${method} ${path}`);
  const req = {
    method,
    path: match.remainder,
    query,
    headers: {},
    params: {},
    body: () => Promise.resolve(Buffer.alloc(0)),
    json: () => Promise.resolve({}),
    auth: { userId, admin: false, tokenScope: 'user' as const, accessibleProjects: null },
  } satisfies PluginApiRequest;
  const res = await match.handler(req);
  return { status: res.status ?? 200, body: res.body, headers: res.headers };
}

describe('changelog entries on disk', () => {
  it('ships at least the three most recent releases, newest first, with front matter parsed', () => {
    const entries = loadEntries(join(pluginsDir, 'changelog', 'entries'), log);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title).not.toBe('');
      expect(entry.body).not.toBe('');
    }
    // Pinned first, then newest first — the order the page renders without sorting again.
    const unpinned = entries.filter((e) => !e.pinned).map((e) => e.version);
    expect(unpinned).toEqual([...unpinned].sort(compareVersions));
    expect(entries.findIndex((e) => !e.pinned)).toBeGreaterThanOrEqual(entries.filter((e) => e.pinned).length);
  });

  it('ships every release in Czech and Slovak beside the English original', () => {
    // App copy exists in all three locales; a release note is app copy the reader sees on a page.
    const entries = loadEntries(join(pluginsDir, 'changelog', 'entries'), log);
    for (const entry of entries) {
      for (const lang of ['cs', 'sk'] as const) {
        const translation = entry.translations[lang];
        expect(translation, `${entry.version} has no ${lang} translation`).toBeDefined();
        expect(translation!.title).not.toBe('');
        expect(translation!.body).not.toBe('');
        expect(translation!.title).not.toBe(entry.title);
      }
    }
  });

  it('attaches a <version>.<lang>.md translation to its original and skips one without an original', () => {
    const dir = temp('entries');
    // Listed before the original alphabetically: the loader must not depend on the readdir order.
    writeFileSync(join(dir, '1.2.3.cs.md'), '---\nversion: 1.2.3\ntitle: Česky\ntags: [Ignored]\n---\n\nČeské tělo.\n');
    writeFileSync(join(dir, '1.2.3.md'), '---\nversion: 1.2.3\ndate: 2026-01-01\ntitle: English\ntags: [One]\n---\n\nEnglish body.\n');
    writeFileSync(join(dir, '1.2.4.sk.md'), '---\nversion: 1.2.4\ntitle: Orphan\n---\n\nNo original.\n');
    const warnings: string[] = [];
    const entries = loadEntries(dir, { warn: (m: string) => warnings.push(m) });
    expect(entries.map((e) => e.version)).toEqual(['1.2.3']);
    expect(entries[0]!.translations).toEqual({ cs: { title: 'Česky', body: 'České tělo.' } });
    // Only the text is translated; what the release IS comes from the original.
    expect(entries[0]!.tags).toEqual(['One']);
    expect(localizeEntry(entries[0]!, 'cs')).toMatchObject({ title: 'Česky', body: 'České tělo.', tags: ['One'], date: '2026-01-01' });
    expect(localizeEntry(entries[0]!, 'sk')).toMatchObject({ title: 'English', body: 'English body.' });
    expect('translations' in localizeEntry(entries[0]!, 'cs')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('1.2.4.sk.md');
  });

  it('orders versions numerically, not lexically', () => {
    // The bug a string sort has: "0.28.9" > "0.28.17" as text.
    expect(compareVersions('0.28.17', '0.28.9')).toBeLessThan(0);
    expect(compareVersions('0.29.0', '0.28.99')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    // A pre-release must not outrank the release it leads to: splitting on dots alone reads the `.1` of
    // `-rc.1` as a fourth segment and makes the candidate look newer than the thing itself.
    expect(compareVersions('0.28.25-rc.1', '0.28.25')).toBe(0);
    expect(isNewerThanSeen('0.28.25-rc.1', '0.28.25')).toBe(false);
  });

  it('keeps one entry per version when two files claim the same one', () => {
    // The version is the entry's identity — the React key, the aria-controls target and what
    // `entries/<version>` looks up. Two rows answering to it is a broken page, not a duplicate row.
    const dir = temp('entries');
    writeFileSync(join(dir, '1.2.3.md'), '---\nversion: 1.2.3\ntitle: First\n---\n\nFirst body.\n');
    writeFileSync(join(dir, '1.2.3-hotfix.md'), '---\nversion: 1.2.3\ntitle: Second\n---\n\nSecond body.\n');
    const warnings: string[] = [];
    const entries = loadEntries(dir, { warn: (m: string) => warnings.push(m) });
    expect(entries).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('skips a file whose front matter names no version instead of sorting it as 0.0.0', () => {
    const dir = temp('entries');
    writeFileSync(join(dir, 'good.md'), '---\nversion: 1.2.3\ntitle: Good\ntags: [One, Two]\npinned: true\n---\n\nBody.\n');
    writeFileSync(join(dir, 'broken.md'), '---\ntitle: No version\n---\n\nBody.\n');
    const warnings: string[] = [];
    const entries = loadEntries(dir, { warn: (m: string) => warnings.push(m) });
    expect(entries.map((e) => e.version)).toEqual(['1.2.3']);
    expect(entries[0]!.tags).toEqual(['One', 'Two']);
    expect(entries[0]!.pinned).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe('changelog routes', () => {
  it('lists metadata without bodies and serves one entry with its Markdown', async () => {
    const { registry } = await setup();
    const list = (await call(registry, 'GET', 'entries')).body as { lastSeenVersion: string | null; entries: { version: string; body?: string }[] };
    expect(list.lastSeenVersion).toBeNull();
    expect(list.entries.length).toBeGreaterThanOrEqual(3);
    expect(list.entries.every((e) => e.body === undefined)).toBe(true);

    const one = await call(registry, 'GET', `entries/${list.entries[0]!.version}`);
    expect(one.status).toBe(200);
    expect((one.body as { body: string }).body.length).toBeGreaterThan(0);

    expect((await call(registry, 'GET', 'entries/9.9.9')).status).toBe(404);
  });

  it('serves the title and body in the requested language and falls back to English', async () => {
    const { registry } = await setup();
    const english = (await call(registry, 'GET', 'entries')).body as { entries: { version: string; title: string }[] };
    const czech = (await call(registry, 'GET', 'entries', 1, { lang: 'cs' })).body as { entries: { version: string; title: string }[] };
    expect(czech.entries.map((e) => e.version)).toEqual(english.entries.map((e) => e.version));
    expect(czech.entries[0]!.title).not.toBe(english.entries[0]!.title);

    const version = english.entries[0]!.version;
    const one = (await call(registry, 'GET', `entries/${version}`, 1, { lang: 'cs' })).body as { title: string; body: string; translations?: unknown };
    expect(one.title).toBe(czech.entries[0]!.title);
    const original = (await call(registry, 'GET', `entries/${version}`)).body as { body: string };
    expect(one.body).not.toBe(original.body);
    // The translation map is a loader detail, not part of the entry the page renders.
    expect(one.translations).toBeUndefined();

    // A locale nothing was translated into reads the English original.
    const german = (await call(registry, 'GET', `entries/${version}`, 1, { lang: 'de' })).body as { body: string };
    expect(german.body).toBe(original.body);
  });

  it('declares every route it registers, and every route is user-level', async () => {
    const { registry } = await setup();
    for (const path of ['entries', 'seen', 'asset']) {
      const route = registry.apiRoute('changelog', path, path === 'seen' ? 'POST' : 'GET');
      expect(route?.access).toBe('user');
    }
    // No write surface beyond the reader's own marker: the content is shipped, not edited at runtime.
    expect(registry.apiRoute('changelog', 'entries', 'POST')).toBeUndefined();
    expect(registry.apiRoute('changelog', 'entries', 'DELETE')).toBeUndefined();
  });

  it('counts unread per account, clears it on POST seen, and never moves the marker backwards', async () => {
    const { registry } = await setup();
    const badge = registry.navBadge.get('changelog')!;
    const total = (await call(registry, 'GET', 'entries')).body as { entries: unknown[] };

    expect(badge({ userId: 1, isAdmin: false })).toBe(total.entries.length);
    expect(badge({ userId: 2, isAdmin: false })).toBe(total.entries.length);

    await call(registry, 'POST', 'seen', 1);
    expect(badge({ userId: 1, isAdmin: false })).toBeNull();
    // …and only for that account.
    expect(badge({ userId: 2, isAdmin: false })).toBe(total.entries.length);

    const after = (await call(registry, 'GET', 'entries', 1)).body as { lastSeenVersion: string; entries: { unread: boolean }[] };
    expect(after.lastSeenVersion).not.toBeNull();
    expect(after.entries.every((e) => !e.unread)).toBe(true);

    // A second visit is idempotent rather than a rewrite backwards.
    await call(registry, 'POST', 'seen', 1);
    expect(badge({ userId: 1, isAdmin: false })).toBeNull();
  });

  it('has no badge and no marker for a request carrying no account', async () => {
    const { registry } = await setup();
    expect(registry.navBadge.get('changelog')!({ userId: null, isAdmin: true })).toBeNull();
    const res = await call(registry, 'POST', 'seen', null);
    expect(res.status).toBe(200);
    const list = (await call(registry, 'GET', 'entries', null)).body as { lastSeenVersion: string | null; entries: { unread: boolean }[] };
    expect(list.lastSeenVersion).toBeNull();
    // And nothing is UNREAD either. There is no row to write, so a backlog shown here could never be
    // cleared — the reader would face a permanent "new" chip on every release.
    expect(list.entries.some((e) => e.unread)).toBe(false);
  });

  it('drops a deleted account\'s marker', async () => {
    const { registry } = await setup();
    const badge = registry.navBadge.get('changelog')!;
    await call(registry, 'POST', 'seen', 1);
    expect(badge({ userId: 1, isAdmin: false })).toBeNull();
    for (const { fn } of registry.userRemovedHandlers) await fn(1);
    expect(badge({ userId: 1, isAdmin: false })).not.toBeNull();
  });
});

/** The asset route is exercised against a temporary content tree rather than the shipped one: no release
 *  currently references an image, and a test that wrote one into `plugins/changelog/entries/assets/`
 *  would be leaving fixtures in the product. */
describe('changelog asset route', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  /** Register the routes against a temp assets directory and return a caller for the asset mount. */
  function assetRoutes() {
    const assetsDir = temp('assets');
    mkdirSync(join(assetsDir, '0.28.25'), { recursive: true });
    writeFileSync(join(assetsDir, '0.28.25', 'shot.png'), PNG);
    writeFileSync(join(assetsDir, '0.28.25', 'notes.md'), 'secret');
    writeFileSync(join(assetsDir, 'outside.png'), PNG);
    const routes = new Map<string, PluginApiRoute>();
    const ctx = { registerApiRoute: (route: PluginApiRoute) => routes.set(route.path, route) } as unknown as PluginContext;
    registerRoutes(ctx, { entries: [], assetsDir, seen: { lastSeen: () => null, markSeen: () => {}, forgetUser: () => {} } });
    return (path: string) => routes.get('asset')!.handler({
      method: 'GET', path, query: {}, headers: {}, params: {},
      body: () => Promise.resolve(Buffer.alloc(0)),
      json: () => Promise.resolve({}),
      auth: { userId: 1, admin: false, tokenScope: 'user', accessibleProjects: null },
    });
  }

  it('serves an image as bytes with its content type, and forbids sniffing another one', async () => {
    const res = await assetRoutes()('0.28.25/shot.png');
    expect(res.status ?? 200).toBe(200);
    expect(res.headers?.['content-type']).toBe('image/png');
    // The extension decides the type here, so the bytes must not be allowed to argue for another.
    expect(res.headers?.['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body as Uint8Array).equals(PNG)).toBe(true);
  });

  it('refuses traversal, an unknown extension and a wrong segment count', async () => {
    const get = assetRoutes();
    const refused = [
      '../../../etc/passwd',
      '%2e%2e/%2e%2e/package.json',
      '%252e%252e/%252e%252e/package.json',
      '0.28.25/..%2f..%2foutside.png',
      '../outside.png',
      '..\\outside.png',
      '/etc/passwd',
      '0.28.25/shot.png%00.txt',
      '0.28.25/notes.md',
      '0.28.25/logo.svg',
      '0.28.25',
      '0.28.25/deep/shot.png',
      // `constructor` is a real name on every object: a truthiness test against the type table would
      // find `Object` up the prototype chain and accept it as an image type.
      '0.28.25/constructor',
    ];
    for (const path of refused) {
      expect({ path, status: (await get(path)).status ?? 200 }).toEqual({ path, status: 404 });
    }
  });
});
