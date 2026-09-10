import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { ChangelogPage } from '../../../plugins/changelog/web-src/ChangelogPage';
import manifest from '../../../plugins/changelog/elowen-plugin.json';
import { createWrapper } from '../test-utils';

// The bundle resolves everything through window.ElowenUiRuntime — install the REAL runtime, so this
// exercises the production contract rather than a stand-in.
ensurePluginUiRuntime();

const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([
    { name: 'changelog', url: '/plugins/changelog/web/index.js', apiVersion: 16, nav: [], settings: [], strings },
  ])),
  // A body for whatever release a test opened. A default rather than a per-test handler: the open entry
  // fetches its Markdown on mount, and a test about the readers row has no opinion about the notes.
  http.get('*/api/plugins/changelog/api/entries/:version', ({ params }) => HttpResponse.json({
    version: String(params.version), date: '2026-09-02', title: `Release ${String(params.version)}`,
    tags: [], pinned: false, unread: false, body: `Notes for ${String(params.version)}.`,
  })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const entry = (version: string, over: Partial<{ title: string; date: string; tags: string[]; pinned: boolean; unread: boolean }> = {}) => ({
  version, date: '2026-09-02', title: `Release ${version}`, tags: [], pinned: false, unread: false, ...over,
});

/** The listing plus a body per version, exactly as the daemon's two routes answer. */
function serveEntries(entries: ReturnType<typeof entry>[], bodies: Record<string, string> = {}) {
  server.use(
    http.get('*/api/plugins/changelog/api/entries', () => HttpResponse.json({ lastSeenVersion: null, entries })),
    http.get('*/api/plugins/changelog/api/entries/:version', ({ params }) => {
      const found = entries.find((e) => e.version === String(params.version));
      return found
        ? HttpResponse.json({ ...found, body: bodies[found.version] ?? `Notes for ${found.version}.` })
        : HttpResponse.json({ error: 'not found' }, { status: 404 });
    }),
  );
}

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ChangelogPage /></Wrapper>);
};

const PEOPLE = [
  { id: 1, username: 'amy', name: 'Amy Reader', avatar: '' },
  { id: 2, username: 'bob', name: '', avatar: '' },
  { id: 3, username: 'root', name: 'Root', avatar: '' },
];

/** Sign the page in as an admin or not, and answer the admin readers report. */
function serveReaders(isAdmin: boolean, readerIds: number[] = [1]) {
  server.use(
    http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 3, is_admin: isAdmin } })),
    http.get('*/api/plugins/changelog/api/readers', () => (isAdmin
      ? HttpResponse.json({ people: PEOPLE, entries: [{ version: '0.28.25', readerIds }] })
      : HttpResponse.json({ error: 'forbidden' }, { status: 403 }))),
  );
}

describe('changelog readers, for an admin', () => {
  it('shows every account as an avatar, dims the ones who have not read, and counts them', async () => {
    serveEntries([entry('0.28.25')]);
    serveReaders(true, [1, 3]);
    mount();

    const count = await screen.findByText(strings.readersCount!.replace('{read}', '2').replace('{total}', '3'));
    expect(count).toBeInTheDocument();
    // The name is on hover, and it says which side of the line the person is on.
    const read = screen.getByTitle(`Amy Reader — ${strings.readersRead}`);
    const unread = screen.getByTitle(`bob — ${strings.readersUnread}`);
    expect(read).toBeInTheDocument();
    // Dimming is what tells the two apart at a glance; without it the row is just a list of everybody.
    expect(unread.className).toContain('opacity-40');
    expect(read.className).not.toContain('opacity-40');
  });

  it('shows nothing of the kind to a non-admin', async () => {
    serveEntries([entry('0.28.25')]);
    serveReaders(false);
    mount();

    expect(await screen.findByText('Release 0.28.25')).toBeInTheDocument();
    expect(screen.queryByText(/have read/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: strings.markUnread })).not.toBeInTheDocument();
  });

  it('marks a release unread for everyone, but only after the confirmation is answered', async () => {
    let resetFor: string | null = null;
    serveEntries([entry('0.28.25')]);
    serveReaders(true, [1, 3]);
    server.use(http.post('*/api/plugins/changelog/api/unread/:version', ({ params }) => {
      resetFor = String(params.version);
      return HttpResponse.json({ reset: 2 });
    }));
    mount();

    fireEvent.click(await screen.findByRole('button', { name: strings.markUnread }));
    // The confirmation names the release, so the admin cannot reset the wrong one by muscle memory.
    expect(await screen.findByText(strings.markUnreadTitle!.replace('{version}', '0.28.25'))).toBeInTheDocument();
    expect(resetFor).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: strings.markUnreadConfirm }));
    await waitFor(() => expect(resetFor).toBe('0.28.25'));
    await waitFor(() => expect(screen.queryByText(strings.markUnreadTitle!.replace('{version}', '0.28.25'))).not.toBeInTheDocument());
  });

  it('leaves the reset standing instead of quietly re-reading the release for the admin who ran it', async () => {
    // The reset moved the admin's own marker back too. The visit guard must not fire again and post the
    // release straight back to read on their own screen.
    let seenCalls = 0;
    let unread = false;
    server.use(
      http.get('*/api/plugins/changelog/api/entries', () => HttpResponse.json({
        lastSeenVersion: unread ? null : '0.28.25',
        entries: [entry('0.28.25', { unread })],
      })),
      http.post('*/api/plugins/changelog/api/seen', () => { seenCalls += 1; return HttpResponse.json({ lastSeenVersion: '0.28.25' }); }),
      http.post('*/api/plugins/changelog/api/unread/:version', () => { unread = true; return HttpResponse.json({ reset: 2 }); }),
    );
    serveReaders(true, [1, 3]);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: strings.markUnread }));
    fireEvent.click(await screen.findByRole('button', { name: strings.markUnreadConfirm }));
    await waitFor(() => expect(screen.getByText(strings.unread!)).toBeInTheDocument());
    await new Promise((done) => { setTimeout(done, 50); });
    expect(seenCalls).toBe(0);
  });
});

