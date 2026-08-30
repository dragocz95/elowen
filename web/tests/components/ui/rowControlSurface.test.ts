// A settings record's controls are ONE ruled table: a model picker, a text field and a Radix select
// dropped into three rows of the same card have to share a height and a right edge, or the card reads as
// a ragged list instead of a table.
//
// This is asserted against the SOURCE rather than a render because the three surfaces are declared in
// three different files by three different mechanisms — a `cva` base, a `cva` variant and a plain class
// constant — and no single component renders all of them together. A DOM test would need every consumer
// mounted to notice that one of the three had moved.
//
// The failure this prevents actually happened: `RowPicker` built its trigger on Button's `sm` size
// (`h-8`) while `Input` and `SelectTrigger` were `h-9`, so the Memory card's model pickers sat 4px
// shorter than the inputs beside them.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const web = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(web, rel), 'utf-8');

const rowPicker = read('components/ui/RowPicker.tsx');
const input = read('components/ui/shadcn/input.tsx');
const select = read('components/ui/shadcn/select.tsx');

/** Every `.tsx`/`.ts` under the web app, minus its tests. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === '.next') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  for (const top of ['components', 'modules', 'app', 'lib']) walk(join(web, top));
  return out;
}

describe('settings record control surface', () => {
  it('gives the picker trigger, the input and the select trigger ONE height', () => {
    // The record control height. Change it in all three or not at all.
    expect(rowPicker).toMatch(/export const ROW_TRIGGER_CLASS = '[^']*\bh-9\b/);
    // Input's shared base — the height sits outside the variant block, so both `default` and `line` get it.
    expect(input).toMatch(/'h-9 w-full min-w-0 border/);
    // selectTriggerVariants' base, likewise shared by `default` and `line`.
    expect(select).toMatch(/selectTriggerVariants = cva\(\s*'group flex h-9\b/);
  });

  it('keeps the picker trigger full-width and right-aligned, so its edge is the cell edge', () => {
    // `w-full` is what makes a control reach the control column's right edge; `justify-between` is what
    // puts the chevron on that edge rather than beside the truncated value.
    expect(rowPicker).toMatch(/export const ROW_TRIGGER_CLASS = '[^']*\bw-full\b[^']*\bjustify-between\b/);
  });

  it('has exactly one source for the trigger class string', () => {
    // Four files used to spell `w-full justify-between font-normal` by hand: RowPicker plus the
    // multi-picker, timezone and modal-field triggers in PluginConfigEditor, plus the skins row. They are
    // the same control around the same ManageSelectionModal, and the copies are how the heights drifted.
    // The backtick matters: the copy this guard exists to catch was a TEMPLATE LITERAL in RowPicker
    // (`w-full justify-between font-normal ${className}`), so a scan for quotes alone would have missed
    // the very regression it is named after.
    const copies = sources().filter((path) => /["'`]w-full justify-between font-normal/.test(readFileSync(path, 'utf-8')));
    expect(copies.map((p) => p.slice(web.length + 1))).toEqual([]);
  });

  it('actually scans the app — a guard that reads nothing would prove nothing', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((p) => p.endsWith(join('components', 'ui', 'RowPicker.tsx')))).toBe(true);
    // And the scanner really does look inside file bodies, not just at names.
    expect(sources().filter((p) => /ROW_TRIGGER_CLASS/.test(readFileSync(p, 'utf-8'))).length).toBeGreaterThan(1);
  });
});
