import { existsSync, readFileSync } from 'node:fs';
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatRailSplit } from '../../../modules/advisor/ChatRailSplit';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';
import {
  CHAT_CONTENT_PANEL_ID,
  CHAT_RAIL_PANEL_ID,
  RAIL_COLLAPSED_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from '../../../lib/telemetryRail';

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); localStorage.clear(); });
afterAll(() => server.close());

/** `react-resizable-panels` sizes itself from real geometry: it measures the group with
 *  `getBoundingClientRect` and learns about changes through `ResizeObserver`. jsdom reports every box as
 *  0×0 and the suite-wide ResizeObserver stub never fires, so without this the group can only fall back to
 *  an even percentage split and NOTHING about a pixel contract or a drag is observable.
 *
 *  Giving the group a 1200px box is what makes the rest of this file a test of the dock rather than a test
 *  of jsdom's defaults. Only the horizontal axis matters here. */
const GROUP_WIDTH = 1200;

/** Source of a web/ file, for the wiring assertions below.
 *
 *  A note on why some of this file reads source rather than driving the UI: the actual drag arithmetic and
 *  the arrow-key stepping belong to `react-resizable-panels`, and both need real layout — the library
 *  measures the group and tracks pointers through a global mount registry. jsdom reports every box as 0×0
 *  and never runs a ResizeObserver, so a simulated drag there exercises nothing and would pass just as
 *  happily against a broken wiring. What IS ours, and what these assert, is that the pixel contract and the
 *  persistence reach the primitive and that nothing disables it. The drag arithmetic itself is covered by
 *  the upstream primitive; this feature still requires a real-browser acceptance check before deployment. */
function readSource(relativePath: string): string {
  return readFileSync(relativePath, 'utf8');
}

function measureLayout(): () => void {
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    // The separator keeps a hairline box; everything else reports the shell's width.
    const width = this.hasAttribute('data-separator') ? 1 : GROUP_WIDTH;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}) } as DOMRect;
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = realRect; };
}

function renderDock(docked = true) {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>
      <ChatRailSplit docked={docked} workspace={<div data-testid="workspace">conversation</div>} />
    </TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

function renderOverlay() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>
      <TelemetryPanel variant="drawer" open onClose={() => {}} />
    </TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

/** The rail's own divider. The shadcn `Separator` used for the rail's hairlines is decorative (Radix
 *  drops the role), so the resize handle is still the only `role="separator"` on the page — but it is
 *  addressed by the library's own attribute rather than by role, because that is the contract that
 *  survives another separator being added inside the panel. */
const handle = () => document.querySelector<HTMLElement>('[data-separator]')!;

describe('telemetry rail dock — layout ownership', () => {
  // THE geometry regression. Before the redesign the rail was mounted by ChatView as a sibling of the
  // transcript, which put it inside <main>'s scroller and inside the centred `--chat-max` frame: it began
  // below the top bar and stopped short of the right edge. The fix is structural, so the test is
  // structural — the rail has to be a PANEL of the shell's split, not a descendant of the content.
  it('docks the rail as a sibling panel of the conversation, not inside it', async () => {
    renderDock();
    const rail = await screen.findByTestId('telemetry-column');
    const workspace = screen.getByTestId('workspace');
    expect(rail).toHaveClass('w-full');

    const contentPanel = document.querySelector<HTMLElement>(`[data-panel][id="${CHAT_CONTENT_PANEL_ID}"]`);
    const railPanel = document.querySelector<HTMLElement>(`[data-panel][id="${CHAT_RAIL_PANEL_ID}"]`);
    expect(contentPanel).not.toBeNull();
    expect(railPanel).not.toBeNull();

    // Each lives in its own panel …
    expect(contentPanel!.contains(workspace)).toBe(true);
    expect(railPanel!.contains(rail)).toBe(true);
    // … and neither panel contains the other: they are siblings of one group, which is what makes the
    // rail's box reach the edges of that group rather than the edges of the conversation.
    expect(contentPanel!.contains(railPanel!)).toBe(false);
    expect(railPanel!.contains(contentPanel!)).toBe(false);
    // The old geometry, stated as the thing that must not come back.
    expect(workspace.contains(rail)).toBe(false);
  });

  it('puts the resize handle between the two panels inside one group', async () => {
    renderDock();
    await screen.findByTestId('telemetry-column');
    const group = document.querySelector<HTMLElement>('[data-group]')!;
    const shape = ([...group.children] as HTMLElement[]).map((child) =>
      child.hasAttribute('data-separator') ? 'separator' : child.id);
    expect(shape).toEqual([CHAT_CONTENT_PANEL_ID, 'separator', CHAT_RAIL_PANEL_ID]);
  });

  it('keeps the chat subtree mounted when the viewport adds or removes the dock', async () => {
    const { wrapper: Wrapper } = createWrapper();
    function Harness() {
      const [docked, setDocked] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setDocked((value) => !value)}>toggle dock</button>
          <ChatRailSplit
            docked={docked}
            workspace={<input aria-label="draft" defaultValue="preserved" />}
          />
        </>
      );
    }
    render(
      <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider><Harness /></TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
    );
    const draft = screen.getByRole('textbox', { name: 'draft' });
    fireEvent.change(draft, { target: { value: 'still here' } });

    fireEvent.click(screen.getByRole('button', { name: 'toggle dock' }));
    await screen.findByTestId('telemetry-column');
    expect(screen.getByRole('textbox', { name: 'draft' })).toBe(draft);
    expect(draft).toHaveValue('still here');

    fireEvent.click(screen.getByRole('button', { name: 'toggle dock' }));
    await waitFor(() => expect(screen.queryByTestId('telemetry-column')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'draft' })).toBe(draft);
  });
});

