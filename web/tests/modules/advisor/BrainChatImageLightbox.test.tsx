import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// Every picture in a conversation — an attachment the user sent, one the agent shared or generated, one it
// read — opens in the app's own dialog. Navigating the tab to the raw file instead used to throw the reader
// out of the chat and back, losing the scroll position and the streaming turn. These pin the contract that
// replaced it: a real button, a dialog, Escape, and no anchor left to navigate.

const FILE = '9a8b7c6d-5e4f-4321-8899-aabbccddeeff.png';
const REF = `/api/brain/chat-images/${FILE}`;
const STORED = { url: `/brain/chat-images/${FILE}`, mimeType: 'image/png' };

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-08-05', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderSurface(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  return FakeES.instances[0]!;
}

/** The one control every picture in the transcript is wrapped in. */
const trigger = () => screen.findByRole('button', { name: /plné velikosti|full size|plnej veľkosti/i });

/** A `button` activates on Enter through the browser's own click synthesis, which jsdom does not do; the
 *  keyboard path is therefore exercised as the click the browser would raise on the focused control. */
const activate = async (control: HTMLElement) => { await act(async () => { fireEvent.click(control); }); };

describe('a picture in the transcript', () => {
  it('is a real button, not a link that would navigate away from the chat', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });

    const control = await trigger();
    expect(control.tagName).toBe('BUTTON');
    expect(control.closest('a')).toBeNull();
    expect(within(control).getByRole('img').getAttribute('src')).toBe(REF);
  });

  it('opens the shared dialog when clicked, showing the same file', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });

    await activate(await trigger());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('image-lightbox').getAttribute('src')).toBe(REF);
  });

  it('is operable and visible from the keyboard, with a name that says what it does', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });

    const control = await trigger();
    // A native button carries Enter/Space activation and tab order itself; what a call site still owes is
    // the accessible name (the alt text alone would only say "attached image") and a visible focus ring.
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('aria-label')).toBeTruthy();
    expect(control.className).toContain('focus-visible:ring-2');
    control.focus();
    expect(document.activeElement).toBe(control);
  });

  it('closes on Escape and hands focus back to the picture it came from', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const control = await trigger();
    control.focus();
    await activate(control);
    const dialog = await screen.findByRole('dialog');

    // Raised inside the dialog, the way a real Escape arrives: it is Radix's dismissable layer that reads
    // the key off the document the event bubbles through.
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }); });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(control));
  });

  it('keeps the authenticated file reachable as its own named action inside the dialog', async () => {
    // The click on the picture is no longer the download; the explicit action is, and it still points at
    // the same proxy path the <img> loads.
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    await activate(await trigger());

    const dialog = await screen.findByRole('dialog');
    const link = within(dialog).getByRole('link', { name: /nové kartě|new tab|novej karte/i });
    expect(link.getAttribute('href')).toBe(REF);
  });

  it('draws the picture contained, so a tall screenshot cannot overflow the dialog', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    await activate(await trigger());

    const image = within(await screen.findByRole('dialog')).getByTestId('image-lightbox');
    expect(image.className).toContain('object-contain');
    expect(image.className).toContain('max-h-full');
  });

  it('uses the very same control for a picture the agent READ, rebuilt from stored history', async () => {
    const es = await renderSurface();
    es.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, events: [],
      history: [{
        id: 'm1', role: 'assistant', text: '',
        segments: [
          { kind: 'tool', name: 'Read', id: 'r1', detail: 'logo.png' },
          { kind: 'image', image: STORED },
        ],
      }],
    });

    await activate(await trigger());

    expect(within(await screen.findByRole('dialog')).getByTestId('image-lightbox').getAttribute('src')).toBe(REF);
  });

  it('uses it for an attachment the user sent too', async () => {
    const es = await renderSurface();
    es.emit('user', { type: 'user', text: 'co je na tomhle?', images: [STORED] });

    await activate(await trigger());

    expect(within(await screen.findByRole('dialog')).getByTestId('image-lightbox').getAttribute('src')).toBe(REF);
  });
});
