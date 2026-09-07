import { describe, expect, it } from 'vitest';
import { CircleUserRound, Home, LayoutGrid } from 'lucide-react';
import { sidebarLayout, subMenuPages } from '../../../components/shell/navGroups';
import type { NavEntry } from '../../../components/shell/navEntry';

/** The partition is a PRESENTATION rule over one navigation model. Every entry stays customizable —
 *  hidden, restored and reordered by id — so what these cases pin is only which region a row is drawn
 *  in, and that the user's own order survives inside it. */

const entry = (id: string, label = id): NavEntry => ({ id, href: `/${id}`, label, icon: Home });

describe('sidebarLayout', () => {
  it('opens with an unlabelled block of landing destinations', () => {
    const { groups } = sidebarLayout([entry('home'), entry('chat'), entry('memory')]);
    expect(groups.map((group) => group.id)).toEqual(['primary', 'work']);
    expect(groups[0]!.entries.map((item) => item.id)).toEqual(['home', 'chat']);
  });

  it('puts administration in its own group and the account alone at the end', () => {
    const { groups, account } = sidebarLayout([
      entry('home'), entry('memory'), entry('settings'), entry('users'), entry('account'),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['primary', 'work', 'instance']);
    expect(groups.at(-1)!.entries.map((item) => item.id)).toEqual(['settings', 'users']);
    expect(account?.id).toBe('account');
    // The account is never also a destination among the others.
    expect(groups.flatMap((group) => group.entries).map((item) => item.id)).not.toContain('account');
  });

  it('lands a plugin world in the work group without knowing its name', () => {
    const { groups } = sidebarLayout([entry('home'), entry('plugin-skills', 'Skills')]);
    expect(groups.find((group) => group.id === 'work')!.entries.map((item) => item.id))
      .toEqual(['plugin-skills']);
  });

  it('files the release notes under the instance, not among the work', () => {
    // What the instance has to say for itself belongs with the instance (owner, 7 Sep 2026).
    const { groups } = sidebarLayout([entry('home'), entry('plugin-changelog', "What's new"), entry('settings')]);
    expect(groups.find((group) => group.id === 'instance')!.entries.map((item) => item.id))
      .toEqual(['plugin-changelog', 'settings']);
    expect(groups.map((group) => group.id)).not.toContain('work');
  });

  it('drops a group nobody has entries in, rather than drawing an empty header', () => {
    // A non-admin has no Settings or Users, so the instance group must not exist at all.
    const { groups } = sidebarLayout([entry('home'), entry('memory')]);
    expect(groups.map((group) => group.id)).not.toContain('instance');
  });

  it('preserves the order handed in, which is the order the reader arranged', () => {
    const { groups } = sidebarLayout([entry('memory'), entry('chat'), entry('projects'), entry('home')]);
    expect(groups.find((group) => group.id === 'primary')!.entries.map((item) => item.id))
      .toEqual(['chat', 'home']);
    expect(groups.find((group) => group.id === 'work')!.entries.map((item) => item.id))
      .toEqual(['memory', 'projects']);
  });

  it('reports no account row when the reader has hidden it', () => {
    expect(sidebarLayout([entry('home')]).account).toBeUndefined();
  });
});

describe('subMenuPages', () => {
  const page = (id: string) => ({ id, href: `/p/x/${id}`, label: id, icon: LayoutGrid });

  it('is null for a plain destination', () => {
    expect(subMenuPages({ id: 'home', href: '/dash', label: 'Home', icon: CircleUserRound })).toBeNull();
  });

  it('is null for a world naming its own single page, which discloses nothing', () => {
    expect(subMenuPages({ id: 'projects', href: '/projects', label: 'Projects', icon: Home, subItems: [page('a')] }))
      .toBeNull();
  });

  it('is every page once there are two, including the one the parent addresses', () => {
    const pages = subMenuPages({ id: 'x', href: '/p/x/a', label: 'X', icon: Home, subItems: [page('a'), page('b')] });
    expect(pages?.map((item) => item.id)).toEqual(['a', 'b']);
  });
});
