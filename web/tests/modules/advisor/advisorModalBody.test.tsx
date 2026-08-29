import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { elowenClient } from '../../../lib/elowenClient';
import { AgentsTable } from '../../../modules/advisor/AgentsTable';
import { ProcessOutputModal } from '../../../modules/advisor/ProcessPanel';
import type { SubagentState } from '../../../lib/transcript';
import type { ProcessInfo } from '../../../lib/types';

/** The advisor's data-heavy overlays used to build their own dialog body: a `min-h-0 flex-1 overflow-auto`
 *  div with a padding of its own, and — in the agents table — a sticky head painted `bg-card` over a panel
 *  that `.overlay-surface` paints `--color-popover`. Two bodies means two scrollbars, two insets from the
 *  header and, in that one case, a visibly darker strip across the top of the table.
 *
 *  jsdom measures nothing, so what is pinned here is the OWNERSHIP: the shared `ModalBody` is the dialog's
 *  one scroll region, the content sits inside it, and no call site re-rolls a full-height scroller beside
 *  it. That is exactly what regressed, and it is visible in the DOM. */

/** `ModalBody`'s own signature (components/ui/Modal.tsx): the one region in a dialog that scrolls. */
const MODAL_BODY = '.overflow-y-auto.overscroll-contain';
/** A body rebuilt at the call site: a child stretched to the dialog's height with a scroll of its own. */
const HAND_ROLLED_BODY = '[class*="flex-1"][class*="overflow-auto"], [class*="flex-1"][class*="overflow-y-auto"]';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

/** The one scroll region of the open dialog, asserted to be the shared body and to be alone. */
function soleBody(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  const bodies = dialog.querySelectorAll(MODAL_BODY);
  expect(bodies, 'a dialog has exactly one shared ModalBody').toHaveLength(1);
  const body = bodies[0] as HTMLElement;
  // The shell already stretches the body; anything else claiming the full height with its own scroll is
  // the hand-rolled body this migration removed.
  const rivals = [...dialog.querySelectorAll(HAND_ROLLED_BODY)].filter((el) => el !== body);
  expect(rivals.map((el) => el.className), 'only ModalBody owns the dialog scroll').toEqual([]);
  return body;
}

const AGENTS: SubagentState[] = [
  { sessionId: 's-1', status: 'running', task: 'prozkoumat kód', tools: 3, tokens: 1200, seconds: 4, model: 'sonnet' },
  { sessionId: 's-2', status: 'done', task: 'napsat testy', tools: 8, seconds: 20 },
];

const PROC: ProcessInfo = {
  id: 'p-1', command: 'npm run build', cwd: '/tmp', startedAt: new Date().toISOString(),
  sessionId: null, running: false, exitCode: 0,
};

afterEach(() => vi.restoreAllMocks());

describe('the advisor agents table', () => {
  it('puts the table in the shared body instead of a scroller of its own', () => {
    render(<AgentsTable agents={AGENTS} onOpen={vi.fn()} onClose={vi.fn()} />, { wrapper: W });

    const body = soleBody();
    const table = screen.getByRole('table');
    expect(body.contains(table), 'the table scrolls in the shared body').toBe(true);
    // The rows are still there — this is a shell migration, not a rewrite of the view.
    expect(screen.getByText('prozkoumat kód')).toBeInTheDocument();
    expect(screen.getByText('napsat testy')).toBeInTheDocument();
  });

  it('floats the sticky head on the dialog’s own ground, not a second surface', () => {
    render(<AgentsTable agents={AGENTS} onOpen={vi.fn()} onClose={vi.fn()} />, { wrapper: W });

    const head = screen.getByRole('table').querySelector('thead')!;
    // Opaque it must stay, or the rows read through it while they scroll underneath.
    expect(head.className, 'a sticky head needs an opaque ground').toMatch(/\bbg-\S+/);
    // …but the ground is the surface it floats over. `--color-card` (#070707) is not `--color-popover`
    // (#151515), so `bg-card` here was a darker strip painted across the panel.
    expect(head.className, 'the head takes the overlay surface, never a second one').not.toMatch(/\bbg-card\b/);
  });
});

describe('the advisor process output modal', () => {
  it('lets the shared body scroll the live tail rather than the code pane', async () => {
    vi.spyOn(elowenClient, 'brainProcessOutput').mockResolvedValue({ output: 'line one\nline two' });
    render(<ProcessOutputModal proc={PROC} onClose={vi.fn()} />, { wrapper: W });
    await waitFor(() => expect(screen.getByText(/line two/)).toBeInTheDocument());

    const body = soleBody();
    const pane = body.querySelector('pre')!;
    expect(body.contains(pane)).toBe(true);
    // The pane is sized by its output — it is content in the body, not the body itself.
    expect(pane.className).not.toMatch(/\bflex-1\b|\boverflow-auto\b/);
    // Its dark ground and frame are the code pane's own material and deliberately survive the migration.
    expect(pane.className).toMatch(/\bbg-background\b/);
  });
});
