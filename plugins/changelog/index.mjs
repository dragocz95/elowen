/**
 * Changelog — the release notes that ship WITH Elowen.
 *
 * The content is authored by Elowen's developers as Markdown under this plugin's own `entries/`
 * directory and travels with every build, so an instance that updates shows the new notes without
 * anybody writing them into that instance. The only per-instance state is one row per account: how far
 * that person has read, which is what the unread count on the navigation entry is computed from.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEntries, isNewerThanSeen } from './lib/entries.mjs';
import { initSeenStore } from './lib/db.mjs';
import { registerRoutes } from './lib/api.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ENTRIES_DIR = join(HERE, 'entries');
const ASSETS_DIR = join(ENTRIES_DIR, 'assets');

export function register(ctx) {
  const entries = loadEntries(ENTRIES_DIR, ctx.logger);
  const seen = initSeenStore(ctx);

  registerRoutes(ctx, { entries, assetsDir: ASSETS_DIR, seen });

  // The count the navigation entry wears. Synchronous by contract (it answers on every page load), which
  // is why the entries are parsed once above and only the account's own marker is read here.
  ctx.registerNavBadge(({ userId }) => {
    // Open mode carries no account, so there is nobody whose reading could be behind.
    if (userId === null) return null;
    const lastSeen = seen.lastSeen(userId);
    const unread = entries.filter((entry) => isNewerThanSeen(entry.version, lastSeen)).length;
    return unread > 0 ? unread : null;
  });

  ctx.registerUserRemoved((userId) => { seen.forgetUser(userId); });
}
