import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { ChatView } from '../../../modules/chat/ChatView';
import { ChatRailSplit } from '../../../modules/advisor/ChatRailSplit';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';
import { useMobileViewport } from '../../../lib/useMobile';

/** Minimal EventSource stand-in — the test only needs to count how many streams get constructed to
 *  prove the single-controller invariant (one stream no matter how many surfaces mount). */
class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener() {}
  close() { this.closed = true; }
}

class FakeVisualViewport extends EventTarget {
  width: number;
  height: number;
  offsetTop = 0;
  constructor(height: number, width = 390) { super(); this.height = height; this.width = width; }
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', () => HttpResponse.json({ ok: true }, { status: 202 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([
    { id: 'brain-1', title: 'First chat', model: 'm', updated_at: '2026-07-08', running: false, active: true },
    { id: 'brain-2', title: 'Second chat', model: 'm2', updated_at: '2026-07-07', running: false, active: false },
  ])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The chat page as the SHELL composes it: the telemetry dock is a resizable panel BESIDE the page, not a
 *  child of it, so a harness rendering ChatView alone would exercise a layout the app no longer has. */
function ChatPage() {
  const mobile = useMobileViewport();
  return <ChatRailSplit workspace={<ChatView />} docked={mobile === false} />;
}

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>{node}</TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>);
}

