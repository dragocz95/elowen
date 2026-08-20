// The instance's visible identity: the name people read in Teams and the picture they see next to it.
//
// A white-labelled deployment renames the agent and ships its own artwork in a theme package
// (`<dataDir>/themes/<ELOWEN_THEME>/`), which is where the web UI already takes both from. The Teams
// app package was the one surface that ignored it and hard-coded "Elowen" plus a flat purple square,
// so the same assistant introduced itself as Chetty in chat and as Elowen in the app catalogue.
//
// Read once at startup and treated as optional throughout: no theme, an unreadable one, or artwork in
// the wrong shape all fall back to the stock identity rather than failing the plugin's load.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_AGENT = 'Elowen';
const DEFAULT_PRODUCT = 'Elowen';

/** Teams requires exactly 192×192 for the colour icon; anything else is rejected at upload. */
const COLOR_ICON_SIZE = 192;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/** Where theme packages live. `ELOWEN_DB` is the daemon's own anchor for the data directory; the walk
 *  up from the plugin's data dir (`<data>/plugins-data/msteams`) is the fallback for a host that does
 *  not set it. */
function themesRoot(dataDir) {
  const db = text(process.env.ELOWEN_DB);
  if (db) return join(dirname(db), 'themes');
  return dataDir ? join(dataDir, '..', '..', 'themes') : '';
}

/** A PNG of exactly the size Teams demands, or null — an icon of the wrong shape must not travel into
 *  a package that will be rejected only later, at upload time, with a message about neither. */
function readIcon(file, size) {
  let png;
  try { png = readFileSync(file); } catch { return null; }
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) return null;
  return png;
}

/**
 * Resolve the brand for this instance: `{ agentName, productName, icon }`.
 *
 * `icon` is the theme's 192px PNG when the theme ships a usable one, else null — the caller keeps its
 * own generated placeholder for that case rather than shipping a broken package.
 */
export function readBrand(dataDir, logger = console) {
  const theme = text(process.env.ELOWEN_THEME);
  const root = themesRoot(dataDir);
  const fallback = { agentName: DEFAULT_AGENT, productName: DEFAULT_PRODUCT, icon: null };
  if (!theme || !root) return fallback;

  const dir = join(root, theme);
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'));
  } catch (e) {
    // A themed instance with an unreadable theme is worth saying out loud: the Teams app would
    // silently carry the stock name while every other surface carries the custom one.
    logger?.warn?.(`msteams: theme "${theme}" has no readable theme.json (${e?.message ?? e}) — using the default brand`);
  }
  const agentName = text(parsed?.brand?.agentName) || text(parsed?.displayName) || DEFAULT_AGENT;
  return {
    agentName,
    productName: text(parsed?.brand?.productName) || agentName,
    icon: readIcon(join(dir, 'icon-192.png'), COLOR_ICON_SIZE),
  };
}
