import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(import.meta.dirname, '..', '..');

/** The settings surface is shared UI: /settings renders it, /account renders it, and every plugin bundle
 *  is handed the same components through `web/lib/pluginUi.tsx`. It used to live in a module stylesheet
 *  that the ROOT LAYOUT had to import by hand so plugin routes got it too — a core stylesheet in all but
 *  location. It is one of the core component stylesheets now, so no route has to remember it. */
describe('settings surface stylesheet ownership', () => {
  it('ships the surface from the core stylesheet tree, not a module theme file', () => {
    expect(existsSync(join(webRoot, 'modules', 'settings', 'theme.css'))).toBe(false);
    expect(existsSync(join(webRoot, 'modules', 'account', 'theme.css'))).toBe(false);

    const layout = readFileSync(join(webRoot, 'app', 'layout.tsx'), 'utf8');
    const settingsPage = readFileSync(join(webRoot, 'app', 'settings', 'page.tsx'), 'utf8');
    const accountPage = readFileSync(join(webRoot, 'app', 'account', 'page.tsx'), 'utf8');
    for (const source of [layout, settingsPage, accountPage]) expect(source).not.toContain('theme.css');

    const css = readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8');
    for (const rule of ['.settings-document', '.settings-group', '.settings-row', '.settings-toolbar']) {
      expect(css).toContain(rule);
    }
  });

  /** /account carried a second card convention — `[data-account-panel]` drew its own frame and
   *  `.spatial-form-group` its own inner group — beside the `.settings-group` it also used. Two card
   *  languages on one page is how the two pages stopped reading as one product. */
  it('keeps one card convention: no account-only rival of .settings-group', () => {
    const css = readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8');
    expect(css).not.toContain('spatial-form-group');
    expect(css).not.toMatch(/\[data-account-panel\][^{]*\{[^}]*(border|box-shadow|background)/);
  });
});

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first brace block whose prelude contains `needle`, brace-matched so a container
 *  query's own nested rules come back with it. A regex cannot do this: `[^}]*` stops at the first
 *  nested closing brace, which is exactly where these assertions need to start looking. */
function block(css: string, needle: string): string {
  const at = css.indexOf(needle);
  expect(at, `no block matching ${needle}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block for ${needle}`);
}

/** THE ROW LAYOUT CONTRACT, asserted against the stylesheets because that is where it lives: a record is
 *  one grid row on a wide card and a two-line band in a narrow container, and never three lines in
 *  either. The DOM/source half of the same contract is in tests/modules/settings/SettingsSurface.test.tsx.
 *
 *  Both sheets are checked. The base one states the rule; the Studio skin is more specific than it by
 *  construction (`:root:is([data-skin=…])` outranks a bare class), so a base rule the skin does not
 *  restate is a rule that does not apply on the default design — which is how the phone layout drifted
 *  the last time. */
describe('settings row layout contract', () => {
  const core = stripComments(readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8'));
  const studio = stripComments(readFileSync(join(webRoot, 'skins', 'studio', 'surfaces.css'), 'utf8'));
  const PHONE = '@container workspace-shell (width < 38.75rem)';

  // Leading newline keeps the lookup pinned to the standalone record selector.
  const BASE_ROW = '\n.settings-row {';

  it('gives every record the same floor so a card reads as evenly ruled', () => {
    expect(block(core, BASE_ROW)).toMatch(/min-height:\s*2\.75rem/);
  });

  it('withholds only glyph icons in Studio and presents brand icons as neutral compact marks', () => {
    expect(block(studio, ".settings-row__icon[data-icon-kind='glyph'] {")).toMatch(/display:\s*none/);

    const brand = block(studio, ".settings-row__icon[data-icon-kind='brand'] {");
    expect(brand).toMatch(/display:\s*grid/);
    expect(brand).toMatch(/width:\s*1\.75rem/);
    expect(brand).toMatch(/height:\s*1\.75rem/);
    expect(brand).toMatch(/border:\s*1px solid var\(--studio-line\)/);
    expect(brand).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(brand).toMatch(/background:\s*var\(--studio-fill-quiet\)/);
    expect(brand).toMatch(/color:\s*var\(--color-muted-foreground\)/);

    const brandInteraction = block(studio, ".settings-row:hover .settings-row__icon[data-icon-kind='brand'],");
    expect(brandInteraction).toMatch(/border-color:\s*var\(--studio-line\)/);
    expect(brandInteraction).toMatch(/box-shadow:\s*none/);
  });

  it("never wraps an inline record's trailing cell, at any width", () => {
    // Declared outside every container query, so it holds on a 1440px card and on a 320px one alike. On a
    // wide card the cell is a grid and cannot wrap by construction; the declaration is what holds the line
    // once the phone fold returns it to flex.
    expect(block(core, ".settings-row[data-trailing='inline'] .settings-row__trailing {")).toMatch(/flex-wrap:\s*nowrap/);
    expect(block(block(studio, PHONE), ".settings-row[data-trailing='inline'] .settings-row__trailing {")).toMatch(/flex-wrap:\s*nowrap/);
  });

  /** THE TRAILING BAND. A card's records share their trailing columns, which is the only way a switch can
   *  sit under the switch above it when the record between them carries a status pill and an action. Flex
   *  sizes every row from its own content, so this has to be a grid taking its tracks from the stack — and
   *  the three slots have to be PLACED, because a record may omit any of them and auto-placement would put
   *  the next one in the missing one's column. */
  it('gives the trailing side one shared band: status, control, actions in fixed columns', () => {
    const stack = block(core, '.settings-group__body:has(> .settings-row),\n.settings-group__column {');
    expect(stack).toMatch(/grid-template-columns:\s*minmax\(10rem,\s*1fr\)\s+minmax\(0,\s*auto\)\s+minmax\(0,\s*1\.05fr\)\s+auto/);
    expect(studio).toMatch(/minmax\(0,\s*1fr\)\s+minmax\(0,\s*auto\)\s+minmax\(0,\s*20rem\)\s+auto/);

    // The cell spans every trailing track it is given, so a skin may retune them without touching the DOM.
    expect(block(core, '\n.settings-row__trailing {')).toMatch(/grid-column:\s*2\s*\/\s*-1/);
    // ONE grid owns the widths: the stack declares the four tracks and every record borrows them. Without
    // this the records size their own columns and nothing lines up down the card.
    expect(block(core, '.settings-group__column > .settings-row {')).toMatch(/grid-template-columns:\s*subgrid/);

    // Both layouts take the band. `stack` says what a record does when the card gets NARROW; on a wide
    // card it has the same three slots as everything else, and leaving it out was what kept the one row
    // with a badge, a switch and a button off the alignment it needed most.
    // THE CELL DISSOLVES. A wrapper that is itself a subgrid is a SECOND grid, and a nested subgrid only
    // shares the tracks it spans: measured on a 1440px Recap card, the one row carrying an action opened
    // an action column no other row had and its own switch sat 273px to the left of every other switch.
    // `display: contents` leaves exactly one grid sizing all four columns for every row at once, so the
    // action column exists at the same width even in a row that has no action.
    expect(block(core, '.settings-row[data-trailing] .settings-row__trailing {')).toMatch(/display:\s*contents/);
    expect(core).not.toMatch(/\.settings-row__trailing \{[^}]*grid-template-columns:\s*subgrid/);

    for (const [slot, column] of [['status', '2'], ['control', '3'], ['actions', '4']] as const) {
      const rule = block(core, `.settings-row[data-trailing] .settings-row__trailing > .settings-row__${slot} {`);
      expect(rule, `${slot} must be placed explicitly`).toMatch(new RegExp(`grid-column:\\s*${column}`));
    }
    // An inline record's control ends at its own track's edge, so a bare switch lands on the column edge
    // every switch above it lands on while a select still spans the track through its full-width class.
    expect(block(core, '.settings-row[data-trailing] .settings-row__trailing > .settings-row__actions {')).toMatch(/justify-self:\s*end/);
    expect(block(core, ".settings-row[data-trailing='inline'] .settings-row__trailing .settings-row__control {")).toMatch(/justify-content:\s*flex-end/);
  });

  /** WHERE THE SHORT STATUS READS. An inline record's status is a reading about the setting, so it sits on
   *  the label's own line — one flex line of name, help mark and status. The band rules that used to place
   *  it in a middle track are GONE rather than merely unused: a second placement for the same slot is how
   *  a pill ends up floating between a record's name and its switch again. The status TRACK stays, because
   *  a stacked record's block status still occupies it. */
  it("reads an inline record's status on the label line, with no middle track left to strand it in", () => {
    const title = block(core, '\n.settings-row__title {');
    expect(title).toMatch(/display:\s*flex/);
    expect(title).toMatch(/align-items:\s*center/);
    expect(title).toMatch(/flex-wrap:\s*wrap/);
    expect(title).toMatch(/gap:\s*0\.4rem/);
    expect(block(core, '.settings-row__title > .settings-row__status {')).toMatch(/margin-top:\s*0/);

    for (const dead of [
      ".settings-row[data-trailing='inline'] .settings-row__trailing > .settings-row__status",
      ':not(:has(> .settings-row__control)) > .settings-row__status',
    ]) expect(core, `${dead} must not survive the move`).not.toContain(dead);

    // Studio states the record's typography, never a second copy of the label line's layout.
    expect(studio).not.toMatch(/\.settings-row__title \{[^}]*display:/);
  });

  /** One track cannot be subgridded into three. Both sheets have to hand the band back to flex where they
   *  collapse the record, or the slots open implicit columns and the card grows an edge nothing reaches. */
  it('releases the band back to a flex line wherever the record collapses', () => {
    const phone = block(core, PHONE);
    expect(block(phone, '.settings-row[data-trailing] .settings-row__trailing {')).toMatch(/display:\s*flex/);
    expect(phone).toMatch(/grid-column:\s*auto;\s*justify-self:\s*auto/);

    const studioNarrow = block(studio, '@container workspace-shell (width < 48rem)');
    expect(block(studioNarrow, '.settings-row[data-trailing] .settings-row__trailing {')).toMatch(/display:\s*flex/);
    expect(studioNarrow).toMatch(/grid-column:\s*auto;\s*justify-self:\s*auto/);

    // No record opts out of the band any more: a plugin's risk field used to take two full-width lines
    // of its own, and that shape is gone with the rule that drew it (owner, 7 Sep 2026).
    expect(core).not.toContain('plugin-config-risk-row');
  });

  it('folds every record to the two-line band in a narrow container', () => {
    expect(block(block(core, PHONE), '\n  .settings-row {')).toMatch(/grid-template-columns:\s*1fr/);
    // `[data-trailing]` matches every record, inline and stack alike. It used to read `[data-trailing='stack']`
    // here, which left a one-value record holding a two-column table inside ~120px.
    expect(block(block(studio, PHONE), '.settings-row[data-trailing] {')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(block(block(studio, PHONE), '.settings-row[data-trailing] .settings-row__label,')).toMatch(/grid-column:\s*1/);
  });

  /** A SEGMENTED SET CANNOT BE NARROWED, so the card it sits in widens its control column instead. The
   *  track is shared through subgrid, so raising its floor moves every record's control column together
   *  and keeps the right edge flush with the switches above and below it. Both sheets are checked: the
   *  Studio skin outranks the base one by construction, so a floor the skin does not restate is a floor
   *  the default design never gets. */
  it('gives a card carrying a segmented a control column its content fits in', () => {
    for (const [sheet, name, expected] of [
      [core, 'core', /minmax\(min-content,\s*1\.05fr\)/],
      [studio, 'studio', /minmax\(min-content,\s*20rem\)/],
    ] as const) {
      expect(block(sheet, '.settings-group__body:has(> .settings-row .segmented)'), `${name} must raise the control track's floor`)
        .toMatch(expected);
    }
    // The two-stack card takes the same floor, and Studio's own narrow ratio restates it.
    expect(block(core, '.settings-group__column:has(> .settings-row .segmented) {')).toMatch(/minmax\(min-content,\s*0\.85fr\)/);
    expect(block(block(studio, '@container workspace-shell (width < 48rem)'), '.settings-group__body:has(> .settings-row .segmented),'))
      .toMatch(/minmax\(min-content,\s*1\.1fr\)/);

    // And it collapses with everything else when the record folds: the `:has` that opens it outranks the
    // fold rule above, so the phone width has to spell the collapse out.
    const phone = block(core, PHONE);
    expect(block(phone, '.settings-group__body:has(> .settings-row .segmented),')).toMatch(/grid-template-columns:\s*1fr/);
    // One track is all there is at that width: the set keeps its line and scrolls inside the record
    // instead of overrunning the card.
    const scroller = block(phone, '.settings-row__control > .segmented {');
    expect(scroller).toMatch(/max-width:\s*100%/);
    expect(scroller).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps a status readable rather than clipping it inside its badge', () => {
    // The label-line status shrinks its own children (a model id truncates) and never hides overflow
    // itself, which is what clipped "Configured" inside its badge the last time this was tuned.
    const status = block(core, '.settings-row__title > .settings-row__status {');
    expect(status).toMatch(/min-width:\s*0/);
    expect(status).not.toMatch(/overflow:\s*hidden/);
  });

  it("raises the record's controls to a touch target for a coarse pointer", () => {
    const coarse = block(core, '@media (pointer: coarse)');
    for (const control of ['button', "[role='combobox']", "[role='radio']", "[role='switch']"]) {
      expect(coarse).toContain(`.settings-row__trailing ${control}`);
    }
    expect(coarse).toMatch(/min-height:\s*2\.75rem/);
  });
});
