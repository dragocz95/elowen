import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// A custom endpoint the operator configured as `ollama` / "Ollama". PI registers it internally as
// `elowen-ollama`, which is what the chat header used to display; the daemon now keeps that name in
// `usageProvider` alone, and the header reads the public pair.
const STATUS = {
  running: false, sessionId: 'brain-1', model: 'kimi-k2.7-code',
  provider: 'ollama', providerLabel: 'Ollama', usageProvider: 'elowen-ollama',
  usage: null, cards: [], queued: [],
  statusline: { showModel: true, showContext: false, showTokens: false, showCost: false },
};

class FakeES {
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

let status: Record<string, unknown> = STATUS;
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json(status)),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); localStorage.clear(); status = STATUS; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('chat header provider identity', () => {
  // The compact statusline shows only the model; its title retains the public provider identity.
  // Passing `provider` instead of `providerLabel || provider` loses the operator label.
  it('names the provider by the operator label, never by the internal registry name', async () => {
    renderSurface();
    const statusline = await screen.findByTestId('chat-statusline');
    const model = statusline.querySelector('[data-stat="model"]');
    expect(model).toHaveTextContent('kimi-k2.7-code');
    expect(model).toHaveAttribute('title', 'Ollama/kimi-k2.7-code');
    expect(statusline).not.toHaveTextContent('Ollama/');
    expect(statusline.innerHTML).not.toContain('elowen-ollama');
  });

  // A provider removed in Settings leaves its id behind on the conversation and no label. The id is
  // already the PUBLIC name, so the header stays readable instead of losing the provider entirely.
  it('falls back to the provider config id when the operator label is gone', async () => {
    status = { ...STATUS, providerLabel: '' };
    renderSurface();
    const statusline = await screen.findByTestId('chat-statusline');
    const model = statusline.querySelector('[data-stat="model"]');
    expect(model).toHaveTextContent('kimi-k2.7-code');
    expect(model).toHaveAttribute('title', 'ollama/kimi-k2.7-code');
    expect(statusline).not.toHaveTextContent('ollama/');
  });
});