describe('telemetry rail dock — resizing', () => {
  let restore: () => void = () => {};
  beforeEach(() => { restore = measureLayout(); });
  afterEach(() => restore());

  it('exposes a real window splitter to assistive tech and the keyboard', async () => {
    renderDock();
    await screen.findByTestId('telemetry-column');
    const el = handle();
    expect(el).toHaveAttribute('role', 'separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('tabindex', '0');
    // The splitter reports which panel it sizes, and a live value inside a real range.
    expect(el).toHaveAttribute('aria-controls');
    expect(el).toHaveAttribute('aria-valuemin');
    expect(el).toHaveAttribute('aria-valuemax');
    expect(el).toHaveAttribute('aria-valuenow');
  });

  it('leaves the handle enabled, keeping drag and the native double-click reset available', async () => {
    renderDock();
    await screen.findByTestId('telemetry-column');
    const el = handle();
    // `react-resizable-panels` resets a panel to its `defaultSize` on double-click unless the separator
    // opts out, and it refuses every pointer and key when disabled. Both are the library's behaviour; what
    // this file owns is not switching either of them off.
    expect(el).not.toHaveAttribute('data-disabled');
    expect(el.getAttribute('data-separator')).toBe('inactive');
    const source = readSource('modules/advisor/ChatRailSplit.tsx');
    expect(source).not.toContain('disableDoubleClick');
    expect(source).not.toMatch(/<ResizableHandle[^>]*\bdisabled\b/);
  });

  it('configures the panel from the pixel contract, so the rail cannot drift back to 240/320', async () => {
    // The constants reach the panel unconverted — v4 reads a numeric size as pixels — so the wiring is
    // what needs pinning here; telemetryRail.test.tsx pins the values themselves.
    const source = readSource('modules/advisor/ChatRailSplit.tsx');
    expect(source).toContain('minSize={RAIL_MIN_WIDTH}');
    expect(source).toContain('maxSize={RAIL_MAX_WIDTH}');
    expect(source).toContain('defaultSize={RAIL_COLLAPSED_WIDTH}');
    expect(source).toContain('collapsedSize={RAIL_COLLAPSED_WIDTH}');
    expect(source).toContain('collapsible');
    expect([RAIL_MIN_WIDTH, RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_COLLAPSED_WIDTH]).toEqual([280, 340, 560, 52]);
  });

  it('starts every desktop visit compact instead of restoring a wide layout', async () => {
    renderDock();
    await screen.findByTestId('telemetry-column');
    const source = readSource('modules/advisor/ChatRailSplit.tsx');
    expect(source).not.toContain('useDefaultLayout');
    expect(source).not.toContain('defaultLayout=');
    expect(source).not.toContain('onLayoutChanged=');
    expect(source).toContain('defaultSize={RAIL_COLLAPSED_WIDTH}');
    // Expansion width remains an in-memory visit detail, not another persisted answer to the initial state.
    expect(source).toContain('lastExpandedWidth');
    expect(existsSync('lib/useTelemetryRailWidth.ts')).toBe(false);
    expect(readSource('modules/advisor/telemetryRailState.tsx')).not.toContain('usePersistentState');
  });
});

describe('telemetry rail dock — collapse', () => {
  it('starts as the compact instrument strip and expands on demand', async () => {
    renderDock();
    const stub = await screen.findByTestId('telemetry-stub');
    expect(stub).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-head')).toBeNull();
    expect(screen.getByTestId('telemetry-column')).toHaveAttribute('data-collapsed', 'true');

    await act(async () => { fireEvent.click(screen.getByTestId('telemetry-collapse')); });
    await waitFor(() => expect(screen.getByTestId('telemetry-head')).toBeInTheDocument());
    expect(screen.queryByTestId('telemetry-stub')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId('telemetry-collapse')); });
    await waitFor(() => expect(screen.getByTestId('telemetry-stub')).toBeInTheDocument());
  });

  it('reports the compact state to assistive tech', async () => {
    renderDock();
    await screen.findByTestId('telemetry-stub');
    expect(screen.getByTestId('telemetry-collapse')).toHaveAttribute('aria-expanded', 'false');
    await act(async () => { fireEvent.click(screen.getByTestId('telemetry-collapse')); });
    await waitFor(() => expect(screen.getByTestId('telemetry-collapse')).toHaveAttribute('aria-expanded', 'true'));
  });

  it('restores the visit\'s expanded width instead of falling back to the minimum', () => {
    const source = readSource('modules/advisor/ChatRailSplit.tsx');
    expect(source).toContain('lastExpandedWidth');
    expect(source).toContain('panel.resize(lastExpandedWidth.current)');
  });
});

