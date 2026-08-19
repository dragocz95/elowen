import { describe, expect, it } from 'vitest';
import {
  EMPTY_NAV_LAYOUT,
  applyNavLayout,
  hiddenNavEntries,
  moveNavEntry,
  normalizeNavOrder,
  parseNavLayout,
  reorderNavEntry,
  setNavEntryHidden,
} from '../../lib/navLayout';

const entries = [{ id: 'home' }, { id: 'chat' }, { id: 'projects' }, { id: 'memory' }];
const ids = entries.map((entry) => entry.id);
const shown = (layout: Parameters<typeof applyNavLayout>[1]) => applyNavLayout(entries, layout).map((entry) => entry.id);

describe('navigation layout', () => {
  it('reproduces the registry navigation when nothing was customized', () => {
    expect(shown(EMPTY_NAV_LAYOUT)).toEqual(ids);
  });

  it('orders the arranged entries and leaves the rest in registry order behind them', () => {
    expect(shown({ hidden: [], order: ['memory', 'chat'] })).toEqual(['memory', 'chat', 'home', 'projects']);
  });

  it('removes hidden entries from the menu but still lists them for the modal', () => {
    const layout = { hidden: ['chat'], order: [] };
    expect(shown(layout)).toEqual(['home', 'projects', 'memory']);
    expect(hiddenNavEntries(entries, layout).map((entry) => entry.id)).toEqual(['chat']);
  });

  it('ignores an id that names no current entry, so a disabled plugin leaves no gap', () => {
    expect(shown({ hidden: ['raynet'], order: ['raynet', 'memory'] })).toEqual(['memory', 'home', 'chat', 'projects']);
  });

  it('keeps an unknown id in the order and appends entries it has never seen', () => {
    expect(normalizeNavOrder(['raynet', 'memory'], ids)).toEqual(['raynet', 'memory', 'home', 'chat', 'projects']);
  });

  it('swaps an entry with its visible neighbour', () => {
    const moved = moveNavEntry(EMPTY_NAV_LAYOUT, ids, 'projects', -1);
    expect(applyNavLayout(entries, moved).map((entry) => entry.id)).toEqual(['home', 'projects', 'chat', 'memory']);
  });

  it('moves past a hidden entry instead of trading places with something invisible', () => {
    const layout = { hidden: ['chat'], order: [] };
    const moved = moveNavEntry(layout, ids, 'projects', -1);
    expect(applyNavLayout(entries, moved).map((entry) => entry.id)).toEqual(['projects', 'home', 'memory']);
    // The hidden entry keeps the seat it had, so unhiding it later is not a surprise.
    expect(moved.order.indexOf('chat')).toBe(1);
  });

  it('refuses to move an entry off either end', () => {
    expect(shown(moveNavEntry(EMPTY_NAV_LAYOUT, ids, 'home', -1))).toEqual(ids);
    expect(shown(moveNavEntry(EMPTY_NAV_LAYOUT, ids, 'memory', 1))).toEqual(ids);
  });

  it('hides and restores an entry without disturbing the others', () => {
    const hiddenLayout = setNavEntryHidden(EMPTY_NAV_LAYOUT, 'chat', true);
    expect(shown(hiddenLayout)).toEqual(['home', 'projects', 'memory']);

    const restored = setNavEntryHidden(hiddenLayout, 'chat', false);
    expect(shown(restored)).toEqual(ids);
    expect(restored.hidden).toEqual([]);
  });

  // Hiding must not commit the menu to an arrangement: a surface that sorts by its own rule would
  // re-sort everything else the first time the user hid anything.
  it('leaves the order untouched, so hiding never commits an arrangement', () => {
    expect(setNavEntryHidden(EMPTY_NAV_LAYOUT, 'chat', true).order).toEqual([]);
    expect(setNavEntryHidden({ hidden: [], order: ['memory', 'home'] }, 'chat', true).order).toEqual(['memory', 'home']);
  });

  it('does not record the same entry as hidden twice', () => {
    const once = setNavEntryHidden(EMPTY_NAV_LAYOUT, 'chat', true);
    expect(setNavEntryHidden(once, 'chat', true).hidden).toEqual(['chat']);
  });
});

describe('reorderNavEntry', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('drops the entry at the requested position and closes the gap behind it', () => {
    const layout = reorderNavEntry({ hidden: [], order: ids }, ids, 'a', 2);
    expect(layout.order).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an entry upwards just as well', () => {
    const layout = reorderNavEntry({ hidden: [], order: ids }, ids, 'd', 0);
    expect(layout.order).toEqual(['d', 'a', 'b', 'c']);
  });

  // A hidden entry has no position in the list being dragged, so a drag across it must not carry it
  // along — unhiding it later has to put it back where the user left it.
  it('leaves hidden entries in their slots', () => {
    const layout = reorderNavEntry({ hidden: ['b'], order: ids }, ids, 'a', 1);
    expect(layout.order).toEqual(['c', 'b', 'a', 'd']);
    expect(layout.hidden).toEqual(['b']);
  });

  it('clamps a drag past either end instead of losing the entry', () => {
    expect(reorderNavEntry({ hidden: [], order: ids }, ids, 'c', 99).order).toEqual(['a', 'b', 'd', 'c']);
    expect(reorderNavEntry({ hidden: [], order: ids }, ids, 'c', -5).order).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is a no-op when the entry is dropped where it already sits', () => {
    expect(reorderNavEntry({ hidden: [], order: ids }, ids, 'b', 1).order).toEqual(ids);
  });

  it('seeds an empty order from the ids it is given, so the first drag keeps the surface order', () => {
    expect(reorderNavEntry(EMPTY_NAV_LAYOUT, ids, 'a', 1).order).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('parseNavLayout', () => {
  it('accepts two lists of ids', () => {
    expect(parseNavLayout({ hidden: ['a'], order: ['a', 'b'] })).toEqual({ hidden: ['a'], order: ['a', 'b'] });
  });

  // The cached layout comes from the browser's own storage, which anything on the origin can write.
  it('rejects anything that is not two lists of ids', () => {
    expect(parseNavLayout(null)).toBeNull();
    expect(parseNavLayout('nope')).toBeNull();
    expect(parseNavLayout({ hidden: ['a'] })).toBeNull();
    expect(parseNavLayout({ hidden: [1], order: [] })).toBeNull();
    expect(parseNavLayout({ hidden: [], order: [{}] })).toBeNull();
  });
});
