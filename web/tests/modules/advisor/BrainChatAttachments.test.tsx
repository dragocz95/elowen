import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The last link of the attachment path: a turn carrying images has to end up as an <img> the browser can
// actually fetch. It goes through the same-origin `/api` proxy, which turns the httpOnly session cookie
// into the daemon bearer — that is why no signed URL is involved, and why the `/api` prefix matters.
// (That the reloaded history produces the same turn shape as this live one is pinned in
// tests/lib/transcriptImages.test.ts.)

const FILE = '1e2d3c4b-5a69-4788-9aab-bbccddeeff00.png';
const IMAGE = { url: `/brain/chat-images/${FILE}`, mimeType: 'image/png' };

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

async function renderSurface(variant: 'full' | 'compact'): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant={variant} /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  return FakeES.instances[0]!;
}

const attachment = () => screen.findByRole('img', { name: /obrázek|image|obrázok/i });

describe('a user turn with attachments', () => {
  it('draws the image, pointed through the authenticated proxy', async () => {
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'mrkni na tohle', durableId: 'm1', images: [IMAGE] }));
    expect((await attachment()).getAttribute('src')).toBe(`/api/brain/chat-images/${FILE}`);
  });

  /** The bytes can legitimately be gone: the daily sweep reclaims unreferenced files, and a read-only
   *  transcript asks for an image the daemon serves only to its owner. Left alone the browser draws its
   *  broken-image glyph, which reads as a broken CHAT rather than a missing picture — and the surrounding
   *  link would then lead to a 404. */
  it('replaces an image that no longer loads with a stated placeholder, not a broken glyph', async () => {
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'mrkni na tohle', durableId: 'm1', images: [IMAGE] }));
    const img = await attachment();
    await act(async () => { fireEvent.error(img); });

    expect(screen.queryByRole('img', { name: /obrázek|image|obrázok/i })).toBeNull();
    expect(screen.getByText(/no longer available|už není k dispozici|už nie je k dispozícii/i)).toBeInTheDocument();
    // No click-through either: a link to a 404 is worse than no link.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('lets the thumbnail open the full-size view, in the app rather than a new page', async () => {
    // The dialog itself is pinned in BrainChatImageLightbox.test.tsx; here the point is only that a user's
    // own attachment reaches the same shared control every other picture in the chat uses.
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'mrkni na tohle', durableId: 'm1', images: [IMAGE] }));
    const img = await attachment();
    expect(img.closest('a')).toBeNull();
    expect(img.closest('button')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('caps the width on the frame, so the border hugs the picture', async () => {
    // A percentage max-width on the <img> is ignored while the flex item measures its content, so a wide
    // picture capped only by height left the frame sized for the uncapped width, with the border hanging
    // around empty space. The cap therefore belongs to the frame; the picture just fills it.
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'mrkni na tohle', durableId: 'm1', images: [IMAGE] }));
    const img = await attachment();

    expect(img.closest('button')?.className).toContain('max-w-[min(16rem,100%)]');
    expect(img.className).toContain('max-w-full');
    expect(img.className).not.toMatch(/max-w-\[/);
  });

  it('keeps the message text beside it', async () => {
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'mrkni na tohle', durableId: 'm1', images: [IMAGE] }));
    expect(await screen.findByText('mrkni na tohle')).toBeTruthy();
  });

  it('draws it in the compact dock too', async () => {
    const es = await renderSurface('compact');
    act(() => es.emit({ type: 'user', text: 'mrkni', durableId: 'm1', images: [IMAGE] }));
    expect((await attachment()).getAttribute('src')).toBe(`/api/brain/chat-images/${FILE}`);
  });

  it('shows nothing extra for a turn that has none', async () => {
    const es = await renderSurface('full');
    act(() => es.emit({ type: 'user', text: 'jen text', durableId: 'm1' }));
    await screen.findByText('jen text');
    expect(screen.queryByRole('img', { name: /obrázek|image|obrázok/i })).toBeNull();
  });
});
