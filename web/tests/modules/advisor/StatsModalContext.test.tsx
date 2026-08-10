import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { StatsModal } from '../../../modules/advisor/StatsModal';

// The context breakdown answers "what is filling the window", and it is the one section of this modal that
// costs something to produce: the daemon walks the live transcript to build it. So the two things worth
// pinning are that it is NOT fetched until the section is actually on screen, and that what comes back is
// rendered as one bar per category plus the free remainder.

const BREAKDOWN = {
  model: 'claude-sonnet-5',
  contextWindow: 200_000,
  reportedTokens: 120_000,
  estimatedTokens: 118_000,
  percent: 59,
  categories: [
    { id: 'system', tokens: 8_000, percent: 4 },
    { id: 'tools', tokens: 14_000, percent: 7 },
    { id: 'toolResults', tokens: 96_000, percent: 48 },
  ],
  free: { tokens: 82_000, percent: 41 },
  tools: [
    { name: 'Grep', schemaTokens: 400, callTokens: 600, resultTokens: 61_000, tokens: 62_000, percent: 31, active: true },
  ],
  compactAtTokens: 184_000,
};

let contextCalls = 0;

const server = setupServer(
  http.get('*/api/brain/context-usage', () => { contextCalls += 1; return HttpResponse.json(BREAKDOWN); }),
  http.get('*/api/usage/by-model', () => HttpResponse.json([])),
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', () => HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'claude-sonnet-5', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); contextCalls = 0; });
afterAll(() => server.close());

function renderModal() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper>
      <ToastProvider>
        <BrainChatProvider>
          <StatsModal onClose={() => {}} />
        </BrainChatProvider>
      </ToastProvider>
    </Wrapper>,
  );
}

/** Walk the pager to the Context section — it is the third of three, so two steps forward. The modal
 *  binds the arrow keys on `window`, which is also the affordance the footer hint advertises. */
async function openContextSection() {
  await screen.findByText('1/3'); // the pager indicator: the modal opens on the first of three sections
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  await screen.findByText('3/3');
}

describe('StatsModal — context breakdown section', () => {
  it('does not fetch the breakdown while another section is on screen', async () => {
    renderModal();
    await screen.findByText('Kontextové okno', {}, { timeout: 100 }).catch(() => null);

    // The modal opens on the conversation section; nothing should have asked the daemon to walk the
    // transcript yet. Building it eagerly would make merely opening the stats modal cost real work.
    expect(contextCalls).toBe(0);
  });

  it('fetches once the Context section is opened and renders a bar per category plus free space', async () => {
    renderModal();

    await openContextSection();

    await waitFor(() => expect(contextCalls).toBe(1));
    expect(await screen.findByText('System prompt')).toBeInTheDocument();
    expect(screen.getByText('Tool schemas')).toBeInTheDocument();
    expect(screen.getByText('Tool output')).toBeInTheDocument();
    expect(screen.getByText('Free space')).toBeInTheDocument();
    // Categories the daemon omitted (zero tokens) must not appear as empty bars.
    expect(screen.queryByText('Replies')).not.toBeInTheDocument();
  });

  it('ranks the heaviest tools and states that the category figures are estimates', async () => {
    renderModal();

    await openContextSection();

    expect(await screen.findByText('Heaviest tools')).toBeInTheDocument();
    expect(screen.getByText('Grep')).toBeInTheDocument();
    expect(screen.getByText(/estimates/i)).toBeInTheDocument();
  });

  it('shows the empty state instead of a zeroed chart when there is nothing to measure', async () => {
    server.use(http.get('*/api/brain/context-usage', () => HttpResponse.json(null)));
    renderModal();

    await openContextSection();

    expect(await screen.findByText('Nothing to measure')).toBeInTheDocument();
    expect(screen.queryByText('Free space')).not.toBeInTheDocument();
  });
});
