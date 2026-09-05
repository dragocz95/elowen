import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport, watchMounts } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { PageHeaderProvider, PageTopBarHost } from '../../../lib/pageHeader';

// The conversation bar carries different controls on a phone (model picker and work-mode pill fold into
// the ⋯ popover) than on desktop (everything inline). Which set is chosen must wait for the viewport
// measurement. The reasoning button is the exception — it stays inline at every width.
// Placement is not width-dependent: wherever the shell publishes a top-bar host, the whole bar rides in
// it — a phone included, which is what keeps the controls inside the one sticky bar a phone has.

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ tasks: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('conversation bar controls', () => {
  it('rides in the shell top bar on a phone, not in a row of its own below it', async () => {
    // The phone used to be exempted from the portal, so the shell's bar sat on top holding nothing but
    // a hamburger while the conversation's controls lived in a second, local row under it. Where a host
    // is published the controls must land inside it at every width.
    setViewport(true);
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper><ToastProvider><PageHeaderProvider>
        <BrainChatProvider>
          <PageTopBarHost />
          <BrainChatSurface variant="full" />
        </BrainChatProvider>
      </PageHeaderProvider></ToastProvider></Wrapper>,
    );

    const host = await screen.findByTestId('page-top-bar-host');
    await waitFor(() => expect(host).toContainElement(screen.getByRole('button', { name: 'More options' })));
  });

  it('never paints the desktop-only controls on a phone, not even for one commit', async () => {
    // The boolean-returning useMobile reports `false` before the first measurement, so the phone briefly
    // got the inline desktop bar and then swapped it for the ⋯ popover — a visible rearrangement on load.
    // The model picker is the marker now: on a phone it exists only INSIDE the popover, so any mount
    // before that popover is opened is the flash coming back.
    setViewport(true);
    const sawDesktopControls = watchMounts('[data-testid="chat-model-picker"]');
    renderSurface();

    await screen.findByRole('button', { name: 'More options' });
    expect(sawDesktopControls()).toBe(false);
  });

  it('folds reasoning, telemetry and new chat into the ⋯ popover on a phone', async () => {
    // The phone bar is the conversation name and ⋯: three icon buttons beside the name truncated it to
    // a letter. The actions are still one menu away, as icon rows, and nowhere else on the bar.
    setViewport(true);
    renderSurface();
    await screen.findByRole('button', { name: 'More options' });
    expect(screen.queryByTestId('chat-thoughts-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    const popover = await waitFor(() => {
      const el = document.querySelector('[data-chat-popover]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(popover).toContainElement(screen.getByTestId('chat-thoughts-toggle'));
    expect(popover).toContainElement(screen.getByRole('button', { name: 'New chat' }));
  });

  it('positions the top overflow with the shared collision-aware popover and opens telemetry', async () => {
    setViewport(true);
    const openTelemetry = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><PageHeaderProvider><BrainChatProvider>
      <PageTopBarHost />
      <BrainChatSurface variant="full" onOpenTelemetry={openTelemetry} />
    </BrainChatProvider></PageHeaderProvider></ToastProvider></Wrapper>);
    const trigger = await screen.findByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    const popover = document.querySelector('[data-chat-popover]');
    expect(popover).toHaveAttribute('data-slot', 'popover-content');
    fireEvent.click(screen.getByRole('button', { name: 'Show telemetry' }));
    expect(openTelemetry).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('opens the same Tasks modal as `/tasks` from the phone overflow', async () => {
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    expect(await screen.findByRole('dialog', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Filter tasks' })).toBeInTheDocument();
  });

  it('keeps the wide controls inline and reserves a CSS-gated overflow fallback off a phone', async () => {
    setViewport(false);
    renderSurface();

    expect(await screen.findByTestId('chat-thoughts-toggle')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-model-picker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' }).closest('.chat-page-toolbar__overflow')).not.toBeNull();
  });

  it('closes the ⋯ popover on Escape', async () => {
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).toBeNull());
  });

  // The footer metrics (model / context / tokens / cost) must stay ONE line on a phone: a second row
  // pushes the composer down and eats the little vertical space a phone has. jsdom does no layout, so
  // what is guarded here is the class contract that produces the single line — the row itself must not
  // wrap, each metric must not wrap internally (a no-wrap flex row still lets an item's own text break),
  // and the model name — the long, expendable part — absorbs the squeeze by truncating.
  it('keeps the model/context/tokens/cost footer on one line for a phone', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: false, sessionId: 'brain-1', model: 'claude-opus-5', cards: [], queued: [],
      statusline: { showModel: true, showContext: true, showTokens: true, showCost: true },
      usage: { tokens: 258_000, contextWindow: 1_000_000, percent: 26, totalTokens: 126_300_000, cost: 59.08 },
    })));
    setViewport(true);
    renderSurface();

    const line = await screen.findByTestId('chat-statusline');
    expect(line.className).not.toContain('flex-wrap');

    const spans = [...line.querySelectorAll('span')];
    const model = spans.find((s) => s.textContent === 'claude-opus-5');
    expect(model?.className).toContain('truncate');
    expect(model?.getAttribute('title')).toBe('claude-opus-5'); // truncation must not hide which model ran

    const metrics = spans.filter((s) => /26%|Σ|59\.08/.test(s.textContent ?? ''));
    expect(metrics).toHaveLength(3);
    for (const metric of metrics) expect(metric.className).toContain('whitespace-nowrap');
  });
});
