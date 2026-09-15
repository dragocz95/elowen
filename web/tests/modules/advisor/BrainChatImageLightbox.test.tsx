import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// What clicking a picture in the conversation opens.
//
// It used to be the app's own dialog: a header with a title and a close button, a bordered card, and the
// picture letterboxed inside that card. For an image that is the wrong shape — the reader came for the
// picture, and everything drawn around it is in its way — so the full-size view is the picture itself over
// a calm backdrop and nothing else. What the frame used to CARRY is still required of it: Escape, focus
// back on the thumbnail, dismissal on a press beside the picture, no dismissal on a press of it, the
// conversation behind it inert and unscrollable. These pin both halves, because the second one is what
// makes the first one safe to remove.

const FILE = '9a8b7c6d-5e4f-4321-8899-aabbccddeeff.png';
const REF = `/api/brain/chat-images/${FILE}`;
const STORED = { url: `/brain/chat-images/${FILE}`, mimeType: 'image/png' };

/** The accessible name the full-size view states instead of showing, in every shipped locale. */
const VIEWER = /image preview|náhled obrázku|náhľad obrázka/i;
/** The one control every picture in the transcript is wrapped in. */
const TRIGGER = /plné velikosti|full size|plnej veľkosti/i;

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

/** A `button` activates on Enter through the browser's own click synthesis, which jsdom does not do; the
 *  keyboard path is therefore exercised as the click the browser would raise on the focused control. */
const activate = async (control: HTMLElement) => { await act(async () => { fireEvent.click(control); }); };

/** Open the full-size view and hand back the three nodes it is made of: the scrim the reader dismisses,
 *  the surface that holds the picture, and the picture. */
async function openViewer() {
  const control = await screen.findByRole('button', { name: TRIGGER });
  control.focus();
  await activate(control);
  const dialog = await screen.findByRole('dialog', { name: VIEWER });
  const layer = dialog.parentElement as HTMLElement;
  return { control, dialog, layer, image: within(dialog).getByTestId('image-lightbox') };
}

