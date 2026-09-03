import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ACCOUNT_ROW_SPECS, SETTINGS_ROW_SPECS, rowAnchor } from '../../lib/rowAnchors';

/** THE OTHER HALF OF THE CONTRACT. `rowAnchor()`'s parameter type already stops a section from marking a
 *  row with an anchor nobody links to. The direction TypeScript cannot see is the one that ships a dead
 *  link: an anchor declared in the tables, indexed by the palette, and rendered by no call site — the
 *  palette would open the section and then quietly find nothing to blink.
 *
 *  So the sources are scanned for the marks themselves. A static scan rather than a render because
 *  reaching every one of these rows on screen means mounting both decks with every section visited and
 *  every query answered, which tests the fixtures rather than the anchors. */

const WEB = resolve(import.meta.dirname, '..', '..');
const SCAN_DIRS = ['app', 'components', 'modules'];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(path);
    } else if (/\.tsx?$/.test(entry.name) && statSync(path).isFile()) {
      yield path;
    }
  }
}

const sources = SCAN_DIRS.flatMap((dir) => [...walk(join(WEB, dir))])
  .map((file) => ({ file: relative(WEB, file), source: readFileSync(file, 'utf8') }));

const declared = [
  ...Object.values(SETTINGS_ROW_SPECS).flatMap((rows) => rows.map((row) => row.path)),
  ...Object.values(ACCOUNT_ROW_SPECS).flatMap((rows) => rows.map((row) => row.path)),
];

describe('row anchors', () => {
  it('is one flat namespace — no id declared twice', () => {
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('marks every declared anchor at exactly one call site', () => {
    const sites = new Map<string, string[]>(declared.map((path) => [path, []]));
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/rowAnchor\('([^']+)'\)/g)) {
        const path = match[1]!;
        expect(sites.has(path), `${file} marks "${path}", which no row table declares`).toBe(true);
        sites.get(path)!.push(file);
      }
    }
    const unmarked = [...sites].filter(([, files]) => files.length === 0).map(([path]) => path);
    const duplicated = [...sites].filter(([, files]) => files.length > 1).map(([path, files]) => `${path} → ${files.join(', ')}`);
    expect(unmarked, 'every indexed row must render its anchor').toEqual([]);
    expect(duplicated, 'an anchor renders in one place, or the arriving page cannot tell them apart').toEqual([]);
  });

  it('hands the id through unchanged — the anchor IS the dictionary path', () => {
    expect(rowAnchor('settings.modelRoles.digest')).toBe('settings.modelRoles.digest');
    expect(rowAnchor('cli.visionModelLabel')).toBe('cli.visionModelLabel');
  });
});
