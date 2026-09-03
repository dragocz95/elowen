import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport, watchMounts } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { ChatRailSplit } from '../../../modules/advisor/ChatRailSplit';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';
import { useMobileViewport } from '../../../lib/useMobile';

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  /** Push one SSE frame at the provider, so a test can assert what a MID-TURN event does to the rail. */
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

/** The extended /brain/status payload: usage + project + LSP + MCP, all from the one poll. */
const STATUS = {
  running: true, sessionId: 'brain-1', model: 'gpt-5.6-sol', provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', usageProvider: 'openai-codex', statusline: { showModel: true }, cards: [], queued: [],
  usage: { tokens: 42_000, contextWindow: 200_000, percent: 21, totalTokens: 51_000, cost: 1.2345 },
  project: { cwd: '/var/www/elowen', branch: 'dev' },
  lspEnabled: true,
  mcp: [{ name: 'chrome-devtools', status: 'connected' }, { name: 'sleepy', status: 'disconnected' }],
};

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json(STATUS)),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({
    'openai-codex': {
      provider: 'openai-codex', planType: 'pro', fetchedAt: 0, stale: false,
      windows: [{ usedPercent: 64, windowMinutes: 300, resetsAt: null }],
    },
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([
    { id: 'brain-1', title: 'First chat', model: 'm', updated_at: '2026-07-08', running: false, active: true },
  ])),
  http.get('*/api/brain/commands', () => HttpResponse.json({
    commands: Array.from({ length: 12 }, (_, index) => ({ name: `command-${index}`, description: '' })),
  })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The chat page as the SHELL now composes it.
 *
 *  The desktop telemetry dock is no longer a child of `ChatView`: it is a resizable panel BESIDE it, owned
 *  by components/shell/Shell.tsx, which is what lets it reach the viewport's top, right and bottom edges.
 *  A harness that rendered `ChatView` alone would therefore be testing a page that no longer exists, so
 *  this mirrors the shell's own decision — the stable split group always owns /chat, while only its trailing
 *  dock appears on a measured desktop; on a phone the overlay `ChatView` raises itself. */
function ChatPage() {
  const mobile = useMobileViewport();
  return <ChatRailSplit workspace={<ChatView />} docked={mobile === false} />;
}

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>
      {node}
    </TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

async function expandDesktopTelemetry(): Promise<void> {
  await screen.findByTestId('telemetry-stub');
  fireEvent.click(screen.getByTestId('telemetry-collapse'));
  await screen.findByTestId('telemetry-head');
}

describe('chat telemetry panel', () => {
  it('renders the desktop column with context, limits, project, MCP and LSP', async () => {
    setViewport(false);
    renderChat(<ChatPage />);
    expect(await screen.findByTestId('telemetry-column')).toBeInTheDocument();
    const statusModel = (await screen.findByTestId('chat-statusline')).querySelector<HTMLElement>('[data-stat="model"]')!;
    expect(statusModel).toHaveTextContent('gpt-5.6-sol');
    expect(statusModel).toHaveAttribute('title', 'Účet ChatGPT/gpt-5.6-sol');
    expect(statusModel).not.toHaveTextContent('Účet ChatGPT/');
    expect(screen.getByText('gpt-5.6-sol', { selector: '.chat-hero__metrics span.font-mono' })).toBeInTheDocument();

    // The desktop default is the compact instrument strip: every available section remains visible as an
    // icon/micro-meter, and the mascot keeps the command catalog reachable without claiming reading width.
    expect(await screen.findByTestId('telemetry-compact-context')).toHaveTextContent('21%');
    expect(screen.getByRole('button', { name: 'Open the command field' })).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-command-count')).toBeNull();
    expect(await screen.findByTestId('telemetry-compact-limit-0')).toHaveTextContent('64%');
    expect(screen.getByTestId('telemetry-compact-mcp')).toHaveTextContent('1/2');
    expect(screen.getByTestId('telemetry-compact-lsp')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-compact-project')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-compact-scroll')).toHaveAttribute('data-slot', 'scroll-area');

    await expandDesktopTelemetry();
    // Context fill comes from the status poll's usage numbers.
    const context = await screen.findByTestId('telemetry-context');
    expect(context.textContent).toContain('21%');
    expect(context.textContent).toContain('42k / 200k');
    expect(context.textContent).toContain('$1.23');
    const contextBar = context.querySelector<HTMLElement>('[role="progressbar"]')!;
    const contextFill = contextBar.querySelector<HTMLElement>('[data-slot="progress-indicator"]')!;
    expect(contextBar).toHaveAttribute('aria-valuenow', '21');
    expect(contextFill).toHaveStyle({ width: '21%' });

    // Project: the daemon-reported directory and its git branch — neither existed on the wire before.
    const project = screen.getByTestId('telemetry-project');
    expect(project.textContent).toContain('/var/www/elowen');
    expect(project.textContent).toContain('dev');

    // Only CONNECTED MCP servers are listed, with a connected/total count.
    const mcp = screen.getByTestId('telemetry-mcp');
    expect(mcp.textContent).toContain('chrome-devtools');
    expect(mcp.textContent).not.toContain('sleepy');
    expect(mcp.textContent).toContain('1/2');

    expect(screen.getByTestId('telemetry-lsp').textContent).toMatch(/Active|Aktivní/);

    // Subscription limits ride their own slower endpoint, not the hot status poll.
    await waitFor(() => expect(screen.getByTestId('telemetry-limits').textContent).toContain('64%'));
  });

  // Regression: the daemon emits a `step` frame carrying a fresh usage snapshot on every model
  // round-trip, precisely so a client does not have to wait for `idle`. The web provider had no handler
  // for it, so the frame was dropped and the rail (and the composer statusline, which reads the same
  // state) showed the PREVIOUS turn's numbers for the whole turn. The CLI never had this problem.
  it('refreshes context, tokens and cost mid-turn from a step frame, not only once the turn settles', async () => {
    setViewport(false);
    renderChat(<ChatPage />);
    await expandDesktopTelemetry();
    const context = await screen.findByTestId('telemetry-context');
    expect(context.textContent).toContain('21%'); // the opening numbers, from /brain/status

    FakeES.instances[0]!.emit('step', {
      type: 'step', step: 2, maxSteps: 25,
      usage: { tokens: 120_000, contextWindow: 200_000, percent: 60, totalTokens: 130_000, cost: 3.5 },
    });

    await waitFor(() => expect(screen.getByTestId('telemetry-context').textContent).toContain('60%'));
    const live = screen.getByTestId('telemetry-context').textContent ?? '';
    expect(live).toContain('120k / 200k');
    expect(live).toContain('$3.50');
    expect(live).not.toContain('21%'); // genuinely replaced, not rendered alongside the stale figure
  });

  // Usage has several writers: the ordered live stream, and REST snapshots that can land LATE. A slow
  // /brain/status response sampled BEFORE a step frame must not commit afterwards and roll the rail back
  // to a stale figure that nothing corrects until the next round-trip.
  it('does not let a slow status snapshot overwrite a newer step frame', async () => {
    let releaseStatus!: () => void;
    const held = new Promise<void>((r) => { releaseStatus = r; });
    let calls = 0;
    server.use(http.get('*/api/brain/status', async () => {
      calls += 1;
      if (calls === 1) return HttpResponse.json(STATUS); // connect hydration must complete, or no stream exists
      await held; // sampled now, delivered only after the step frame below
      return HttpResponse.json(STATUS); // the OLD 21% figure
    }));

    setViewport(false);
    renderChat(<ChatPage />);
    await expandDesktopTelemetry();
    await screen.findByTestId('telemetry-context');

    // A session-event triggers the snapshot refetch that will land late.
    FakeES.instances[0]!.emit('session-event', { type: 'session-event', kind: 'cwd', detail: '/tmp' });

    FakeES.instances[0]!.emit('step', {
      type: 'step', step: 2, maxSteps: 25,
      usage: { tokens: 120_000, contextWindow: 200_000, percent: 60, totalTokens: 130_000, cost: 3.5 },
    });
    await waitFor(() => expect(screen.getByTestId('telemetry-context').textContent).toContain('60%'));

    releaseStatus();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // The late snapshot is discarded: the stream moved on while it was in flight.
    expect(screen.getByTestId('telemetry-context').textContent).toContain('60%');
  });

  it('ignores a step frame that carries no usage, leaving the last known numbers standing', async () => {
    setViewport(false);
    renderChat(<ChatPage />);
    await expandDesktopTelemetry();
    expect((await screen.findByTestId('telemetry-context')).textContent).toContain('21%');
    // `usage` is optional on the event — a step without it must not blank the rail.
    FakeES.instances[0]!.emit('step', { type: 'step', step: 3, maxSteps: 25 });
    // Settle inside act: the rail's own background queries land during this wait, and React would
    // otherwise warn about a state update escaping the test's control.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('telemetry-context').textContent).toContain('21%');
  });

  it('drops sections the daemon does not report instead of showing blanks', async () => {
    setViewport(false);
    server.use(
      http.get('*/api/brain/status', () => HttpResponse.json({
        ...STATUS, project: { cwd: null, branch: null }, mcp: null, lspEnabled: undefined,
      })),
      http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
    );
    renderChat(<ChatPage />);
    expect(await screen.findByTestId('telemetry-compact-context')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-compact-project')).toBeNull();
    expect(screen.queryByTestId('telemetry-compact-mcp')).toBeNull();
    expect(screen.queryByTestId('telemetry-compact-lsp')).toBeNull();
    expect(screen.queryByTestId('telemetry-compact-limit-0')).toBeNull();
    await expandDesktopTelemetry();
    expect(await screen.findByTestId('telemetry-context')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-project')).toBeNull();
    expect(screen.queryByTestId('telemetry-mcp')).toBeNull();
    expect(screen.queryByTestId('telemetry-lsp')).toBeNull();
    expect(screen.queryByTestId('telemetry-limits')).toBeNull();
  });

  it('shows the mascot atop the rail, and keeps it when every section is dropped', async () => {
    setViewport(false);
    server.use(
      http.get('*/api/brain/status', () => HttpResponse.json({
        ...STATUS, project: { cwd: null, branch: null }, mcp: null, lspEnabled: undefined, usage: null,
      })),
      http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
    );
    renderChat(<ChatPage />);
    // Even with nothing to report the compact rail is inhabited — the owl and expand control remain.
    expect(await screen.findByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-compact-context')).toBeNull();
    expect(screen.queryByTestId('telemetry-context')).toBeNull();
  });

  it('mounts NO side column on mobile — the rail opens as a drawer from the header instead', async () => {
    setViewport(true);
    renderChat(<ChatPage />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // The narrow viewport must never carry a second column: not hidden by CSS, simply not mounted.
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
    expect(screen.queryByTestId('telemetry-drawer')).toBeNull();

    // On a phone the opener is a row of the ⋯ menu.
    fireEvent.click(screen.getByRole('button', { name: /More options|Další možnosti/i }));
    fireEvent.click(screen.getByRole('button', { name: /Show telemetry|Zobrazit telemetrii/i }));
    const drawer = await screen.findByTestId('telemetry-drawer');
    expect(drawer).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-project').textContent).toContain('/var/www/elowen');
    // The phone rail is the same living panel, not a stripped-down one: the mascot is in the drawer too.
    expect(screen.getByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
  });

  // The drawer used to answer Escape from a React handler on its own layer, which only fires once focus
  // is already inside it — and nothing put it there, so the key did nothing. On the dialog primitive the
  // surface takes focus on open and Escape reaches the layer from the document, which is also what makes
  // handing focus back on close a promise worth asserting.
  it('takes focus on open, closes on Escape and returns focus to the control that opened it', async () => {
    setViewport(true);
    renderChat(<ChatPage />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // The row that opens the drawer lives in the ⋯ menu and leaves with it, so the control focus comes
    // back to is the ⋯ trigger — the one that is still there when the drawer closes.
    const more = screen.getByRole('button', { name: /More options|Další možnosti/i });
    fireEvent.click(more);
    const opener = screen.getByRole('button', { name: /Show telemetry|Zobrazit telemetrii/i });
    opener.focus();
    fireEvent.click(opener);

    const drawer = await screen.findByTestId('telemetry-drawer');
    expect(drawer).toHaveFocus();

    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('telemetry-drawer')).toBeNull());
    // Radix's focus scope releases a tick after the surface is gone.
    await waitFor(() => expect(more).toHaveFocus());
  });

  it('never mounts the desktop column on mobile — not even for the pre-effect first commit', async () => {
    setViewport(true);
    const columnWasMounted = watchMounts('[data-testid="telemetry-column"]');
    renderChat(<ChatPage />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // The viewport is unknown on the first commit, so neither variant may be mounted yet: a phone must
    // never build the second column, run its queries and tear it down again a tick later.
    expect(columnWasMounted()).toBe(false);
  });
});
