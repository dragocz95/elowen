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

  it('puts administration and the account together in the instance group, in the reader\'s order', () => {
    // The account is an ordinary member so it can be dragged among these rows (owner, 7 Sep 2026); it
    // is no longer a fixed region of its own, so wherever the reader put it is where it is drawn.
    const { groups } = sidebarLayout([
      entry('home'), entry('memory'), entry('settings'), entry('account'), entry('users'),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['primary', 'work', 'instance']);
    expect(groups.at(-1)!.entries.map((item) => item.id)).toEqual(['settings', 'account', 'users']);
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
    // A reader who hid the account and has no Settings or Users: the instance group must not exist.
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
