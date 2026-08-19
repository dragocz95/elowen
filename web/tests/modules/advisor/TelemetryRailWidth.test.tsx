import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';
import { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH } from '../../../lib/useTelemetryRailWidth';

const KEY = 'elowen:telemetry-rail-width';

const server = setupServer(
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); localStorage.clear(); });
afterAll(() => server.close());

function renderRail(variant: 'column' | 'drawer' = 'column') {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider>
      <TelemetryPanel variant={variant} open onClose={() => {}} />
    </BrainChatProvider></ToastProvider></Wrapper>,
  );
}

/** The rail's own divider — nothing else in the panel is a separator. */
const handle = () => screen.getByRole('separator');

async function drag(from: number, to: number) {
  const el = handle();
  await act(async () => {
    fireEvent.pointerDown(el, { clientX: from, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: to, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: to, clientY: 0, pointerId: 1 });
  });
}

describe('telemetry rail width', () => {
  it('opens at the default width and widens when the handle is dragged left', async () => {
    renderRail();
    const rail = await screen.findByTestId('telemetry-column');
    expect(rail).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH}px` });

    await drag(1000, 940); // 60px to the left → 60px wider
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH + 60}px` }));
  });

  it('narrows when dragged right and never leaves the legible range', async () => {
    renderRail();
    const rail = await screen.findByTestId('telemetry-column');
    await drag(1000, 1600);
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_MIN_WIDTH}px` }));
    await drag(1000, 200);
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_MAX_WIDTH}px` }));
  });

  it('persists the dragged width and restores it on the next mount', async () => {
    const first = renderRail();
    await screen.findByTestId('telemetry-column');
    await drag(1000, 900);
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe(String(RAIL_DEFAULT_WIDTH + 100)));
    first.unmount();

    renderRail();
    const restored = await screen.findByTestId('telemetry-column');
    expect(restored).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH + 100}px` });
  });

  it('resets to the default width on a double click', async () => {
    localStorage.setItem(KEY, String(RAIL_MAX_WIDTH));
    renderRail();
    const rail = await screen.findByTestId('telemetry-column');
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_MAX_WIDTH}px` }));
    await act(async () => { fireEvent.doubleClick(handle()); });
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH}px` }));
  });

  it('resizes from the keyboard and reports the range to assistive tech', async () => {
    renderRail();
    const rail = await screen.findByTestId('telemetry-column');
    const el = handle();
    expect(el).toHaveAttribute('role', 'separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuemin', String(RAIL_MIN_WIDTH));
    expect(el).toHaveAttribute('aria-valuemax', String(RAIL_MAX_WIDTH));
    expect(el).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH));

    await act(async () => { fireEvent.keyDown(el, { key: 'ArrowLeft' }); });
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH + 16}px` }));
    await act(async () => { fireEvent.keyDown(el, { key: 'ArrowRight' }); });
    await waitFor(() => expect(rail).toHaveStyle({ width: `${RAIL_DEFAULT_WIDTH}px` }));
    await waitFor(() => expect(handle()).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH)));
  });

  it('scales the rail-local text tokens with the width, leaving the global tokens alone', async () => {
    renderRail();
    const rail = await screen.findByTestId('telemetry-column');
    const tiny = () => rail.style.getPropertyValue('--text-tiny');
    const atDefault = tiny();
    expect(atDefault).not.toBe('');
    expect(document.documentElement.style.getPropertyValue('--text-tiny')).toBe('');

    await drag(1000, 800);
    await waitFor(() => expect(Number.parseFloat(tiny())).toBeGreaterThan(Number.parseFloat(atDefault)));
  });

  it('gives the mobile drawer no resize handle', async () => {
    renderRail('drawer');
    await screen.findByTestId('telemetry-drawer');
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

// The rail is dragged between 240px and 560px on desktop and pinned to a phone's width in the drawer, so
// its content has no width to assume. Whenever a row could not shrink to the current one — a long branch
// name, a wide heading, a process command beside a fixed-size icon — the panel answered with a horizontal
// scrollbar rather than truncating, because `overflow-y-auto` alone promotes the OTHER axis from `visible`
// to `auto`. Adding a sub-agent was the usual trigger: the section it brought in made the box scroll
// vertically, and the vertical bar took the last pixels the rows had left.

const classesOf = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean);

describe('telemetry rail overflow contract', () => {
  /** The column wraps the shared body in a scroll box; in the drawer the panel itself is that box. */
  async function scrollBox(variant: 'column' | 'drawer'): Promise<HTMLElement> {
    renderRail(variant);
    return screen.findByTestId(variant === 'column' ? 'telemetry-scroll' : 'telemetry-drawer');
  }

  it.each(['column', 'drawer'] as const)('scrolls %s content vertically and clips the other axis', async (variant) => {
    const classes = classesOf(await scrollBox(variant));
    expect(classes).toContain('overflow-y-auto');
    expect(classes).toContain('overflow-x-hidden');
    // A blanket `overflow-hidden` would take the horizontal scrollbar away by making the rail unscrollable
    // altogether — the long transcript-side rail has to keep reaching its bottom sections.
    expect(classes).not.toContain('overflow-hidden');
    expect(classes).not.toContain('overflow-auto');
  });

  it.each(['column', 'drawer'] as const)('hides the %s scrollbar visually without disabling it', async (variant) => {
    // The chrome is hidden by the design-system class (see globals.test.ts for the rules it carries), not
    // by an overflow that would take the scrolling away with it.
    expect(classesOf(await scrollBox(variant))).toContain('telemetry-rail-scroll');
  });
});
