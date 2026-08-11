import { describe, it, expect } from 'vitest';
import type { ComponentType } from 'react';
import { matchPluginPage, type PluginPageProps } from '../../lib/pluginUi';
import { pluginNavEntries } from '../../lib/pluginNav';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { Puzzle, Sparkles } from 'lucide-react';
import type { PluginUiListing } from '../../lib/types';

const C = (name: string) => {
  const fn = () => null;
  fn.displayName = name;
  return fn as ComponentType<PluginPageProps>;
};

describe('matchPluginPage', () => {
  const pages = {
    '': C('root'),
    'detail/:id': C('detail'),
    'detail/new': C('new'),
    'a/:x/:y': C('deep'),
  };

  it('matches the root, exact-over-param, and captures params', () => {
    expect(matchPluginPage(pages, [])?.Component).toBe(pages['']);
    // exact segment beats the :id capture on the same length
    expect(matchPluginPage(pages, ['detail', 'new'])?.Component).toBe(pages['detail/new']);
    const m = matchPluginPage(pages, ['detail', '42']);
    expect(m?.Component).toBe(pages['detail/:id']);
    expect(m?.params).toEqual({ id: '42' });
    expect(matchPluginPage(pages, ['a', '1', '2'])?.params).toEqual({ x: '1', y: '2' });
  });

  it('returns null for an unmatched path or missing pages', () => {
    expect(matchPluginPage(pages, ['nope'])).toBeNull();
    expect(matchPluginPage(pages, ['detail'])).toBeNull(); // length must match exactly
    expect(matchPluginPage(undefined, [])).toBeNull();
  });
});

describe('pluginNavEntries', () => {
  const listing = (nav: PluginUiListing['nav']): PluginUiListing[] => [
    { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav, settings: [] },
  ];

  it('maps one world per plugin: first nav item is the face, several become sub-items', () => {
    const single = pluginNavEntries(listing([{ label: 'Demo', icon: 'Sparkles', route: '' }]));
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ id: 'plugin-demo', href: '/p/demo', label: 'Demo', activeRoutes: ['/p/demo'] });
    expect(single[0]!.icon).toBe(Sparkles);
    expect(single[0]!.subItems).toBeUndefined();

    const multi = pluginNavEntries(listing([
      { label: 'Home', route: '' }, { label: 'Detail', route: 'detail' },
    ]));
    expect(multi[0]!.subItems?.map((s) => s.href)).toEqual(['/p/demo', '/p/demo/detail']);
  });

  it('a plugin without nav claims no menu space; unknown icons fall back to the puzzle', () => {
    expect(pluginNavEntries(listing([]))).toHaveLength(0);
    const entry = pluginNavEntries(listing([{ label: 'X', icon: 'NotAnIcon', route: '' }]))[0]!;
    expect(entry.icon).toBe(Puzzle);
    expect(pluginLucideIcon(undefined)).toBe(Puzzle);
  });
});
