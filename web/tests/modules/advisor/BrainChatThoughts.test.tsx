import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** The chat surface renders the model's reasoning; this guards the client-side display toggle that hides
 *  it. Only the DISPLAY is switched — the daemon keeps streaming `reasoning` either way, so a segment
 *  hidden and shown again must reappear from the transcript the controller already holds. */

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

const REASONING = 'weighing the two options';
const STORAGE_KEY = 'elowen.chat.thoughts';

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface(variant: 'compact' | 'full') {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant={variant} /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

async function streamReasoning(): Promise<void> {
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = FakeES.instances[0]!;
  act(() => es.emit({ type: 'reasoning', delta: REASONING }));
}

describe('BrainChatSurface reasoning display toggle', () => {
  it('opens the shared reasoning panel and hides the reasoning text when its switch is off', async () => {
    renderSurface('compact');
    await streamReasoning();
    expect(await screen.findByText(REASONING)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-thoughts-toggle'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('switch'));
    await waitFor(() => expect(screen.queryByText(REASONING)).toBeNull());

    fireEvent.click(within(dialog).getByRole('switch'));
    expect(await screen.findByText(REASONING)).toBeInTheDocument();
  });

  it('persists the choice into localStorage', async () => {
    renderSurface('compact');
    await streamReasoning();
    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    const toggle = within(await screen.findByRole('dialog')).getByRole('switch');

    fireEvent.click(toggle);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('hide'));

    fireEvent.click(toggle);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('show'));
  });

  it('rehydrates a stored "hide" so a returning user never sees reasoning again', async () => {
    localStorage.setItem(STORAGE_KEY, 'hide');
    renderSurface('compact');
    await streamReasoning();

    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    expect(within(await screen.findByRole('dialog')).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(REASONING)).toBeNull();
  });

  it('opens the same reasoning panel in the full /chat variant', async () => {
    renderSurface('full');
    await streamReasoning();
    expect(await screen.findByText(REASONING)).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('switch'));
    await waitFor(() => expect(screen.queryByText(REASONING)).toBeNull());
  });
});
