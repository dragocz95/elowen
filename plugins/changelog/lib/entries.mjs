/**
 * The release notes that SHIPPED with this Elowen build: one Markdown file per release under
 * `entries/`, with images beside them in `entries/assets/<version>/`.
 *
 * They are read from the plugin's own directory rather than a repository-root folder so the lookup is
 * depth-independent: `plugins/changelog/` in a checkout and `dist/plugins/changelog/` in a build are the
 * same relative layout, and `npm run build` already copies `plugins/` into `dist/`. Content is immutable
 * for the lifetime of a build, so it is parsed once per boot.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `0.28.25` → [0, 28, 25]. Everything from the first `-` is dropped, so `0.28.25-rc.1` reads as
 *  `0.28.25` and a pre-release cannot outrank the release it leads to. A non-numeric segment sorts as 0,
 *  which is what a malformed name deserves: it lands at the bottom instead of taking the page down. */
function versionParts(version) {
  return version.split('-')[0].split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Newest first. Exported because "is this entry newer than what the reader has seen" is the same
 *  question, asked per account. */
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether `version` is newer than the version the account last saw. An account with no row has seen
 *  nothing, so everything is new to it. */
export function isNewerThanSeen(version, lastSeen) {
  return lastSeen === null || compareVersions(version, lastSeen) < 0;
}

/** The `---` block at the top of an entry: `key: value` lines, `[a, b]` for a list, `true`/`false` for a
 *  flag. Deliberately not YAML — the daemon's parser is not a plugin dependency, and an entry's front
 *  matter is five flat keys. Returns the parsed keys and the Markdown body after the block. */
function parseFrontMatter(source) {
  const text = source.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else if (raw === 'true' || raw === 'false') {
      meta[key] = raw === 'true';
    } else {
      meta[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/** Every entry in `dir`, newest first, pinned ones ahead of the rest. A file whose front matter names no
 *  `version` is skipped with a warning: it would otherwise sort as 0.0.0 and sit at the bottom forever
 *  under a name nobody chose. */
export function loadEntries(dir, log) {
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  const entries = [];
  const seenVersions = new Set();
  for (const file of files) {
    const path = join(dir, file);
    let source;
    try {
      if (!statSync(path).isFile()) continue;
      source = readFileSync(path, 'utf8');
    } catch {
      continue; // Vanished between the listing and the read; the rest of the notes still load.
    }
    const { meta, body } = parseFrontMatter(source);
    if (typeof meta.version !== 'string' || meta.version === '') {
      log?.warn?.(`entry ${file} has no version in its front matter — skipped`);
      continue;
    }
    // The version addresses the entry: it is the React key, the `aria-controls` target and what
    // `entries/<version>` looks up. A second file claiming one would give two rows the same identity.
    if (seenVersions.has(meta.version)) {
      log?.warn?.(`entry ${file} repeats version ${meta.version} — skipped`);
      continue;
    }
    seenVersions.add(meta.version);
    entries.push({
      version: meta.version,
      date: typeof meta.date === 'string' ? meta.date : '',
      title: typeof meta.title === 'string' ? meta.title : '',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      pinned: meta.pinned === true,
      body,
    });
  }
  entries.sort((a, b) => (a.pinned === b.pinned ? compareVersions(a.version, b.version) : (a.pinned ? -1 : 1)));
  return entries;
}
