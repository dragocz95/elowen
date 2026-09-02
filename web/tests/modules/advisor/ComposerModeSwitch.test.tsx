import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** EventSource stand-in — the surface only needs the stream to exist and to be drivable by hand. */
class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { /* nothing to tear down */ }
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

let sendBodies: Record<string, unknown>[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', async ({ request }) => { sendBodies.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ ok: true }, { status: 202 }); }),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Katalog dílů', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  // The catalog the daemon publishes for the web surface. The non-mode commands exist here so the menu can
  // prove it lists ONLY the kind:'mode' rows — a picker or action command never becomes a mode row.
  http.get('*/api/brain/commands', () => HttpResponse.json({
    commands: [
      { name: 'plan', description: 'Plan mode', kind: 'mode' },
      { name: 'build', description: 'Build mode', kind: 'mode' },
      { name: 'workflow', description: 'Workflow mode', kind: 'mode' },
      { name: 'rename', description: 'Rename this conversation', kind: 'picker' },
      { name: 'model', description: 'Switch the model', kind: 'picker' },
      { name: 'goal', description: 'Create, inspect, pause, resume or clear a persistent goal', kind: 'action', execution: 'session-control', argument: { kind: 'text' } },
    ],
  })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; sendBodies = []; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** Open the mode menu by pressing the switch, as the user's click does. Radix DropdownMenu opens on
 *  pointerdown, never on hover — the same harness pattern the TelemetryMascotMenu tests use. */
async function openMenu() {
  const trigger = await screen.findByTestId('chat-work-mode-switch');
  await act(async () => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }); });
  return { trigger, menu: await screen.findByTestId('chat-work-mode-menu') };
}

async function send(text: string) {
  const composer = await screen.findByRole('textbox');
  act(() => fireEvent.change(composer, { target: { value: text } }));
  await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
}

describe('composer work-mode switch', () => {
  it('shows the current mode (build by default) and sits before send in the composer row', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const trigger = await screen.findByTestId('chat-work-mode-switch');
    expect(trigger).toHaveTextContent('Build');
    // DOM order, not just visual order: the switch is in the natural tab order right before send.
    const send = screen.getByTestId('chat-send');
    expect(trigger.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And among the composer row's buttons the switch comes first, send last.
    const form = send.closest('form')!;
    const row = [...form.querySelectorAll('button')].filter((b) => b === trigger || b === send);
    expect(row).toEqual([trigger, send]);
  });

  it('opens on click — and never on hover', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const trigger = await screen.findByTestId('chat-work-mode-switch');
    expect(screen.queryByTestId('chat-work-mode-menu')).toBeNull();

    // A pointer drifting across the switch must not raise the menu: only a press opens it.
    await act(async () => { fireEvent.pointerEnter(trigger, { pointerType: 'mouse' }); });
    fireEvent.mouseEnter(trigger);
    await act(async () => { fireEvent.pointerOver(trigger, { pointerType: 'mouse' }); });
    await act(async () => { fireEvent.mouseOver(trigger); });
    expect(screen.queryByTestId('chat-work-mode-menu')).toBeNull();

    await openMenu();
    expect(screen.getByTestId('chat-work-mode-menu')).toBeInTheDocument();
  });

  it('lists only the catalog\u2019s mode commands, each with its one-line description', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const { menu } = await openMenu();
    const group = within(menu).getByRole('group');
    // Each row's accessible name leads with the mode label; the hint rides after it — the dictionary's
    // line in the reader's language, not the catalog's English description.
    expect(within(group).getByRole('menuitemradio', { name: /^Build/ })).toBeInTheDocument();
    expect(within(group).getByRole('menuitemradio', { name: /^Plan/ })).toBeInTheDocument();
    expect(within(group).getByRole('menuitemradio', { name: /^Workflow/ })).toBeInTheDocument();
    expect(within(group).getByText('Think the approach through before editing')).toBeInTheDocument();
    expect(within(group).queryByText('Plan mode')).toBeNull();
    // Picker and action commands never become mode rows.
    expect(within(menu).queryByRole('menuitemradio', { name: /^Rename/ })).toBeNull();
    expect(within(menu).queryByRole('menuitemradio', { name: /^Model/ })).toBeNull();
    expect(within(menu).queryByRole('menuitemradio', { name: /^Goal/ })).toBeNull();
  });

  it('reflects the current mode on the radio group', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const { menu } = await openMenu();
    const group = within(menu).getByRole('group');
    expect(within(group).getByRole('menuitemradio', { name: /^Build/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('menuitemradio', { name: /^Plan/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('choosing Plan switches the mode through the same slash path (toast + send stamp)', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const { menu } = await openMenu();
    await act(async () => { fireEvent.click(within(within(menu).getByRole('group')).getByRole('menuitemradio', { name: /^Plan/ })); });
    // The menu closes and the trigger now names the new mode…
    await waitFor(() => expect(screen.queryByTestId('chat-work-mode-menu')).toBeNull());
    expect(screen.getByTestId('chat-work-mode-switch')).toHaveTextContent('Plan');
    // …the SAME toast the slash command raises appears…
    expect(await screen.findByText('Work mode: Plan')).toBeInTheDocument();
    // …and the next send is stamped plan, exactly as a typed /plan stamps it.
    await send('rozmysli to');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: 'rozmysli to', mode: 'plan' });
  });

  it('switches back to Build and the quiet styling returns with it', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const { trigger, menu } = await openMenu();
    await act(async () => { fireEvent.click(within(within(menu).getByRole('group')).getByRole('menuitemradio', { name: /^Plan/ })); });
    await waitFor(() => expect(trigger).toHaveTextContent('Plan'));
    const reopened = await openMenu();
    await act(async () => { fireEvent.click(within(within(reopened.menu).getByRole('group')).getByRole('menuitemradio', { name: /^Build/ })); });
    await waitFor(() => expect(trigger).toHaveTextContent('Build'));
    await send('do it');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ mode: 'build' });
  });

  it('closes on Escape and returns focus to the switch', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const { trigger, menu } = await openMenu();
    await act(async () => { fireEvent.keyDown(menu, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByTestId('chat-work-mode-menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('pulses the stop button only while busy — and never the send button', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    // Idle: send is on screen and carries no pulse.
    const send = await screen.findByTestId('chat-send');
    expect(send).not.toHaveClass('animate-stop-pulse');
    expect(screen.queryByTestId('chat-stop')).toBeNull();

    // Busy: send is replaced by stop, and stop — and only stop — carries the pulse class.
    const es = FakeES.instances[0];
    if (!es) throw new Error('no stream opened');
    act(() => {
      es.emit({ type: 'snapshot', history: [], events: [], control: { streaming: true, pendingAsk: null, workMode: 'build', pendingPlan: null } });
    });
    const stop = await screen.findByTestId('chat-stop');
    expect(stop).toHaveClass('animate-stop-pulse');
    expect(screen.queryByTestId('chat-send')).toBeNull();

    // Settled: the pulse leaves with the busy state.
    act(() => {
      es.emit({ type: 'snapshot', history: [], events: [], control: { streaming: false, pendingAsk: null, workMode: 'build', pendingPlan: null } });
    });
    await screen.findByTestId('chat-send');
    expect(screen.getByTestId('chat-send')).not.toHaveClass('animate-stop-pulse');
    expect(screen.queryByTestId('chat-stop')).toBeNull();
  });
});