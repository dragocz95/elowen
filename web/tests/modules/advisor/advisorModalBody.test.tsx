import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { elowenClient } from '../../../lib/elowenClient';
import { AgentsTable } from '../../../modules/advisor/AgentsTable';
import { ProcessOutputModal } from '../../../modules/advisor/ProcessPanel';
import type { SubagentState } from '../../../lib/transcript';
import type { ProcessInfo } from '../../../lib/types';

/** `ModalBody` is the dialog's sole two-axis scroll owner. */
const MODAL_BODY = '.overflow-y-auto.overscroll-contain';
const HAND_ROLLED_BODY = '[class*="flex-1"][class*="overflow-auto"], [class*="flex-1"][class*="overflow-y-auto"]';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

function soleBody(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  const bodies = dialog.querySelectorAll(MODAL_BODY);
  expect(bodies, 'a dialog has exactly one shared ModalBody').toHaveLength(1);
  const body = bodies[0] as HTMLElement;
  const rivals = [...dialog.querySelectorAll(HAND_ROLLED_BODY)].filter((el) => el !== body);
  expect(rivals.map((el) => el.className), 'only ModalBody owns the dialog scroll').toEqual([]);
  return body;
}

const AGENTS: SubagentState[] = [
  {
    sessionId: 's-1', status: 'running', task: 'inspect the code', detail: 'Read src/a.ts',
    tools: 3, tokens: 1200, seconds: 4, model: 'anthropic/sonnet',
    thinkingLevel: 'high', thinkingLabel: 'High',
    startedAt: '2026-08-30 05:00:00', updatedAt: '2026-08-30 05:01:50',
    background: true, autoDeliver: true, resultDelivery: 'pending',
  },
  {
    sessionId: 's-2', status: 'done', task: 'write tests', detail: 'Vitest',
    tools: 8, seconds: 20, startedAt: '2026-08-30 04:00:00', updatedAt: '2026-08-30 04:00:20',
  },
];

const PROC: ProcessInfo = {
  id: 'p-1', command: 'npm run build', cwd: '/tmp', startedAt: new Date().toISOString(),
  sessionId: null, running: false, exitCode: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setMobileViewport(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('the advisor agents table', () => {
  it('uses the shared DataTable with all authoritative fields in the sole ModalBody scroller', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T05:02:00Z'));
    render(<AgentsTable agents={AGENTS} onOpen={vi.fn()} onClose={vi.fn()} />, { wrapper: W });

    const body = soleBody();
    const table = screen.getByRole('table', { name: 'Delegated sub-agents' });
    expect(body.contains(table), 'the wide register scrolls in the shared body').toBe(true);
    expect(table.tagName).toBe('DIV');
    expect(table).toHaveClass('min-w-[82rem]');
    expect(table.style.getPropertyValue('--data-table-columns')).toBe('5.5rem minmax(16rem,1.8fr) 9rem 5.5rem 4.5rem 6rem 8.5rem 8.5rem 8rem 1.25rem');

    for (const heading of ['Status', 'Task', 'Model', 'Tokens', 'Tools', 'Runtime', 'Started', 'Updated', 'Mode / delivery']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    for (const value of ['inspect the code', 'Read src/a.ts', 'anthropic/sonnet', 'High', '1.2k', 'Automatic delivery', 'Delivery pending']) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText('2m 0s')).toBeInTheDocument();
    expect(screen.getByText('20s')).toBeInTheDocument();
    expect(table.querySelector('table')).toBeNull();
  });

  it('opens the exact child session through the shared row control', () => {
    const onOpen = vi.fn();
    render(<AgentsTable agents={AGENTS} onOpen={onOpen} onClose={vi.fn()} />, { wrapper: W });

    const open = screen.getByRole('button', { name: 'Open sub-agent transcript: write tests' });
    expect(open.tagName).toBe('BUTTON');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith('s-2');
  });

  it('lays out equal-width agent columns horizontally on a phone instead of mounting the wide table', async () => {
    setMobileViewport(true);
    const onOpen = vi.fn();
    render(<AgentsTable agents={AGENTS} onOpen={onOpen} onClose={vi.fn()} />, { wrapper: W });

    const body = soleBody();
    const list = await screen.findByRole('list', { name: 'Delegated sub-agents' });
    expect(body.contains(list), 'the shared ModalBody owns the horizontal scroll').toBe(true);
    expect(screen.queryByRole('table', { name: 'Delegated sub-agents' })).not.toBeInTheDocument();
    expect(list).toHaveClass('grid-flow-col', 'w-max');
    expect(list.style.gridAutoColumns).toBe('10.5rem');
    expect(list.children).toHaveLength(2);

    for (const value of ['inspect the code', 'Read src/a.ts', 'anthropic/sonnet', 'High', '1.2k', 'Automatic delivery', 'Delivery pending']) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    const task = screen.getByText('inspect the code');
    expect(task).not.toHaveClass('truncate');

    fireEvent.click(screen.getByRole('button', { name: 'Open sub-agent transcript: write tests' }));
    expect(onOpen).toHaveBeenCalledWith('s-2');
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
    expect(pane.className).not.toMatch(/\bflex-1\b|\boverflow-auto\b/);
    expect(pane.className).toMatch(/\bbg-background\b/);
  });
});
