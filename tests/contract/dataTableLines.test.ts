import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The register row rhythm, enforced mechanically instead of by a default.
//
// `DataTableCell`'s `lines` prop decides whether a cell holds the one canonical row height (`1`: one
// line, clipped at the column edge) or opts out of it (`auto`). The DEFAULT is `auto`, and it is not the
// recommendation: `data-lines="1"` lives in an UNLAYERED stylesheet, so it also beats any wrapping
// utility a caller passes, and defaulting to it silently truncated every cell of every plugin bundle
// built against an older API version — a change the compatibility ceiling (`requiresApiVersion <= host`)
// cannot express, because it can announce an addition and never a removal.
//
// The cost of the permissive default is that a NEW caller silently gets the ragged register this whole
// redesign existed to remove: /p/skills measured 27, 41, 59, 59 and 49px against the 48px rhythm every
// other register holds. So the rhythm is not carried by the default at all — it is carried here. Every
// call site states `lines` explicitly, and this fails the build the moment one stops.

const ROOT = process.cwd();

/** Where a `DataTableCell` may be rendered: the host component tree and the bundled plugins' sources.
 *  Tests are excluded on purpose — a test that renders a cell without `lines` is checking the default
 *  itself, which is exactly the behaviour this file documents. */
const CORPUS_ROOTS = [
  join(ROOT, 'web', 'components'),
  join(ROOT, 'web', 'modules'),
  join(ROOT, 'web', 'app'),
  ...readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, 'plugins', entry.name, 'web-src')),
];

function sources(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
  });
}

/** `<DataTableCell` and the `<C.DataTableCell` form a plugin bundle uses, which reaches the very same
 *  component through the host runtime. */
const CELL_TAG = /<(?:[A-Za-z_$][\w$]*\.)?DataTableCell\b/g;

/** The attribute text of one JSX opening tag, starting just after the tag name.
 *
 *  A regex up to the next `>` is not enough: `title={a > b}` and `onClick={() => x}` both carry one
 *  inside an expression container, and a matcher that stopped there would read half a tag and report a
 *  missing prop that is written three characters later. So braces and strings are tracked. */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') { depth += 1; continue; }
    if (char === '}') { depth -= 1; continue; }
    if (char === '>' && depth === 0) return source.slice(from, i);
  }
  return source.slice(from);
}

/** Every `DataTableCell` call site in one source, as `{ site, hasLines }`. */
function callSites(source: string): { attributes: string; hasLines: boolean }[] {
  const sites: { attributes: string; hasLines: boolean }[] = [];
  CELL_TAG.lastIndex = 0;
  for (const match of source.matchAll(CELL_TAG)) {
    const attributes = openingTag(source, match.index! + match[0].length);
    sites.push({ attributes, hasLines: /\blines\s*=/.test(attributes) });
  }
  return sites;
}

describe('every DataTableCell states its row rhythm', () => {
  const files = CORPUS_ROOTS.flatMap(sources);

  it('actually scans a corpus of real call sites', () => {
    // Both halves are load-bearing. A guard that scans nothing passes forever, so the corpus has to be
    // real — a moved folder or a broken walk collapses it silently. And the matcher has to fire on a
    // call site that omits the prop while leaving the ones that state it alone.
    const total = files.reduce((sum, file) => sum + callSites(readFileSync(file, 'utf-8')).length, 0);
    expect(total, 'the scan found almost no call sites — the walk or the matcher is broken').toBeGreaterThan(60);

    const flagged = (source: string) => callSites(source).filter((site) => !site.hasLines).length;
    for (const offender of [
      '<DataTableCell>{name}</DataTableCell>',
      '<DataTableCell header priority="wide">{label}</DataTableCell>',
      '<C.DataTableCell title={a.b}>{x}</C.DataTableCell>',
      '<DataTableCell\n  header\n  priority="wide"\n>{label}</DataTableCell>',
      // The trap the brace tracking exists for: a `>` inside an expression container is not the end of
      // the tag, and a matcher that stopped there would read `title={count ` and see no `lines`.
      '<DataTableCell title={count > 3 ? a : b}>{x}</DataTableCell>',
    ]) expect(flagged(offender), `should have been flagged: ${offender}`).toBe(1);

    for (const legitimate of [
      '<DataTableCell lines={1}>{name}</DataTableCell>',
      '<DataTableCell lines="auto" className="flex">{x}</DataTableCell>',
      '<C.DataTableCell header priority="wide" lines={1}>{label}</C.DataTableCell>',
      '<DataTableCell\n  priority="wide"\n  lines={1}\n  title={item.description}\n>{x}</DataTableCell>',
      '<DataTableCell title={count > 3 ? a : b} lines={1}>{x}</DataTableCell>',
      // The prop declaration and the destructured default are not call sites.
      'lines?: 1 | \'auto\';',
    ]) expect(flagged(legitimate), `should NOT have been flagged: ${legitimate}`).toBe(0);
  });

  it('leaves no call site relying on the permissive default', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, 'utf-8');
      return callSites(source)
        .filter((site) => !site.hasLines)
        .map((site) => `${relative(ROOT, file)}: <DataTableCell${site.attributes.replace(/\s+/g, ' ')}>`);
    });
    expect(
      offenders,
      'state lines={1} for a text cell (the register rhythm) or lines="auto" for a cell that hosts a control',
    ).toEqual([]);
  });
});
