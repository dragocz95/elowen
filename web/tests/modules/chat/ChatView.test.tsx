import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { ChatView } from '../../../modules/chat/ChatView';

/** Minimal EventSource stand-in — the test only needs to count how many streams get constructed to
 *  prove the single-controller invariant (one stream no matter how many surfaces mount). */
class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener() {}
  close() { this.closed = true; }
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

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider>{node}</BrainChatProvider></ToastProvider></Wrapper>);
}

describe('ChatView (/chat page)', () => {
  it('hosts the full surface off ONE controller / ONE EventSource, history hidden by default', async () => {
    renderChat(<ChatView />);
    // The full composer (the surface) mounts; the conversation list stays hidden until the drawer opens
    // (only the ACTIVE conversation's title shows in the header — a non-active list row must not render).
    expect(await screen.findByPlaceholderText(/Write a message|Napište zprávu/i)).toBeInTheDocument();
    expect(screen.queryByText('Second chat')).toBeNull();
    // …and exactly one stream is opened (no second controller / no reconnect).
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
  });

  it('opens one stream even with the dock chat surface AND /chat mounted together', async () => {
    renderChat(<><BrainChat /><ChatView /></>);
    await screen.findAllByPlaceholderText(/Write a message|Napište zprávu/i);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
  });

  it('opens the mobile history drawer from the surface header button', async () => {
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

  it('hides and restores the desktop telemetry rail from the header button, and remembers the choice', async () => {
    const { unmount } = renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    expect(await screen.findByTestId('telemetry-column')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^(Hide telemetry|Skrýt telemetrii)$/i }));
    expect(screen.queryByTestId('telemetry-column')).toBeNull();

    // The same control brings it back — a hidden rail must not be a one-way door.
    fireEvent.click(screen.getByRole('button', { name: /^(Show telemetry|Zobrazit telemetrii)$/i }));
    expect(screen.getByTestId('telemetry-column')).toBeInTheDocument();

    // Hidden is a per-device display choice, so it survives a remount.
    fireEvent.click(screen.getByRole('button', { name: /^(Hide telemetry|Skrýt telemetrii)$/i }));
    unmount();
    renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    await waitFor(() => expect(screen.queryByTestId('telemetry-column')).toBeNull());
  });

  it('toggling the telemetry rail keeps ONE stream, preserves the draft, and never remounts the surface', async () => {
    const { container } = renderChat(<ChatView />);
    const composer = await screen.findByPlaceholderText(/Write a message|Napište zprávu/i) as HTMLTextAreaElement;
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    // Type a draft and capture the surface node identity before toggling.
    fireEvent.change(composer, { target: { value: 'draft survives' } });
    const surface = container.querySelector('[data-variant="full"]');
    expect(surface).not.toBeNull();

    // The rail is a sibling column, so collapsing it must not take the chat down with it: the surface
    // element, the single EventSource and the composer draft all have to survive the layout change.
    fireEvent.click(screen.getByRole('button', { name: /^(Hide telemetry|Skrýt telemetrii)$/i }));
    expect(container.querySelector('[data-variant="full"]')).toBe(surface);
    expect(FakeES.instances.length).toBe(1);
    expect(composer.value).toBe('draft survives');

    fireEvent.click(screen.getByRole('button', { name: /^(Show telemetry|Zobrazit telemetrii)$/i }));
    expect(container.querySelector('[data-variant="full"]')).toBe(surface);
    expect(FakeES.instances.length).toBe(1);
    expect(composer.value).toBe('draft survives');
  });
});
