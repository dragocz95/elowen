import { describe, expect, it } from 'vitest';
import { NAV_DEFAULTS, mergeNavSettings, sanitizeNavSettings } from '../../src/store/navSettings.js';

describe('navigation layout settings', () => {
  it('degrades every unusable stored value to the registry navigation', () => {
    for (const value of [undefined, null, 'nav', 42, [], { hidden: 'home', order: 7 }]) {
      expect(sanitizeNavSettings(value)).toEqual(NAV_DEFAULTS);
    }
  });

  it('keeps the order of a valid list, because position is the meaning', () => {
    expect(sanitizeNavSettings({ order: ['memory', 'chat', 'home'] }).order).toEqual(['memory', 'chat', 'home']);
  });

  it('drops entries that could not name a navigation item and deduplicates the rest', () => {
    const settings = sanitizeNavSettings({
      hidden: ['memory', '  ', 'memory', 'chat', 7, null, { id: 'home' }, ' projects '],
      order: ['x'.repeat(65), 'home'],
    });
    expect(settings.hidden).toEqual(['memory', 'chat', 'projects']);
    expect(settings.order).toEqual(['home']);
  });

  it('bounds a list that a client tried to grow without limit', () => {
    const flood = Array.from({ length: 500 }, (_, index) => `world-${index}`);
    expect(sanitizeNavSettings({ hidden: flood }).hidden).toHaveLength(64);
  });

  it('keeps an id that matches nothing today, so toggling a plugin does not reset the arrangement', () => {
    expect(sanitizeNavSettings({ order: ['raynet', 'home'] }).order).toEqual(['raynet', 'home']);
  });

  it('replaces a present list wholesale and leaves an absent one untouched', () => {
    const current = { hidden: ['memory'], order: ['chat', 'home'] };

    expect(mergeNavSettings(current, { hidden: [] })).toEqual({ hidden: [], order: ['chat', 'home'] });
    expect(mergeNavSettings(current, { order: ['home'] })).toEqual({ hidden: ['memory'], order: ['home'] });
    expect(mergeNavSettings(current, {})).toEqual(current);
    expect(mergeNavSettings(current, 'nonsense')).toEqual(current);
  });

  it('does not hand back the stored arrays, so a caller cannot mutate persisted state', () => {
    const current = { hidden: ['memory'], order: ['chat'] };
    const merged = mergeNavSettings(current, {});
    merged.hidden.push('chat');
    expect(current.hidden).toEqual(['memory']);
  });
});
