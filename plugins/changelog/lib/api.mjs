/** The plugin's three routes over the release notes that shipped with this build: the notes themselves,
 *  their images, and the marker recording how far the reader has got. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isNewerThanSeen } from './entries.mjs';

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
function listing(entries, lastSeen, tracked) {
  return entries.map((entry) => ({
    version: entry.version,
    date: entry.date,
    title: entry.title,
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
      const version = req.path.trim();
      if (version === '') return json({ lastSeenVersion: lastSeen, entries: listing(entries, lastSeen, tracked) });
      const entry = entries.find((e) => e.version === version);
      if (!entry) return json({ error: 'not found' }, 404);
      return json({ ...entry, unread: tracked && isNewerThanSeen(entry.version, lastSeen) });
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
