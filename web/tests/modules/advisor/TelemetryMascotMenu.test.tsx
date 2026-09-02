import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';

let commandCalls: string[] = [];

const CATALOG = [
  { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
  { name: 'compact', description: 'Summarize the conversation', kind: 'action' },
  { name: 'plan', description: 'Plan mode', kind: 'mode' },
  { name: 'build', description: 'Build mode', kind: 'mode' },
  { name: 'workflow', description: 'Workflow mode', kind: 'mode' },
  { name: 'model', description: 'Switch the AI model', kind: 'picker' },
  { name: 'rename', description: 'Rename this conversation', kind: 'picker' },
  // CLI-only in the real catalog; here it proves the menu renders only what it curates.
  { name: 'theme', description: 'Switch the terminal colour theme', kind: 'picker' },
];

const server = setupServer(
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  // The catalog the daemon publishes for the web surface — the menu's single source of commands.
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: CATALOG })),
  http.post('*/api/brain/command', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    commandCalls.push(body.name);
    return HttpResponse.json({ ok: true, message: '/compact' });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); commandCalls = []; });
afterAll(() => server.close());

function renderRail() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><TelemetryPanel variant="column" /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** Open the menu by pressing the owl, as the user's click does. Radix DropdownMenu opens on pointerdown,
 *  never on hover — the same harness pattern the LanguageSwitcher tests use. */
async function openMenu() {
  const mascot = await screen.findByTestId('telemetry-mascot');
  await act(async () => { fireEvent.pointerDown(mascot, { button: 0, ctrlKey: false }); });
  return { mascot, menu: await screen.findByRole('menu') };
}

describe('telemetry mascot command menu', () => {
  it('opens a menu on click — and never on hover', async () => {
    renderRail();
    const mascot = await screen.findByTestId('telemetry-mascot');
    expect(screen.queryByRole('menu')).toBeNull();

    // A pointer drifting across the owl must not raise the menu: only a press opens it.
    await act(async () => { fireEvent.pointerEnter(mascot, { pointerType: 'mouse' }); });
    fireEvent.mouseEnter(mascot);
    await act(async () => { fireEvent.pointerOver(mascot, { pointerType: 'mouse' }); });
    await act(async () => { fireEvent.mouseOver(mascot); });
    expect(screen.queryByRole('menu')).toBeNull();

    const { menu } = await openMenu();
    expect(menu).toHaveAttribute('role', 'menu');
  });

  it('names the section and lists only curated, cataloged commands', async () => {
    renderRail();
    const { menu } = await openMenu();
    expect(within(menu).getByText('Command field')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^Compact/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^Rename/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^New conversation/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^Model/ })).toBeInTheDocument();
    // The catalog carries one-line help; the menu shows it as secondary text.
    expect(within(menu).getByText('Summarize the conversation')).toBeInTheDocument();
    // …and a command the daemon withheld for this surface gets no row.
    expect(within(menu).queryByRole('menuitem', { name: /Theme/ })).not.toBeInTheDocument();
  });

  it('reflects the work mode on the radio group and moves it when a mode is chosen', async () => {
    renderRail();
    const { menu } = await openMenu();
    const group = within(menu).getByRole('group');
    expect(within(group).getByRole('menuitemradio', { name: 'Build' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('menuitemradio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'false');
    expect(within(group).getByRole('menuitemradio', { name: 'Workflow' })).toHaveAttribute('aria-checked', 'false');

    await act(async () => { fireEvent.click(within(group).getByRole('menuitemradio', { name: 'Plan' })); });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    const reopened = await openMenu();
    expect(within(within(reopened.menu).getByRole('group')).getByRole('menuitemradio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
    expect(within(within(reopened.menu).getByRole('group')).getByRole('menuitemradio', { name: 'Build' })).toHaveAttribute('aria-checked', 'false');
  });

  it('runs an action through the shared slash path', async () => {
    renderRail();
    const { menu } = await openMenu();
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: /^Compact/ })); });
    await waitFor(() => expect(commandCalls).toEqual(['compact']));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('has no row for a curated command the daemon did not catalog', async () => {
    // A surface-filtered catalog without the model picker: the row is absent, not disabled.
    server.use(http.get('*/api/brain/commands', () => HttpResponse.json({ commands: CATALOG.filter((c) => c.name !== 'model') })));
    renderRail();
    const { menu } = await openMenu();
    expect(within(menu).queryByRole('menuitem', { name: /^Model/ })).toBeNull();
    // The rest of the field is unaffected.
    expect(within(menu).getByRole('menuitem', { name: /^Compact/ })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the mascot', async () => {
    renderRail();
    const { mascot, menu } = await openMenu();
    // Radix reads Escape off the document the event bubbles through — the path a real Escape takes.
    await act(async () => { fireEvent.keyDown(menu, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(mascot);
  });
});