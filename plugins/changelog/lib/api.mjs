/** The plugin's routes over the release notes that shipped with this build: the notes themselves, their
 *  images, the marker recording how far the reader has got, and the two admin views over that same
 *  marker — who has read which release, and putting a release back to unread for everybody. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { compareVersions, isNewerThanSeen, localizeEntry } from './entries.mjs';

/** Image types an entry may reference. SVG is deliberately absent: it is a script-carrying document,
 *  and nothing in a release note needs one. */
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** One path segment of an asset URL. An allowlist rather than a `..` blocklist: the segment names a
 *  version directory or a file the release author committed, and both are plain names. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function json(body, status = 200) {
  return { status, body };
}

/** Metadata only. The bodies stay behind `entries/<version>` so the list does not grow with the whole
 *  history of the product every time somebody opens the page. */
function listing(entries, lastSeen, tracked, lang) {
  return entries.map((entry) => ({
    version: entry.version,
    date: entry.date,
    title: localizeEntry(entry, lang).title,
    tags: entry.tags,
    pinned: entry.pinned,
    unread: tracked && isNewerThanSeen(entry.version, lastSeen),
  }));
}

export function registerRoutes(ctx, { entries, assetsDir, seen }) {
  ctx.registerApiRoute({
    path: 'entries',
    method: 'GET',
    access: 'user',
    handler: async (req) => {
      // In open mode a request carries no account, so there is nobody whose reading could be behind:
      // without this every release would come back unread and the page would show a backlog that can
      // never be cleared, because there is no row to write either.
      const tracked = req.auth.userId !== null;
      const lastSeen = seen.lastSeen(req.auth.userId);
      // The page's UI locale; an entry without that translation falls back to its English original.
      const lang = typeof req.query.lang === 'string' ? req.query.lang : '';
      const version = req.path.trim();
      if (version === '') return json({ lastSeenVersion: lastSeen, entries: listing(entries, lastSeen, tracked, lang) });
      const entry = entries.find((e) => e.version === version);
      if (!entry) return json({ error: 'not found' }, 404);
      return json({ ...localizeEntry(entry, lang), unread: tracked && isNewerThanSeen(entry.version, lastSeen) });
    },
  });

  ctx.registerApiRoute({
    path: 'seen',
    method: 'POST',
    access: 'user',
    handler: async (req) => {
      // The newest release the reader was just shown — the page lists them all, so opening it clears
      // the whole backlog. Reading it from the shipped entries rather than the request body keeps the
      // marker inside the set of versions that actually exist.
      const newest = entries.reduce((best, e) => (best === null || isNewerThanSeen(e.version, best) ? e.version : best), null);
      if (newest !== null) seen.markSeen(req.auth.userId, newest);
      // Read back rather than echo `newest`: markSeen only moves the marker forward, so on an instance
      // that was downgraded the stored value is the newer one and that is what the reader still has.
      return json({ lastSeenVersion: seen.lastSeen(req.auth.userId) });
    },
  });

  // Who has read what. Admin-only: the per-account list is other people's reading, and a reader's own
  // state is already in the listing above. The access level is enforced centrally by the dispatcher; the
  // handler asserts it too, because this is the one route here that discloses somebody else's activity.
  ctx.registerApiRoute({
    path: 'readers',
    method: 'GET',
    access: 'admin',
    handler: async (req) => {
      if (!req.auth.admin) return json({ error: 'forbidden' }, 403);
      const people = seen.everyone();
      return json({
        people: people.map(({ id, username, name, avatar }) => ({ id, username, name, avatar })),
        entries: entries.map((entry) => ({
          version: entry.version,
          readerIds: people.filter((person) => !isNewerThanSeen(entry.version, person.lastSeen)).map((p) => p.id),
        })),
      });
    },
  });

  // Put a release back to unread for EVERY account, so the badge shows again for people who already read
  // it. The version comes from the path and must be one that shipped: an arbitrary string would move
  // every marker to a release nobody can open.
  ctx.registerApiRoute({
    path: 'unread',
    method: 'POST',
    access: 'admin',
    handler: async (req) => {
      if (!req.auth.admin) return json({ error: 'forbidden' }, 403);
      const version = req.path.trim();
      if (!entries.some((e) => e.version === version)) return json({ error: 'not found' }, 404);
      // The newest release OLDER than this one: the marker everybody who had read this far falls back to,
      // which leaves whatever they read before it read.
      const fallback = entries.reduce((best, e) => {
        if (compareVersions(e.version, version) <= 0) return best;
        return best === null || compareVersions(e.version, best) < 0 ? e.version : best;
      }, null);
      return json({ reset: seen.resetForAll(version, fallback) });
    },
  });

  ctx.registerApiRoute({
    path: 'asset',
    method: 'GET',
    access: 'user',
    handler: async (req) => {
      const segments = req.path.split('/').filter(Boolean).map((s) => {
        try { return decodeURIComponent(s); } catch { return ''; }
      });
      if (segments.length !== 2 || !segments.every((s) => SAFE_SEGMENT.test(s))) return json({ error: 'not found' }, 404);
      const [version, name] = segments;
      // hasOwn, not a truthiness test: a file named `constructor` would otherwise find `Object` up the
      // prototype chain and pass for an image type.
      const ext = name.split('.').pop().toLowerCase();
      if (!Object.hasOwn(IMAGE_TYPES, ext)) return json({ error: 'not found' }, 404);
      const type = IMAGE_TYPES[ext];
      const path = resolve(assetsDir, version, name);
      // The invariant the allowlist above is meant to give, asserted where it actually matters: a file
      // read must not leave the assets directory whatever the segments turned out to be.
      if (!path.startsWith(assetsDir + sep)) return json({ error: 'not found' }, 404);
      if (!existsSync(path) || !statSync(path).isFile()) return json({ error: 'not found' }, 404);
      return {
        status: 200,
        headers: {
          'content-type': type,
          // The extension decides the type, so the bytes must never be allowed to argue for another one.
          'x-content-type-options': 'nosniff',
          // Assets are keyed by release version and a released version's files never change.
          'cache-control': 'public, max-age=31536000, immutable',
        },
        body: new Uint8Array(readFileSync(path)),
      };
    },
  });
}
