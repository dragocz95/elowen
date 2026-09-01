import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// An image the agent shares (`ShareImage`) has to look the same twice: once when the `image` frame lands
// mid-turn, and again when the page is reloaded and the same picture comes back as a stored segment. The
// two carry DIFFERENT paths on the wire — the event's `ref` already has the `/api` proxy prefix, the
// stored segment does not — so the danger is a src that is prefixed twice, or not at all. These pin the
// rendered `<img>` on both routes.

const FILE = '9a8b7c6d-5e4f-4321-8899-aabbccddeeff.png';
const REF = `/api/brain/chat-images/${FILE}`;
const SRC = `/api/brain/chat-images/${FILE}`;
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

const shared = () => screen.findByRole('img', { name: /obrázek|image|obrázok/i });

/** The transcript as a reloaded page receives it: durable history with the stored image segment. */
const reloadFrame = (caption?: string) => ({
  type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, events: [],
  history: [{
    id: 'm1', role: 'assistant', text: '',
    segments: [{ kind: 'image', image: STORED, ...(caption ? { caption } : {}) }],
  }],
});

describe('an image the agent shares', () => {
  it('appears in the transcript as soon as the frame lands', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF, id: 'call-1' });
    expect((await shared()).getAttribute('src')).toBe(SRC);
  });

  it('is still there after a reload, rebuilt from the stored segment alone', async () => {
    const es = await renderSurface();
    es.emit('snapshot', reloadFrame());
    expect((await shared()).getAttribute('src')).toBe(SRC);
  });

  it('points live and reloaded at the very same file', async () => {
    const live = await renderSurface();
    live.emit('image', { type: 'image', ref: REF });
    const fromStream = (await shared()).getAttribute('src');

    cleanup();
    FakeES.instances.length = 0;
    const reloaded = await renderSurface();
    reloaded.emit('snapshot', reloadFrame());
    expect((await shared()).getAttribute('src')).toBe(fromStream);
  });

  it('carries the proxy prefix exactly once, so the browser can actually fetch it', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const src = (await shared()).getAttribute('src') ?? '';
    expect(src.match(/\/api\//g)?.length).toBe(1);
    expect(src.startsWith('/api/brain/chat-images/')).toBe(true);
  });

  it('shows the caption the agent sent with it', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF, caption: 'graf latence po nasazení' });
    await shared();
    expect(await screen.findByText('graf latence po nasazení')).toBeTruthy();
  });

  it('shows the stored caption after a reload too', async () => {
    const es = await renderSurface();
    es.emit('snapshot', reloadFrame('graf latence po nasazení'));
    expect(await screen.findByText('graf latence po nasazení')).toBeTruthy();
  });

  it('keeps two shared images apart, each with its own caption', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF, caption: 'před nasazením' });
    es.emit('image', { type: 'image', ref: '/api/brain/images/abc123.png', caption: 'po nasazení' });
    await waitFor(async () => expect((await screen.findAllByRole('img', { name: /obrázek|image|obrázok/i })).length).toBe(2));
    const captions = screen.getAllByText(/nasazen/).map((el) => el.textContent);
    expect(captions).toEqual(['před nasazením', 'po nasazení']);
  });

  it('is clickable through the shared lightbox trigger rather than a link out of the app', async () => {
    // The full-size view now opens in the app's own dialog (BrainChatImageLightbox.test.tsx pins that
    // behaviour); what matters here is that the shared image reaches the same control as every other one.
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const image = await shared();
    expect(image.closest('a')).toBeNull();
    expect(image.closest('button')).not.toBeNull();
  });

  it('still renders an image tool result served from the older path', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: '/api/brain/images/abc123.png' });
    expect((await shared()).getAttribute('src')).toBe('/api/brain/images/abc123.png');
  });

  it('keeps the surrounding reply text in order around it', async () => {
    const es = await renderSurface();
    es.emit('text', { type: 'text', delta: 'tady je ten graf' });
    es.emit('image', { type: 'image', ref: REF });
    await shared();
    expect(await screen.findByText('tady je ten graf')).toBeTruthy();
  });
});

describe('a file the agent shares', () => {
  const hash = `${'a'.repeat(64)}.bin`;
  const ref = `/api/brain/chat-files/${hash}`;
  const file = { url: `/brain/chat-files/${hash}`, name: 'jednatele-chetty-webhouse.htm', size: 1536 };

  it('appears live as a named download with its size', async () => {
    const es = await renderSurface();
    es.emit('file', { type: 'file', ref, name: file.name, size: file.size, caption: 'Dokument k archivaci' });

    const action = await screen.findByRole('link', { name: new RegExp(file.name) });
    expect(action.getAttribute('href')).toBe(ref);
    expect(action.getAttribute('download')).toBe(file.name);
    expect(await screen.findByText('1.5 KB')).toBeTruthy();
    expect(await screen.findByText('Dokument k archivaci')).toBeTruthy();
  });

  it('is rebuilt as the same download after a reload', async () => {
    const es = await renderSurface();
    es.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, events: [],
      history: [{ id: 'm1', role: 'assistant', text: '', segments: [{ kind: 'file', file }] }],
    });

    const action = await screen.findByRole('link', { name: new RegExp(file.name) });
    expect(action.getAttribute('href')).toBe(ref);
    expect(action.getAttribute('download')).toBe(file.name);
  });
});