describe('ChatView (/chat page)', () => {
  it('hosts the full surface off ONE controller / ONE EventSource, history hidden by default', async () => {
    renderChat(<ChatView />);
    // The full composer mounts. The ACTIVE conversation's name is in the toolbar — it is the switcher that
    // opens the history — while the other conversations stay in the history surface until it is opened.
    expect(await screen.findByPlaceholderText(/Write a message|Napište zprávu/i)).toBeInTheDocument();
    expect(await screen.findByTestId('chat-conversation-switcher')).toHaveTextContent('First chat');
    expect(screen.queryByText('Second chat')).toBeNull();
    // …and exactly one stream is opened (no second controller / no reconnect).
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
  });

  // /chat was the one route in the app with no level-1 heading at all: its title was a styled span, and
  // the hero carrying it was withheld from small screens entirely, so a screen reader had nothing to
  // orient by. The heading is deliberately compact — visual size and semantic level are independent —
  // and it must be present at every width, so the hero mounts unconditionally.
  it('gives the page a real level-1 heading', async () => {
    renderChat(<ChatView />);
    expect(await screen.findByRole('heading', { level: 1, name: /^(Chat)$/ })).toBeInTheDocument();
  });

  it('opens one stream even with the dock chat surface AND /chat mounted together', async () => {
    renderChat(<><BrainChat /><ChatView /></>);
    await screen.findAllByPlaceholderText(/Write a message|Napište zprávu/i);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
  });

  it('opens the history drawer from the conversation name in the toolbar', async () => {
    renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // Drawer closed: its dialog is aria-hidden and not in the a11y tree.
    expect(screen.queryByRole('dialog', { name: /Conversation history|Historie konverzací/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Conversation history|Historie konverzací/i }));
    expect(screen.getByRole('dialog', { name: /Conversation history|Historie konverzací/i })).toBeInTheDocument();
  });

  it('opens the conversation register from the history drawer and hands a row to the page surface', async () => {
    renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    fireEvent.click(screen.getByRole('button', { name: /Conversation history|Historie konverzací/i }));

    // The drawer's footer entry opens the full register (BrainSessionsPanel) as a modal and dismisses
    // the drawer — the register is core data and must stay reachable without the agents plugin.
    fireEvent.click(screen.getByRole('button', { name: /All conversations|Všechny konverzace/i }));
    const modal = await screen.findByRole('dialog', { name: /All conversations|Všechny konverzace/i });
    expect(screen.queryByRole('dialog', { name: /Conversation history|Historie konverzací/i })).toBeNull();
    expect(await screen.findByTestId('brain-sessions-list')).toBeInTheDocument();

    // Opening a row loads it into THIS page's surface, so the modal dismisses itself.
    fireEvent.click(await screen.findByRole('button', { name: /Open in web chat: Second chat/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /All conversations|Všechny konverzace/i })).toBeNull());
    expect(modal).not.toBeInTheDocument();
  });

  // The redesign replaced "hidden" with a real 52px stub, and that compact strip is what a desktop visit
  // ARRIVES at: the rail is an ambient instrument edge, not a dashboard claiming 340px unasked. The page's
  // header toggle is the other end of that one state, so it has to drive the shell-owned panel BOTH ways —
  // and collapsing must take the TELEMETRY away without taking the rail away, because the mascot is what a
  // reader keeps in the corner of their eye while a turn runs.
  it('arrives compact and expands the desktop telemetry rail from the header button', async () => {
    renderChat(<ChatPage />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    expect(await screen.findByTestId('telemetry-column')).toBeInTheDocument();
    // Docked but compact: the stub, not the three-zone rail.
    expect(await screen.findByTestId('telemetry-stub')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-head')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^(Show telemetry|Zobrazit telemetrii)$/i }));
    await waitFor(() => expect(screen.getByTestId('telemetry-head')).toBeInTheDocument());
    expect(screen.queryByTestId('telemetry-stub')).toBeNull();

    // The same control puts it back — expansion must not be a one-way door either.
    fireEvent.click(screen.getByRole('button', { name: /^(Hide telemetry|Skrýt telemetrii)$/i }));
    await waitFor(() => expect(screen.getByTestId('telemetry-stub')).toBeInTheDocument());
    // Still docked, still reporting the agent — just not the metrics.
    expect(screen.getByTestId('telemetry-column')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-head')).toBeNull();
  });

  it('toggling the telemetry rail keeps ONE stream, preserves the draft, and never remounts the surface', async () => {
    const { container } = renderChat(<ChatPage />);
    const composer = await screen.findByPlaceholderText(/Write a message|Napište zprávu/i) as HTMLTextAreaElement;
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    // Type a draft and capture the surface node identity before toggling.
    fireEvent.change(composer, { target: { value: 'draft survives' } });
    const surface = container.querySelector('[data-variant="full"]');
    expect(surface).not.toBeNull();

    // The rail is a sibling column, so resizing it must not take the chat down with it: the surface
    // element, the single EventSource and the composer draft all have to survive the layout change. The
    // rail starts compact, so the first move is the expansion and the second is back to the stub.
    fireEvent.click(screen.getByRole('button', { name: /^(Show telemetry|Zobrazit telemetrii)$/i }));
    expect(container.querySelector('[data-variant="full"]')).toBe(surface);
    expect(FakeES.instances.length).toBe(1);
    expect(composer.value).toBe('draft survives');

    fireEvent.click(screen.getByRole('button', { name: /^(Hide telemetry|Skrýt telemetrii)$/i }));
    expect(container.querySelector('[data-variant="full"]')).toBe(surface);
    expect(FakeES.instances.length).toBe(1);
    expect(composer.value).toBe('draft survives');
  });

  it('opens a selected conversation at its newest message', async () => {
    server.use(http.post('*/api/brain/start', async ({ request }) => {
      const body = await request.json() as { session?: string };
      return HttpResponse.json({ sessionId: body.session ?? 'brain-1' }, { status: 201 });
    }));
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(
      <Wrapper><ToastProvider><BrainChatProvider><main><ChatView /></main></BrainChatProvider></ToastProvider></Wrapper>,
    );
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    const main = container.querySelector('main')!;
    Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1400 });
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Conversation history|Historie konverzací/i }));
    // ActivityStatus is intentionally part of the row's accessible name, so keep the selector exact and
    // assert that the neutral activity state remains announced alongside the conversation identity.
    const second = screen.getByRole('button', { name: /^No recent activity Second chat m2$/i });
    expect(second).toHaveAccessibleName('No recent activity Second chat m2');
    fireEvent.click(second);

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1400 }));
    scrollTo.mockRestore();
  });

  it('keeps the newest message pinned while the composer grows', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(
      <Wrapper><ToastProvider><BrainChatProvider><main><ChatView /></main></BrainChatProvider></ToastProvider></Wrapper>,
    );
    const composer = await screen.findByPlaceholderText(/Write a message|Napište zprávu/i) as HTMLTextAreaElement;
    const main = container.querySelector('main')!;
    Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1600 });
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 120 });
    scrollTo.mockClear();

    fireEvent.change(composer, { target: { value: 'A long wrapped message that grows the composer.' } });

    expect(composer.style.height).toBe('120px');
    expect(scrollTo).toHaveBeenCalledWith({ top: 1600 });
    scrollTo.mockRestore();
  });

  it('uses the visual viewport for an iOS-like keyboard without double-applying the safe area', async () => {
    const originalViewport = window.visualViewport;
    const originalInnerHeight = window.innerHeight;
    const originalScale = document.documentElement.style.getPropertyValue('--ui-scale');
    const viewport = new FakeVisualViewport(844);
    const scale = 0.8;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    try {
      const { container } = renderChat(<main><ChatView /></main>);
      const composer = await screen.findByTestId('chat-composer');
      const dock = screen.getByTestId('chat-composer-dock');
      const surface = dock.closest<HTMLElement>('[data-variant="full"]')!;
      const main = container.querySelector('main')!;
      Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 88 });
      Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1600 });
      scrollTo.mockClear();

      composer.focus();
      viewport.height = 500;
      viewport.dispatchEvent(new Event('resize'));

      await waitFor(() => expect(surface).toHaveAttribute('data-chat-keyboard-open', 'true'));
      const expectedOffset = (window.innerHeight - viewport.offsetTop - viewport.height) / scale;
      expect(parseFloat(surface.style.getPropertyValue('--chat-visual-bottom-offset'))).toBeCloseTo(expectedOffset, 0);
      expect(surface.style.getPropertyValue('--chat-composer-height')).toBe('88px');
      expect(scrollTo).toHaveBeenCalledWith({ top: 1600 });
    } finally {
      scrollTo.mockRestore();
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalViewport });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
      if (originalScale) document.documentElement.style.setProperty('--ui-scale', originalScale);
      else document.documentElement.style.removeProperty('--ui-scale');
    }
  });

  /** A phone's toolbar is the conversation name and ⋯. Reasoning, telemetry and new chat are still one
   *  tap away — inside the menu, as icon rows — instead of squeezing the name down to a letter. */
  it('folds reasoning, telemetry and new chat into the ⋯ menu on a phone', async () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...original(query), matches: /max-width/.test(query) });
    try {
      renderChat(<ChatView />);
      await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
      expect(screen.queryByRole('button', { name: /^Reasoning$|^Uvažování$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^New chat$|^Nový chat$/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /More options|Další možnosti/i }));
      expect(screen.getByRole('button', { name: /^Reasoning$|^Uvažování$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Show telemetry|Zobrazit telemetrii/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^New chat$|^Nový chat$/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Reasoning$|^Uvažování$/ }));
      expect(await screen.findByRole('dialog', { name: /Reasoning|Uvažování/ })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('keeps the chat fill height stable when a phone resizes while scrolled', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(
      <Wrapper><ToastProvider><BrainChatProvider><main><ChatView /></main></BrainChatProvider></ToastProvider></Wrapper>,
    );
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);

    const transcript = screen.getByTestId('chat-transcript');
    const host = transcript.parentElement!.parentElement!.parentElement!;
    const main = container.querySelector('main')!;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(main, 'scrollTop', { configurable: true, value: 900, writable: true });
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: -800 } as DOMRect);

    fireEvent(window, new Event('resize'));

    await waitFor(() => expect(host.style.minHeight).toBe('744px'));
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  });
});
