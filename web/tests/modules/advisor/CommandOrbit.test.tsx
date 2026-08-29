import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';

let commandCalls: string[] = [];

const server = setupServer(
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  // The catalog the daemon publishes for the web surface — the field's single source of commands.
  http.get('*/api/brain/commands', () => HttpResponse.json({
    commands: [
      { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
      { name: 'compact', description: 'Summarize the conversation', kind: 'action' },
      { name: 'plan', description: 'Plan mode', kind: 'mode' },
      { name: 'build', description: 'Build mode', kind: 'mode' },
      { name: 'workflow', description: 'Workflow mode', kind: 'mode' },
      { name: 'model', description: 'Switch the AI model', kind: 'picker' },
      { name: 'rename', description: 'Rename this conversation', kind: 'picker' },
      // CLI-only in the real catalog; here it proves the field renders only what it curates.
      { name: 'theme', description: 'Switch the terminal colour theme', kind: 'picker' },
    ],
  })),
  http.post('*/api/brain/command', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    commandCalls.push(body.name);
    return HttpResponse.json({ ok: true, message: '/compact' });
  }),
);

/** Drive useMobileViewport()'s `(max-width: 767px)` media query. */
function setViewport(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  } as MediaQueryList));
}

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); commandCalls = []; vi.restoreAllMocks(); });
afterAll(() => server.close());

function renderRail() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><TelemetryPanel variant="column" /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** Open the field by clicking the owl, as the user does. */
async function openField() {
  const mascot = await screen.findByTestId('telemetry-mascot');
  await act(async () => { fireEvent.click(mascot); });
  return { mascot, field: await screen.findByTestId('command-orbit') };
}

describe('mascot command field', () => {
  it('opens on the owl and closes on Escape, returning focus to the owl', async () => {
    setViewport(false);
    renderRail();
    expect(screen.queryByTestId('command-orbit')).toBeNull();
    const { mascot, field } = await openField();

    // Raised on the field, not on `window`: Escape is Radix's dismissable layer now, and it reads the
    // key off the document the event bubbles through — which is the path a real Escape takes.
    await act(async () => { fireEvent.keyDown(field, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByTestId('command-orbit')).toBeNull());
    expect(document.activeElement).toBe(mascot);
  });

  it('closes on the close button and on a backdrop click', async () => {
    setViewport(false);
    renderRail();
    await openField();
    await act(async () => { fireEvent.click(screen.getByTestId('command-orbit-close')); });
    await waitFor(() => expect(screen.queryByTestId('command-orbit')).toBeNull());

    await openField();
    const backdrop = screen.getByTestId('command-orbit-backdrop');
    expect(backdrop.style.backdropFilter).toBe('var(--command-orbit-backdrop-filter, none)');
    await act(async () => { fireEvent.click(backdrop); });
    await waitFor(() => expect(screen.queryByTestId('command-orbit')).toBeNull());
  });

  it('runs a pod through the shared slash path and closes the field', async () => {
    setViewport(false);
    const { field } = (await (async () => { renderRail(); return openField(); })());
    const pod = within(field).getByTestId('command-orbit-pod-compact');
    await act(async () => { fireEvent.click(pod); });
    await waitFor(() => expect(commandCalls).toEqual(['compact']));
    await waitFor(() => expect(screen.queryByTestId('command-orbit')).toBeNull());
  });

  it('renders only curated catalog commands — never one the daemon withheld', async () => {
    setViewport(false);
    renderRail();
    const { field } = await openField();
    expect(within(field).getByTestId('command-orbit-pod-plan')).toBeInTheDocument();
    expect(within(field).getByTestId('command-orbit-pod-rename')).toBeInTheDocument();
    expect(within(field).queryByTestId('command-orbit-pod-theme')).toBeNull();
  });

  it('marks the active work mode on its pod and moves the mark when the mode changes', async () => {
    setViewport(false);
    renderRail();
    const { field } = await openField();
    expect(within(field).getByTestId('command-orbit-pod-build')).toHaveAttribute('aria-pressed', 'true');
    expect(within(field).getByTestId('command-orbit-pod-plan')).toHaveAttribute('aria-pressed', 'false');

    // A mode pod keeps the field open so the moved mark is visible.
    await act(async () => { fireEvent.click(within(field).getByTestId('command-orbit-pod-plan')); });
    await waitFor(() => expect(screen.getByTestId('command-orbit-pod-plan')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('command-orbit-pod-build')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('command-orbit')).toBeInTheDocument();
  });

  it('lays out the thumb arc on a phone and never the desktop orbit', async () => {
    setViewport(true);
    renderRail();
    const { field } = await openField();
    expect(field).toHaveAttribute('data-layout', 'arc');
    expect(within(field).getByTestId('command-orbit-pod-plan')).toBeInTheDocument();
  });

  it('lays out the orbit on a desktop viewport', async () => {
    setViewport(false);
    renderRail();
    const { field } = await openField();
    expect(field).toHaveAttribute('data-layout', 'orbit');
  });
});
