import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ConversationDiagnosticsModal } from '../../../modules/settings/ConversationDiagnosticsModal';
import { createWrapper, setViewport } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

const session = {
  id: 'session-1', userId: 1, username: 'admin', userName: 'Admin User', title: 'Captured conversation', surface: 'conversation',
  provider: 'anthropic', model: 'claude-sonnet', createdAt: '2026-08-19T18:00:00.000Z', updatedAt: '2026-08-19T20:00:00.000Z',
  captureStartedAt: 1_755_630_000_000, requestCount: 2, errorCount: 0, firstRequestAt: 1_755_630_000_000, lastRequestAt: 1_755_630_100_000,
  inputTokens: 220, outputTokens: 40, reasoningTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, totalTokens: 270,
  costUsd: 0.0123, costedRequestCount: 1, latestRequestStatus: 'succeeded',
};

const requestBase = {
  sessionId: 'session-1', turnId: 'turn-1', retryOf: null, kind: 'chat', configuredProvider: 'anthropic', wireProvider: 'anthropic', api: 'messages',
  model: 'claude-sonnet', startedAt: 1_755_630_000_000, responseAt: 1_755_630_001_000, finishedAt: 1_755_630_002_000,
  status: 'succeeded', httpStatus: 200, errorCode: null, errorMessage: null, inputTokens: 110, outputTokens: 20,
  reasoningTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 10, totalTokens: 135, costUsd: 0.006, durationMs: 2000,
};

const requests = [
  { ...requestBase, requestId: 'request-1', seq: 1 },
  { ...requestBase, requestId: 'request-2', seq: 2, turnId: 'turn-2', costUsd: null },
];

function manifest(requestId: string) {
  return {
    ...requests.find((request) => request.requestId === requestId)!, canonicalizationVersion: 1, assistantMessageId: null, segmentBytes: 400,
    segments: [
      { index: 0, section: 'system', key: 'system', kind: 'system', digest: `${requestId}-sys`, canonicalizationVersion: 1, byteLength: 30, estimatedTokens: 20 },
      { index: 1, section: 'input', key: 'messages', kind: 'message', digest: `${requestId}-msg`, canonicalizationVersion: 1, byteLength: 60, estimatedTokens: 30 },
      { index: 2, section: 'tool', key: 'tools', kind: 'tool', digest: `${requestId}-tool`, canonicalizationVersion: 1, byteLength: 90, estimatedTokens: 40 },
      { index: 3, section: 'options', key: null, kind: 'options', digest: `${requestId}-opt`, canonicalizationVersion: 1, byteLength: 20, estimatedTokens: 5 },
    ],
  };
}

function segments(requestId: string) {
  const tool = requestId === 'request-1'
    ? { name: 'alpha_tool', input_schema: { type: 'object', properties: { alpha: { type: 'string' } } } }
    : { type: 'web_search_20250305', name: 'beta_search' };
  return {
    items: [
      { ...manifest(requestId).segments[0], payload: 'You are Elowen.' },
      { ...manifest(requestId).segments[1], payload: { role: 'user', content: requestId === 'request-1' ? 'First prompt' : 'Second prompt' } },
      { ...manifest(requestId).segments[2], payload: tool },
      { ...manifest(requestId).segments[3], payload: { temperature: 0 } },
    ],
    nextCursor: null, loadedBytes: 200,
  };
}