describe('telemetry rail — one body, two hosts', () => {
  // The desktop dock and the phone overlay must never drift into two different panels; the guarantee is
  // that both render the same component, so the same sections appear in both.
  it('renders the same three-zone rail in the phone overlay as in the dock', async () => {
    renderOverlay();
    expect(await screen.findByTestId('telemetry-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-head')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-scroll')).toBeInTheDocument();
  });

  it('gives the phone overlay no resize handle to fight the dismiss gesture', async () => {
    renderOverlay();
    await screen.findByTestId('telemetry-drawer');
    expect(document.querySelector('[data-separator]')).toBeNull();
  });

  it('mounts the overlay on the app dialog path rather than squeezing the desktop dock in', async () => {
    renderOverlay();
    const drawer = await screen.findByTestId('telemetry-drawer');
    expect(drawer).toHaveAttribute('role', 'dialog');
    // Full-bleed on a phone, capped on a tablet — never an 18rem sliver of a column.
    expect(drawer.className).toContain('w-full');
  });
});

describe('telemetry rail — primitives that carry behaviour', () => {
  it('keeps one readable type scale instead of shrinking the whole rail with its width', () => {
    const split = readSource('modules/advisor/ChatRailSplit.tsx');
    const panel = readSource('modules/advisor/TelemetryPanel.tsx');
    expect(split).not.toContain('railTypeVars');
    expect(split).not.toContain("'--text-tiny'");
    expect(panel).not.toContain('text-tiny');
    expect(panel).not.toContain('text-caption');
    expect(panel).toContain('text-xs');
    expect(panel).toContain('text-sm');
  });

  it('scrolls the expanded middle band on a ScrollArea, with head and foot pinned outside it', async () => {
    renderDock();
    await screen.findByTestId('telemetry-stub');
    await act(async () => { fireEvent.click(screen.getByTestId('telemetry-collapse')); });
    const scroll = await screen.findByTestId('telemetry-scroll');
    expect(scroll).toHaveAttribute('data-slot', 'scroll-area');
    const viewport = scroll.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport).toHaveClass('[&>div]:!block', '[&>div]:!w-full', '[&>div]:!min-w-0');
    // The head is a sibling of the scroller, not inside it — that is what pins it to the viewport edge.
    expect(scroll.contains(screen.getByTestId('telemetry-head'))).toBe(false);
  });

  it('separates the three zones with real Separator hairlines', async () => {
    renderDock();
    await screen.findByTestId('telemetry-column');
    const rail = screen.getByTestId('telemetry-column');
    expect(rail.querySelectorAll('[data-slot="separator"]').length).toBeGreaterThanOrEqual(1);
  });
});