describe('a picture in the transcript', () => {
  it('is a real button, not a link that would navigate away from the chat', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });

    const control = await screen.findByRole('button', { name: TRIGGER });
    expect(control.tagName).toBe('BUTTON');
    expect(control.closest('a')).toBeNull();
    // The thumbnail says what it does and the picture says what it is.
    expect(control.getAttribute('aria-label')).toBeTruthy();
    expect(within(control).getByRole('img').getAttribute('src')).toBe(REF);
  });

  it('opens the picture alone: a backdrop and an image, with no dialog chrome drawn around it', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, image } = await openViewer();

    // Nothing to read and nothing to press — no title element, no close control, no action link. The
    // surface is named for a screen reader and shows nothing for an eye.
    expect(within(dialog).queryByRole('heading')).toBeNull();
    expect(within(dialog).queryByRole('button')).toBeNull();
    expect(within(dialog).queryByRole('link')).toBeNull();
    // One picture, and it is the surface's own child: no padded panel stands between them.
    expect(dialog.querySelectorAll('img')).toHaveLength(1);
    expect(image.tagName).toBe('IMG');
    expect(image.parentElement).toBe(dialog);
    expect(image.getAttribute('src')).toBe(REF);
    // The surface declines the shared card material outright: no ground, no drawn edge, and none of the
    // room a panel reserves for a title and a body of text (the size axis belongs to `card` alone). The
    // browser-side proof — computed background and shadow — is the Playwright geometry spec.
    expect(dialog.className).not.toContain('overlay-surface');
    expect(dialog.className).not.toContain('rounded-lg');
    expect(dialog.className).not.toContain('max-w-lg');
    expect(dialog.getAttribute('data-chrome')).toBe('bare');
  });

  it('is operable and visible from the keyboard, with a name that says what it does', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });

    const control = await screen.findByRole('button', { name: TRIGGER });
    // A native button carries Enter/Space activation and tab order itself; what a call site still owes is
    // a visible focus ring and a description of the picture it cannot show at full size.
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('aria-label')).toBeTruthy();
    expect(control.getAttribute('title')).toBeTruthy();
    expect(control.className).toContain('focus-visible:ring-2');
    control.focus();
    expect(document.activeElement).toBe(control);
  });

  it('caps the picture to the padded viewport, so a tall screenshot cannot overflow it', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, layer, image } = await openViewer();

    expect(image.className).toContain('object-contain');
    expect(image.className).toContain('max-h-full');
    expect(image.className).toContain('max-w-full');
    // Those percentages resolve against the surface, which is why it takes the whole padded box.
    expect(dialog.className).toContain('h-full');
    expect(dialog.className).toContain('w-full');
    // The padding is the backdrop's, and it is the safe area: a phone's notch and home indicator must
    // never cover the picture, in either orientation (`DialogOverlay`, presentation `center`).
    expect(layer.style.paddingBlock).toContain('--safe-top');
    expect(layer.style.paddingBlock).toContain('--safe-bottom');
    expect(layer.style.paddingInline).toContain('--safe-left');
    expect(layer.style.paddingInline).toContain('--safe-right');
  });

  it('says the full-size bytes are arriving, and stops saying it once they are here', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, image } = await openViewer();

    // A quiet status on the backdrop — the picture is already in the DOM, so nothing has to be found.
    expect(within(dialog).getByRole('status')).toBeTruthy();

    await act(async () => { fireEvent.load(image); });
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('states it when the full-size bytes cannot be had, instead of a broken glyph', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, image } = await openViewer();
    await act(async () => { fireEvent.load(image); });

    await act(async () => { fireEvent.error(image); });

    expect(within(dialog).queryByTestId('image-lightbox')).toBeNull();
    expect(within(dialog).getByTestId('image-lightbox-gone')).toBeTruthy();
    // The surface is still dismissable the same one way.
    await closeFromBackdrop(dialog);
  });

  it('closes on a press and release that both land on the backdrop', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog } = await openViewer();

    // Anywhere that is not the picture hit-tests on the scrim, so that is where a real browser aims the
    // pointer — and the scrim is the one thing that closes this.
    await closeFromBackdrop(dialog);
  });

  it('stays open when the click lands on the picture itself', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, image } = await openViewer();
    await act(async () => { fireEvent.pointerDown(image); fireEvent.click(image); });

    expect(screen.getByRole('dialog', { name: VIEWER })).toBe(dialog);
  });

  it('stays open when a press starts on the picture and the release lands on the backdrop', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, layer, image } = await openViewer();

    // A drag out of the picture ends on the backdrop with `target === currentTarget`, otherwise
    // indistinguishable from a real backdrop click — the rule `Modal.tsx` states.
    await act(async () => { fireEvent.pointerDown(image); fireEvent.click(layer); });

    expect(screen.getByRole('dialog', { name: VIEWER })).toBe(dialog);
  });

  it('closes on Escape and hands focus back to the picture it came from', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { control, dialog } = await openViewer();

    // Raised inside the surface, the way a real Escape arrives: Radix's dismissable layer reads the key
    // off the document the event bubbles through.
    await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }); });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(control));
  });

  it('leaves the conversation inert and the page unscrollable while it is up', async () => {
    const es = await renderSurface();
    es.emit('image', { type: 'image', ref: REF });
    const { dialog, layer } = await openViewer();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The app's own overlay stack does this — no second lightbox keeps its own copy of the policy.
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
    const others = Array.from(document.body.children)
      .filter((node): node is HTMLElement => node instanceof HTMLElement
        && node !== layer && !node.hasAttribute('data-overlay-exempt'));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((node) => node.inert)).toBe(true);

    await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }); });
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });

  it('uses the very same surface for a picture the agent READ, rebuilt from stored history', async () => {
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

    const { dialog, image } = await openViewer();
    expect(image.getAttribute('src')).toBe(REF);
    expect(within(dialog).queryByRole('heading')).toBeNull();
  });

  it('uses it for an attachment the user sent too', async () => {
    const es = await renderSurface();
    es.emit('user', { type: 'user', text: 'co je na tomhle?', images: [STORED] });

    const { dialog, image } = await openViewer();
    expect(image.getAttribute('src')).toBe(REF);
    expect(within(dialog).queryByRole('button')).toBeNull();
  });
});

/** Press AND release on the scrim: a bare click is not a sequence a browser produces, and the backdrop
 *  dismisses only on a press that began on it. */
async function closeFromBackdrop(dialog: HTMLElement): Promise<void> {
  const layer = dialog.parentElement as HTMLElement;
  await act(async () => { fireEvent.pointerDown(layer); fireEvent.click(layer); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}
