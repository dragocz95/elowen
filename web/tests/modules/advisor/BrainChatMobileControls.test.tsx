import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport, watchMounts } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The conversation bar carries different controls on a phone (model picker and work-mode pill fold into
// the ⋯ popover) than on desktop (everything inline). Which set is chosen must wait for the viewport
// measurement. The reasoning button is the exception — it stays inline at every width.

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('conversation bar controls', () => {
  it('never paints the desktop-only controls on a phone, not even for one commit', async () => {
    // The boolean-returning useMobile reports `false` before the first measurement, so the phone briefly
    // got the inline desktop bar and then swapped it for the ⋯ popover — a visible rearrangement on load.
    // The model picker is the marker now: on a phone it exists only INSIDE the popover, so any mount
    // before that popover is opened is the flash coming back.
    setViewport(true);
    const sawDesktopControls = watchMounts('[data-testid="chat-model-picker"]');
    renderSurface();

    await screen.findByRole('button', { name: 'More options' });
    expect(sawDesktopControls()).toBe(false);
  });

  it('keeps the reasoning button one tap away on a phone', async () => {
    // It is the control that gets changed mid-conversation, so it is the one that must not sit behind ⋯.
    setViewport(true);
    renderSurface();

    expect(await screen.findByTestId('chat-thoughts-toggle')).toBeInTheDocument();
  });

  it('does not also list reasoning inside the ⋯ popover', async () => {
    // Two ways to reach one modal is how a bar starts drifting; the inline button is the only one.
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));

    const popover = await waitFor(() => {
      const el = document.querySelector('[data-chat-popover]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(popover.textContent).not.toContain('Reasoning');
  });

  it('keeps the desktop controls inline off a phone', async () => {
    setViewport(false);
    renderSurface();

    expect(await screen.findByTestId('chat-thoughts-toggle')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-model-picker')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });

  it('closes the ⋯ popover on Escape', async () => {
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).toBeNull());
  });

  // The footer metrics (model / context / tokens / cost) must stay ONE line on a phone: a second row
  // pushes the composer down and eats the little vertical space a phone has. jsdom does no layout, so
  // what is guarded here is the class contract that produces the single line — the row itself must not
  // wrap, each metric must not wrap internally (a no-wrap flex row still lets an item's own text break),
  // and the model name — the long, expendable part — absorbs the squeeze by truncating.
  it('keeps the model/context/tokens/cost footer on one line for a phone', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: false, sessionId: 'brain-1', model: 'claude-opus-5', cards: [], queued: [],
      statusline: { showModel: true, showContext: true, showTokens: true, showCost: true },
      usage: { tokens: 258_000, contextWindow: 1_000_000, percent: 26, totalTokens: 126_300_000, cost: 59.08 },
    })));
    setViewport(true);
    renderSurface();

    const line = await screen.findByTestId('chat-statusline');
    expect(line.className).not.toContain('flex-wrap');

    const spans = [...line.querySelectorAll('span')];
    const model = spans.find((s) => s.textContent === 'claude-opus-5');
    expect(model?.className).toContain('truncate');
    expect(model?.getAttribute('title')).toBe('claude-opus-5'); // truncation must not hide which model ran

    const metrics = spans.filter((s) => /26%|Σ|59\.08/.test(s.textContent ?? ''));
    expect(metrics).toHaveLength(3);
    for (const metric of metrics) expect(metric.className).toContain('whitespace-nowrap');
  });
});
