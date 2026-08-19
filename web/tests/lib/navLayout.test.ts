import { describe, expect, it } from 'vitest';
import {
  EMPTY_NAV_LAYOUT,
  applyNavLayout,
  hiddenNavEntries,
  moveNavEntry,
  normalizeNavOrder,
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
    const hiddenLayout = setNavEntryHidden(EMPTY_NAV_LAYOUT, ids, 'chat', true);
    expect(shown(hiddenLayout)).toEqual(['home', 'projects', 'memory']);

    const restored = setNavEntryHidden(hiddenLayout, ids, 'chat', false);
    expect(shown(restored)).toEqual(ids);
    expect(restored.hidden).toEqual([]);
  });

  it('does not record the same entry as hidden twice', () => {
    const once = setNavEntryHidden(EMPTY_NAV_LAYOUT, ids, 'chat', true);
    expect(setNavEntryHidden(once, ids, 'chat', true).hidden).toEqual(['chat']);
  });
});
