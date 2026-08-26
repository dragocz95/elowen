import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface, CardBlock } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The transcript is meant to read as ONE monospace column: the tool rows, the statusline and the
// out-of-band extras (todo card, process list, agents chip) all sit at the same type size for a given
// variant. The extras used to hardcode `text-tiny`, which on a desktop resolves to 9px against the
// statusline's 11px, so they rendered visibly smaller than the column around them. The size now comes
// from the extras wrapper and is inherited, and these tests pin that relationship rather than the
// literal value — changing one side alone turns them red.

class FakeES {
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const CARD = { id: 'c1', title: 'Plán', items: [{ text: 'krok', status: 'in_progress' as const }] };
const STATUSLINE = { showModel: true, showContext: false, showTokens: false, showCost: false };

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'anthropic/claude-opus-5', usage: null,
    statusline: STATUSLINE, cards: [CARD], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-08-05', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The Tailwind type-size utility an element declares, if any (`text-tiny`, `text-[0.6875rem]`…).
 *  Colour utilities like `text-text-muted` are not sizes and must not be picked up. */
function sizeClass(el: Element): string | null {
  const sizes = [...el.classList].filter((c) => /^text-(tiny|xs|sm|base|\[[\d.]+rem\])$/.test(c));
  return sizes[0] ?? null;
}

/** Walk up from an element to the first ancestor that declares a type size — the size it inherits. */
function inheritedSize(el: Element): string | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const own = sizeClass(node);
    if (own) return own;
  }
  return null;
}

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('transcript reads as one column', () => {
  it('ticks an in-progress card clock while the turn is live and keeps it visually secondary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const { wrapper: Wrapper } = createWrapper();
      render(<Wrapper><CardBlock card={{ id: 'todos', items: [{ text: '#112 Kontroluji vzhled karty', status: 'in_progress', startedAt: 100_000 }] }} live /></Wrapper>);
      expect(screen.getByTestId('chat-card')).toHaveTextContent('#112 Kontroluji vzhled karty· 0s');
      await act(async () => { await vi.advanceTimersByTimeAsync(169_000); });
      const elapsed = screen.getByTestId('chat-card-elapsed');
      expect(elapsed).toHaveTextContent('· 2m 49s');
      expect(elapsed).toHaveClass('text-text-muted', 'opacity-70');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sizes the todo card exactly like the statusline', async () => {
    renderSurface();
    const card = await screen.findByTestId('chat-card');
    const statusline = await screen.findByTestId('chat-statusline');
    expect(inheritedSize(card)).toBe(sizeClass(statusline));
  });

  it('leaves the todo card without a size of its own, so the column stays the single source', async () => {
    renderSurface();
    const card = await screen.findByTestId('chat-card');
    // A size declared on the card itself would override the wrapper and silently drift again.
    expect(sizeClass(card)).toBeNull();
  });

  it('gives the extras the same monospace face the statusline uses', async () => {
    renderSurface();
    const card = await screen.findByTestId('chat-card');
    const mono = (el: Element): boolean => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.classList.contains('font-mono')) return true;
      }
      return false;
    };
    expect(mono(card)).toBe(true);
    expect(mono(await screen.findByTestId('chat-statusline'))).toBe(true);
  });
});
