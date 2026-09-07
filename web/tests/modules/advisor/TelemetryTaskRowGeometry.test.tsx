import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';

// The rail is dragged between 240px and 560px and is pinned to the phone's width in the drawer, so a task
// row has exactly one elastic column: the subject. Everything after it — the live clock, a sub-agent's
// token count — is fixed and has to stay on screen at every one of those widths.
//
// The failure this pins was not a missing `truncate`. The subject already had one; what it truncated
// against was the ActionMenu's positioning wrapper, a block-level flex item whose automatic minimum size
// is its content's min-content width. Holding nowrap text, that wrapper kept its max-content width, the
// subject clipped against a box far wider than the rail, and the clock behind it was laid out past the
// right edge — off screen, with no axis to scroll it back into view.
//
// jsdom does no layout, so nothing here can measure. What it CAN hold is the structure that decision
// rests on: which element gives, which does not, and the source pin below for the one class that has to
// survive a future edit of the Button primitive.

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

/** A subject nobody would shorten — the shape the owner's screenshot caught running off the rail. */
const LONG_SUBJECT = 'Delegate fork: dědění rodičovského kontextu on/off + měření cache hit rate';
const LONG_COMMAND = 'Bash cd /var/www/.config/elowen/worktrees/store-truth-2 && npm run test -- --reporter dot';

const todoCard = () => ({
  id: 'todos',
  title: 'Todos',
  pinned: true,
  items: [
    { text: `#1 ${LONG_SUBJECT}`, status: 'in_progress', startedAt: 100_000, id: '1', label: LONG_SUBJECT },
    { text: '#2 Ship the fix', status: 'pending', id: '2', label: 'Ship the fix' },
  ],
});

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, queued: [], cards: [todoCard()],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function renderRail(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat />{node}</BrainChatProvider></ToastProvider></Wrapper>);
}

const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);

/** The `web/` root, resolved from THIS file rather than from the process's working directory: the source
 *  pins below must keep reading the same files whoever starts the runner and from wherever. */
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The three parts of a task row, addressed the way the rail's own ids name them. */
async function taskRowParts(host: HTMLElement) {
  // The clock rides the ONE in-progress row, so it is what identifies the row worth measuring.
  const elapsed = await within(host).findByTestId('telemetry-task-elapsed');
  const row = elapsed.closest('li') as HTMLElement;
  const subject = within(row).getByTestId('telemetry-task-subject');
  // The ActionMenu's positioning wrapper: the row's shrinking column, and the element that used to
  // refuse to give. Addressed by the id the rail stamps on it — matching on the utility classes it
  // happens to carry would fail on a restyle instead of on the geometry this suite guards.
  const wrapper = within(row).getByTestId('telemetry-task-menu');
  return { subject, elapsed, wrapper };
}

