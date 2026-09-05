import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: vi.fn() }) }));
import { StudioNavigation } from '../../../components/shell/StudioNavigation';
import { createWrapper } from '../../test-utils';
import type { BrainSessionInfo } from '../../../lib/types';

// The incident: the Chat row's badge read the instance pulse's `runningAgents` — every running SUB-AGENT
// SESSION on the instance, counted off live streaming state. It counted other people's work, counted
// children rather than the conversations the reader can open, and read zero whenever a child sat in a tool
// call instead of a model stream. Two of the reader's own conversations, each waiting on a delegated
// child, badged as ONE. The count is now the caller's own busy conversations, which the daemon answers
// per conversation (SessionListItem.working) and already treats a parent waiting on a child as busy.
// The conversation list is seeded into the query cache AND served here: react-query refetches a seeded
// key on mount, and a refetch that answered something else would decide the assertion instead of the
// component. Both sides therefore read the same array.
const served = vi.hoisted(() => ({ sessions: [] as unknown[] }));
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
  http.get('*/api/brain/sessions', () => HttpResponse.json(served.sessions)),
);
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); currentPath.value = '/dash'; served.sessions = []; });

const session = (id: string, over: Partial<BrainSessionInfo> = {}): BrainSessionInfo => ({
  id, title: id, model: 'm', updated_at: '2026-09-05T00:00:00Z', running: false, active: false, ...over,
});

function mount(sessions: BrainSessionInfo[], pulseRunningAgents = 0) {
  served.sessions = sessions;
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  client.setQueryData(['plugin-ui', 'en'], []);
  client.setQueryData(['brain-sessions'], sessions);
  client.setQueryData(['activity-pulse'], { totals: { runningAgents: pulseRunningAgents } });
  return render(<Wrapper><StudioNavigation /></Wrapper>);
}

const chatBadge = (): HTMLElement | null =>
  screen.getByRole('link', { name: 'Chat' }).querySelector('[data-slot="sidebar-menu-badge"]');

describe('StudioNavigation — the Chat activity badge', () => {
  it('counts the caller\'s own busy conversations, not the instance\'s running sub-agents', () => {
    mount(
      [
        session('a', { working: true }),
        session('b', { working: true }),
        session('c'),
      ],
      // Whatever the instance-wide sub-agent figure happens to be, it does not speak for this reader.
      7,
    );
    expect(chatBadge()).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('title', 'Chat · Working conversations: 2');
  });

  it('counts a conversation whose child is mid-tool-call, which no streaming figure can see', () => {
    // Exactly the reported case: two parents, each waiting on a delegated child that is not streaming.
    // The pulse reports zero running agents here, which is what badged two working conversations as one.
    mount([session('a', { working: true }), session('b', { working: true })], 0);
    expect(chatBadge()).toHaveTextContent('2');
  });

  it('wears no badge when nothing of the reader\'s is working', () => {
    mount([session('a'), session('b', { running: true })], 3);
    expect(chatBadge()).toBeNull();
  });

  it('never counts a merely live session as work', () => {
    // `running` says a live session object exists, which outlives its last turn by design.
    mount([session('a', { running: true, working: false })], 0);
    expect(chatBadge()).toBeNull();
  });

  it('reads an older daemon\'s payload, which carries no working flag, as nothing working', () => {
    mount([session('a'), session('b')], 0);
    expect(chatBadge()).toBeNull();
  });

  it('keeps the badge decorative: the row is still named by its destination alone', () => {
    mount([session('a', { working: true })], 0);
    expect(chatBadge()).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
  });
});