let rawReads = 0;
let segmentReads = 0;
let lastSessionQuery = '';
const server = setupServer(
  http.get('*/api/brain/debug/sessions', ({ request }) => {
    lastSessionQuery = new URL(request.url).search;
    return HttpResponse.json({ items: [session], nextCursor: null, captureStartedAt: session.captureStartedAt });
  }),
  http.get('*/api/brain/debug/sessions/session-1/requests', () => HttpResponse.json({ items: requests, nextCursor: null })),
  http.get('*/api/brain/debug/sessions/session-1/requests/:requestId', ({ params }) => HttpResponse.json(manifest(String(params.requestId)))),
  http.get('*/api/brain/debug/sessions/session-1/requests/:requestId/segments/:index', ({ params }) => {
    segmentReads += 1;
    return HttpResponse.json(segments(String(params.requestId)).items[Number(params.index)]);
  }),
  http.get('*/api/brain/debug/sessions/session-1/requests/:requestId/raw', ({ params }) => {
    rawReads += 1;
    return HttpResponse.json({ payload: { model: 'claude-sonnet', request: params.requestId }, byteLength: 80 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); rawReads = 0; segmentReads = 0; lastSessionQuery = ''; vi.restoreAllMocks(); });
afterAll(() => server.close());

function renderModal(captureEnabled = true) {
  setViewport(false);
  const { wrapper: Wrapper } = createWrapper();
  return render(<ConversationDiagnosticsModal captureEnabled={captureEnabled} onClose={vi.fn()} />, { wrapper: Wrapper });
}

describe('ConversationDiagnosticsModal', () => {
  it('loads only an explicitly opened segment and keeps the raw provider body lazy', async () => {
    renderModal();
    expect(await screen.findByLabelText('Prompt token segments')).toBeInTheDocument();
    expect(segmentReads).toBe(0);
    expect(rawReads).toBe(0);

    fireEvent.click(screen.getByText('tools'));
    expect(await screen.findByText('alpha_tool')).toBeInTheDocument();
    expect(segmentReads).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Raw provider request/ }));
    await waitFor(() => expect(rawReads).toBe(1));
    expect(await screen.findByText(/"request": "request-1"/)).toBeInTheDocument();
  });

  it('updates the exact tool set per request and renders graph/cache metrics with textual status', async () => {
    renderModal();
    expect(await screen.findByLabelText('Prompt token segments')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tools'));
    expect(await screen.findByText('alpha_tool')).toBeInTheDocument();
    expect(screen.getByText(/Estimated cached prefix/)).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getAllByText('succeeded').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /#2/ }));
    await waitFor(() => expect(screen.queryByText('alpha_tool')).not.toBeInTheDocument());
    await screen.findByText('Not available');
    fireEvent.click(screen.getByText('tools'));
    expect(await screen.findByText('beta_search')).toBeInTheDocument();
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  it('sends server-side filters and renders capture-disabled and legacy states', async () => {
    server.use(
      http.get('*/api/brain/debug/sessions', ({ request }) => {
        lastSessionQuery = new URL(request.url).search;
        return HttpResponse.json({ items: [{ ...session, title: 'Old conversation', requestCount: 0, captureStartedAt: null }], nextCursor: null, captureStartedAt: null });
      }),
      http.get('*/api/brain/debug/sessions/session-1/requests', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('*/api/brain/debug/sessions/session-1/legacy-transcript', () => HttpResponse.json({ items: [{ cursor: 1, id: 'm1', role: 'user', content: 'Legacy hello', createdAt: '2026-08-18T10:00:00.000Z', byteLength: 12 }], nextCursor: null, loadedBytes: 12, exact: false })),
    );
    renderModal(false);
    expect(await screen.findByText(/Detailed request capture is disabled/)).toBeInTheDocument();
    expect(await screen.findByText('Legacy hello')).toBeInTheDocument();
    expect(screen.getByText(/best-effort/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search sessions…'), { target: { value: 'needle' } });
    await waitFor(() => expect(lastSessionQuery).toContain('search=needle'));
  });

  it('renders a bounded message window without downloading every payload', async () => {
    const manySegments = Array.from({ length: 250 }, (_, index) => ({
      index, section: 'input', key: 'messages', kind: 'message', digest: `digest-${index}`,
      canonicalizationVersion: 1, byteLength: 10, estimatedTokens: 3,
    }));
    server.use(http.get('*/api/brain/debug/sessions/session-1/requests/:requestId', ({ params }) => HttpResponse.json({
      ...manifest(String(params.requestId)), segments: manySegments, segmentBytes: 2500,
    })));
    renderModal();

    expect(await screen.findByText('digest-99')).toBeInTheDocument();
    expect(screen.queryByText('digest-100')).not.toBeInTheDocument();
    expect(segmentReads).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('digest-100')).toBeInTheDocument();
    expect(segmentReads).toBe(0);
  });

  it('opens mobile session and tools drawers as nested accessible dialogs', async () => {
    setViewport(true);
    const { wrapper: Wrapper } = createWrapper();
    render(<ConversationDiagnosticsModal captureEnabled onClose={vi.fn()} />, { wrapper: Wrapper });
    await screen.findByLabelText('Prompt token segments');

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    const sessionsDrawer = await screen.findByRole('dialog', { name: 'Sessions' });
    expect(within(sessionsDrawer).getByTestId('diagnostics-session-rail')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Conversation diagnostics' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const toolsDrawer = await screen.findByRole('dialog', { name: 'Tools' });
    fireEvent.click(within(toolsDrawer).getByText('tools'));
    expect(await within(toolsDrawer).findByText('alpha_tool')).toBeInTheDocument();
  });
});