describe('telemetry rail — a task row keeps its trailing meta on screen', () => {
  it('gives the subject the row\'s slack and pins the live clock beside it in the docked rail', async () => {
    renderRail(<TelemetryPanel variant="column" />);
    const section = await screen.findByTestId('telemetry-tasks');
    const { subject, elapsed, wrapper } = await taskRowParts(section);

    // The clock is rendered at all — the regression put it past the rail's right edge, where it still
    // existed in the DOM and could not be read.
    expect(elapsed).toHaveTextContent(/\d+[smh]/);
    // …and it is the fixed column: it never gives up width to the subject beside it.
    expect(classesOf(elapsed)).toContain('shrink-0');

    // The subject is the ONE elastic column, and it clips rather than widening the row.
    expect(classesOf(subject)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']));
    // A clipped subject is still readable without opening the full list.
    expect(subject).toHaveAttribute('title', LONG_SUBJECT);
    expect(subject).toHaveTextContent(LONG_SUBJECT);

    // The wrapper is what the subject truncates against, so it has to be able to shrink below its own
    // min-content width. Without this the truncation happens against a box wider than the rail.
    expect(wrapper).not.toBeNull();
    expect(classesOf(wrapper)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    // The trigger spans that column, which is what puts the clock on the right edge rather than
    // trailing the subject's own text width.
    expect(classesOf(within(wrapper).getByRole('button'))).toEqual(expect.arrayContaining(['w-full', 'min-w-0']));
  });

  it('keeps the same geometry in the phone drawer, where the rail has no width to spare', async () => {
    renderRail(<TelemetryPanel variant="drawer" open onClose={() => {}} />);
    const drawer = await screen.findByTestId('telemetry-drawer');
    const { subject, elapsed, wrapper } = await taskRowParts(drawer);

    expect(elapsed).toHaveTextContent(/\d+[smh]/);
    expect(classesOf(elapsed)).toContain('shrink-0');
    expect(classesOf(subject)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']));
    expect(subject).toHaveAttribute('title', LONG_SUBJECT);
    expect(classesOf(wrapper)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
  });

  it('truncates the tally in the collapsed strip instead of widening the 52px rail', async () => {
    renderRail(<TelemetryPanel variant="column" collapsed onToggleCollapsed={() => {}} />);
    const strip = await screen.findByTestId('telemetry-stub');
    const tasks = await within(strip).findByTestId('telemetry-compact-tasks');

    // The compact rail reports the same list as a tally, and its value is the only text in a fixed 40px
    // column — so it truncates rather than setting the strip's width.
    expect(tasks).toHaveAccessibleName('Tasks: 0/2');
    expect(classesOf(within(tasks).getByText('0/2'))).toEqual(expect.arrayContaining(['max-w-full', 'truncate']));
  });

  it('lets a sub-agent row shrink so its token count stays inside the rail', async () => {
    renderRail(<TelemetryPanel variant="column" />);
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, history: [],
      control: { streaming: false, pendingAsk: null },
      events: [
        { type: 'tool', name: 'Delegate', id: 't1' },
        { type: 'subagent', id: 't1', sessionId: 'child-1', status: 'running', task: LONG_COMMAND, tokens: 40_100_000, tools: 1, seconds: 2 },
      ],
    });

    const section = await screen.findByTestId('telemetry-agents');
    const row = within(section).getByTestId('telemetry-row');
    // The row's own label gives, the token count does not — the same two-column contract as a task row.
    expect(classesOf(within(row).getByText(LONG_COMMAND))).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']));
    const meta = within(row).getByText('40.1M');
    expect(classesOf(meta)).toContain('shrink-0');
    // The row itself must be able to shrink; the Button primitive's base says `shrink-0`.
    expect(classesOf(row)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'shrink']));
    expect(classesOf(row)).not.toContain('shrink-0');
  });
});

// A source pin, because jsdom cannot see a stylesheet and the class it guards comes from a SHARED
// primitive. `buttonVariants` puts `shrink-0` in its base, which is right for a button in a toolbar and
// wrong for one that IS a rail row: with the row's icon, badge and kill button at their natural widths
// there can be no free space left to grow into, and a row that cannot shrink either lays its trailing
// token count past the rail's edge. `LiveRow` has to keep overriding it.
describe('telemetry rail — the row button opts back into shrinking', () => {
  const source = readFileSync(join(WEB, 'modules', 'advisor', 'TelemetryPanel.tsx'), 'utf8');

  it('overrides the Button primitive\'s base shrink-0 on the live row', () => {
    const liveRowClass = source.match(/className="h-6 min-w-0 flex-1 shrink [^"]*"/);
    expect(liveRowClass, 'LiveRow must keep `shrink` beside `flex-1`').not.toBeNull();
  });

  it('still describes the trailing meta as the fixed column', () => {
    expect(source).toContain('shrink-0 font-mono tabular-nums text-muted-foreground');
  });

  it('pins that the primitive it overrides really does ship shrink-0', () => {
    const button = readFileSync(join(WEB, 'components', 'ui', 'shadcn', 'button.tsx'), 'utf8');
    expect(button).toContain('inline-flex shrink-0 items-center');
  });
});
