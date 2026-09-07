import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import type { StatuslineConfig } from '../../../lib/types';

// Which model a conversation runs on is one fact, so the chat offers ONE control for changing it. The
// statusline plugin already prints the model name under the conversation; where it does, that name becomes
// the picker and the top bar hands its own copy over. Where the plugin is off — or has its model toggle
// off, or the reader has collapsed the row — the bar keeps the control, because a surface with the picker
// nowhere is worse than one with it twice.
//
// `BrainStatus.statusline` is null exactly when the plugin is disabled, which is what makes it the single
// source of truth here: no second flag, no prop threaded from a settings page.

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const CATALOG = [
  { provider: 'anthropic-oauth', providerLabel: 'Claude', model: 'claude-opus', source: 'oauth', exec: 'elowen:anthropic-oauth/claude-opus', contextWindow: 200_000, contextWindowSet: true },
  { provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'gpt-5.6-sol', source: 'oauth', exec: 'elowen:chatgpt-account/gpt-5.6-sol', contextWindow: 200_000, contextWindowSet: true },
];

/** `null` is the daemon's way of saying the statusline plugin is not enabled. */
let statusline: StatuslineConfig | null = { showModel: true };
/** Every model switch that reached the wire. */
let switched: unknown[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'claude-opus', provider: 'anthropic-oauth', providerLabel: 'Claude',
    usage: null, statusline, cards: [], queued: [],
  })),
  http.get('*/api/brain/models', () => HttpResponse.json(CATALOG)),
  http.post('*/api/brain/model', async ({ request }) => {
    switched.push(await request.json());
    return HttpResponse.json({ ok: true });
  }),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ tasks: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  statusline = { showModel: true };
  switched = [];
  setViewport(false);
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());

async function renderSurface(): Promise<HTMLElement> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  return screen.findByTestId('chat-statusline');
}

/** Every model picker currently mounted, wherever it sits. */
const pickers = () => screen.queryAllByTestId('chat-model-picker');

describe('model switcher — the statusline owns it while it is showing one', () => {
  it('puts the picker in the statusline and leaves exactly one on the surface', async () => {
    const line = await renderSurface();

    const picker = await within(line).findByTestId('chat-model-picker');
    expect(pickers()).toHaveLength(1);
    // It takes over the read-out's slot, `data-stat` included, so the container-query ladder in chat.css
    // and the studio skin still address the model the way they always have.
    expect(picker).toHaveAttribute('data-stat', 'model');

    const trigger = within(picker).getByRole('button', { name: 'claude-opus' });
    expect(trigger).toHaveAttribute('title', 'Claude/claude-opus');
    // The brand mark the menu rows already carry, so the pill and the list speak one vocabulary.
    expect(picker.querySelector('[data-brand-mark]')).not.toBeNull();
  });

  it('opens the SAME grouped catalog the top bar used to open, and switches the conversation', async () => {
    const line = await renderSurface();
    const trigger = within(await within(line).findByTestId('chat-model-picker')).getByRole('button', { name: 'claude-opus' });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    // Grouped by provider with the source badge — the shared ModelOptionList, not a second rendering.
    await waitFor(() => expect(within(menu).getByText('Účet ChatGPT')).toBeInTheDocument());
    expect(within(menu).getByText('Claude')).toBeInTheDocument();
    // Every row carries its model icon.
    expect(menu.querySelectorAll('[data-brand-mark]').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /gpt-5\.6-sol/ }));
    await waitFor(() => expect(switched).toEqual([expect.objectContaining({ model: 'gpt-5.6-sol' })]));
  });

  it('keeps the top-bar control when the statusline plugin is not enabled', async () => {
    statusline = null;
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
    );

    // With the plugin off there is no statusline at all, so the bar must still carry the picker.
    const picker = await screen.findByTestId('chat-model-picker');
    expect(screen.queryByTestId('chat-statusline')).toBeNull();
    expect(within(picker).getByRole('button', { name: 'claude-opus' })).toBeInTheDocument();
    expect(pickers()).toHaveLength(1);
  });

  it('keeps the top-bar control when the statusline is enabled but not showing the model', async () => {
    // The plugin can be on with its model toggle off. Standing down on the plugin's mere presence would
    // leave the conversation with no way to change models.
    statusline = { showModel: false, showTokens: true };
    await renderSurface();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(within(screen.getByTestId('chat-statusline')).queryByTestId('chat-model-picker')).toBeNull();
    expect(within(picker).getByRole('button', { name: 'claude-opus' })).toBeInTheDocument();
  });

  it('hands the control back to the top bar when the reader collapses the statusline', async () => {
    const line = await renderSurface();
    await within(line).findByTestId('chat-model-picker');

    fireEvent.click(within(line).getByRole('button', { name: 'Hide stats' }));

    // The pill is gone with the row it lived in, so the bar takes its copy back — never zero controls.
    await waitFor(() => expect(within(screen.getByTestId('chat-statusline')).queryByTestId('chat-model-picker')).toBeNull());
    expect(pickers()).toHaveLength(1);
    expect(within(pickers()[0]!).getByRole('button', { name: 'claude-opus' })).toBeInTheDocument();
  });

  it('folds the picker out of the phone overflow menu while the statusline shows it', async () => {
    setViewport(true);
    const line = await renderSurface();
    await within(line).findByTestId('chat-model-picker');

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const menu = await screen.findByRole('dialog');
    // The ⋯ menu is where the bar's overflow goes, not a second home for a control the statusline holds.
    expect(within(menu).queryByTestId('chat-model-picker')).toBeNull();
    expect(pickers()).toHaveLength(1);
  });
});