describe('changelog page', () => {
  it('lists releases newest first and renders the open one as Markdown', async () => {
    serveEntries(
      [entry('0.28.25'), entry('0.28.24'), entry('0.28.17')],
      { '0.28.25': '## Added\n\n- A **bold** thing\n' },
    );
    mount();

    expect(await screen.findByText('Release 0.28.25')).toBeInTheDocument();
    expect(screen.getByText('Release 0.28.17')).toBeInTheDocument();
    // The first release opens on arrival, so the page is notes rather than a wall of closed rows.
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: strings.collapse!.replace('{version}', '0.28.25') })).toBeInTheDocument();
  });

  it('opens and closes a release from the keyboard-reachable header button', async () => {
    serveEntries([entry('0.28.25'), entry('0.28.24')], { '0.28.24': 'Older notes.' });
    mount();

    const closed = await screen.findByRole('button', { name: strings.expand!.replace('{version}', '0.28.24') });
    expect(closed).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(closed);

    expect(await screen.findByText('Older notes.')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: strings.collapse!.replace('{version}', '0.28.24') });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    // The body it controls is the one the button names, so a screen reader lands in the right place.
    const panel = document.getElementById(open.getAttribute('aria-controls')!)!;
    expect(panel).toContainElement(screen.getByText('Older notes.'));
    expect(panel).not.toHaveAttribute('hidden');
    fireEvent.click(open);
    expect(screen.getByRole('button', { name: strings.expand!.replace('{version}', '0.28.24') })).toHaveAttribute('aria-expanded', 'false');
    // The notes really go away rather than merely losing their announcement: without `hidden` every
    // closed release would still be on the page in full.
    expect(panel).toHaveAttribute('hidden');
    expect(screen.getByText('Older notes.')).not.toBeVisible();
  });

  it('marks unread releases, counts them, and posts the visit exactly once', async () => {
    let seenCalls = 0;
    serveEntries([entry('0.28.25', { unread: true }), entry('0.28.24', { unread: true }), entry('0.28.17')]);
    server.use(http.post('*/api/plugins/changelog/api/seen', () => { seenCalls += 1; return HttpResponse.json({ lastSeenVersion: '0.28.25' }); }));
    mount();

    expect(await screen.findAllByText(strings.unread!)).toHaveLength(2);
    expect(screen.getByText(strings.metricUnread!)).toBeInTheDocument();
    await waitFor(() => expect(seenCalls).toBe(1));
    // Once the page has settled, still exactly one: `waitFor` alone would pass on the way to two.
    await new Promise((done) => { setTimeout(done, 50); });
    expect(seenCalls).toBe(1);
  });

  it('draws the "since your last visit" line only when something read sits above the new releases', async () => {
    // Everything is new: the line would label the top of the list against nothing.
    serveEntries([entry('0.28.25', { unread: true }), entry('0.28.24', { unread: true })]);
    server.use(http.post('*/api/plugins/changelog/api/seen', () => HttpResponse.json({ lastSeenVersion: '0.28.25' })));
    mount();
    expect(await screen.findByText('Release 0.28.25')).toBeInTheDocument();
    expect(screen.queryByText(strings.unreadSeparator!)).not.toBeInTheDocument();
  });

  it('draws the separator under a pinned release the reader has already seen', async () => {
    serveEntries([
      entry('0.28.24', { pinned: true, title: 'Pinned older release' }),
      entry('0.28.25', { unread: true }),
    ]);
    server.use(http.post('*/api/plugins/changelog/api/seen', () => HttpResponse.json({ lastSeenVersion: '0.28.25' })));
    mount();

    expect(await screen.findByText(strings.unreadSeparator!)).toBeInTheDocument();
    expect(screen.getByText(strings.pinned!)).toBeInTheDocument();
    // The release that opens is the one new to the reader, not whatever a pin put at the top.
    expect(screen.getByRole('button', { name: strings.collapse!.replace('{version}', '0.28.25') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: strings.expand!.replace('{version}', '0.28.24') })).toBeInTheDocument();
  });

  it('points an entry image at the plugin asset route and drops a script the Markdown carried', async () => {
    serveEntries(
      [entry('0.28.25')],
      { '0.28.25': '![Recap](assets/0.28.25/recap.png)\n\n<script>window.pwned = 1</script>\n\n[bad](javascript:alert(1))\n' },
    );
    mount();

    const image = await screen.findByAltText('Recap');
    expect(image.getAttribute('src')).toBe('/api/plugins/changelog/api/asset/0.28.25/recap.png');
    // Sanitizing is not optional even for content that shipped inside the build: this HTML goes straight
    // into the document.
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(screen.getByText('bad').getAttribute('href')).toBeNull();
  });

  it('says the version ships no notes rather than showing an empty page', async () => {
    serveEntries([]);
    mount();
    expect(await screen.findByText(strings.empty!)).toBeInTheDocument();
  });

  it('reports a failed listing with a retry instead of an empty page', async () => {
    server.use(http.get('*/api/plugins/changelog/api/entries', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    mount();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button')).toBeInTheDocument();
  });
});
