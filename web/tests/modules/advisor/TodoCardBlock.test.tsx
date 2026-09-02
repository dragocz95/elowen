import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { BrainChatSurface, CardBlock } from '../../../modules/advisor/BrainChatSurface';
import type { BrainCard } from '../../../lib/types';

// The transcript's todo card is the conversation's checklist wherever the telemetry rail is not carrying
// its Tasks section — a collapsed rail on a desktop, and every phone, which has no dock at all. So it is
// not a read-out: it ticks rows off, changes their status and opens the full list, and it has to do all
// three with a finger on a 390px screen.
//
// The card is rendered without a docked rail here (`telemetryShown` is undefined), which is exactly the
// state those two surfaces are in. Who hands the rows over to whom when a rail IS docked belongs to
// ChatTasksRail.test.tsx and is deliberately not restated.

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt?: number;
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  metadata: Record<string, unknown>;
}

const task = (over: Partial<Task> & Pick<Task, 'id' | 'subject'>): Task => ({
  description: '', status: 'pending', blockedBy: [], blocks: [], metadata: {}, ...over,
});

/** The plugin's own task list — the PATCH answers from it, and the card is rebuilt from that answer. */
const TASKS: Task[] = [
  task({ id: '1', subject: 'Reviewing the card', status: 'in_progress', startedAt: 100_000 }),
  task({ id: '2', subject: 'Ship the fix', blockedBy: ['1'] }),
  task({ id: '3', subject: 'Draft the notes', owner: 'reviewer' }),
  task({ id: '4', subject: 'Read the code', status: 'completed' }),
];

/** The card as `pushTaskCard` emits it: the glued `text` every consumer understands, plus the structured
 *  fields a renderer that lays the row out uses instead of parsing it back. */
const CARD_ITEMS = [
  { text: '#1 Reviewing the card', status: 'in_progress', startedAt: 100_000, id: '1', label: 'Reviewing the card' },
  { text: '#2 Ship the fix (blocked by #1)', status: 'pending', id: '2', label: 'Ship the fix', blockedBy: ['1'] },
  { text: '#3 Draft the notes — reviewer', status: 'pending', id: '3', label: 'Draft the notes', owner: 'reviewer' },
  { text: '#4 Read the code', status: 'completed', id: '4', label: 'Read the code' },
];
const todoCard = (items: unknown[] = CARD_ITEMS) => ({ id: 'todos', title: 'Todos', pinned: true, items });

let tasks: Task[] = [];
let statusCards: unknown[] = [];
/** Every PATCH the card sent, so a control can be asserted against the wire rather than against a spy. */
let patched: { taskId: string; status?: string }[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, queued: [], cards: statusCards,
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ tasks })),
  http.patch('*/api/plugins/todo/api/task', async ({ request }) => {
    const body = (await request.json()) as { taskId: string; status?: Task['status'] };
    patched.push(body);
    tasks = tasks.map((t) => (t.id === body.taskId && body.status ? { ...t, status: body.status } : t));
    return HttpResponse.json({ task: tasks.find((t) => t.id === body.taskId), tasks });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  tasks = TASKS.map((t) => ({ ...t }));
  statusCards = [todoCard()];
  patched = [];
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider>{node}</BrainChatProvider></ToastProvider></Wrapper>);
}

/** The card as a phone gets it — the viewport the interactive controls have to survive. */
async function renderCard(mobile = true): Promise<HTMLElement> {
  setViewport(mobile);
  renderChat(<BrainChatSurface variant="full" />);
  return screen.findByTestId('chat-card');
}

/** The row IS the control: one button per task, named after it. */
function rowOf(card: HTMLElement, subject: string): HTMLElement {
  return within(card).getByRole('button', { name: `Task actions: ${subject}` });
}

/** Open one row's action menu by clicking the row. */
async function openRowMenu(subject: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: `Task actions: ${subject}` }));
  return screen.findByRole('menu');
}

describe('todo card — the checklist as a control surface', () => {
  it('lays the rows out from the structured fields, with a meter and a way into the full list', async () => {
    const card = await renderCard();

    // The tally and the meter read the same done/total.
    expect(card.textContent).toContain('1/4');
    expect(within(card).getByRole('progressbar', { name: 'Tasks' })).toHaveAttribute('aria-valuenow', '25');
    expect(within(card).getByTestId('chat-card-open-tasks')).toHaveAccessibleName('Open the task list');

    // Laid out from the FIELDS, so no row repeats the glued "#2 … (blocked by #1)" text the emitter wrote.
    const rows = within(card).getAllByTestId('chat-card-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Reviewing the card'),
      expect.stringContaining('Ship the fix'),
      expect.stringContaining('Draft the notes'),
      expect.stringContaining('Read the code'),
    ]);
    expect(card.textContent).not.toContain('(blocked by #1)');
    expect(card.textContent).not.toContain('#2');
    // The running row carries its own clock, and the owner rides beside its row.
    expect(within(card).getByTestId('chat-card-elapsed')).toHaveTextContent(/\d+[smh]/);
    expect(card.textContent).toContain('reviewer');

    // Three states, three glyphs, the same ones the read-only card and the CLI panel draw. No tick box:
    // a box invites a stray click, and every change here reaches the agent's plan.
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(rowOf(card, 'Reviewing the card')).getByTestId('chat-card-running')).toBeInTheDocument();
    expect(rowOf(card, 'Draft the notes')).toHaveTextContent('○');
    expect(rowOf(card, 'Read the code')).toHaveTextContent('✔');
    // The row is the control, and its whole text is the target.
    expect(rowOf(card, 'Draft the notes')).toHaveAccessibleName('Task actions: Draft the notes');
  });

  it('finishes a pending row from its menu and rebuilds the card from the answer', async () => {
    const card = await renderCard();

    const menu = await openRowMenu('Draft the notes');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Completed' })); });
    await waitFor(() => expect(patched).toEqual([{ taskId: '3', status: 'completed' }]));

    // The plugin's HTTP routes answer the caller without re-emitting the panel, so the card is rebuilt
    // locally from the response. That rebuild has to keep the structured fields: a row that came back
    // without its id would still be listed and would no longer have a menu.
    await waitFor(() => expect(rowOf(card, 'Draft the notes')).toHaveTextContent('✔'));
    expect(card.textContent).toContain('2/4');
    expect(within(card).getByRole('progressbar', { name: 'Tasks' })).toHaveAttribute('aria-valuenow', '50');
  });

  it('reopens a completed row from the same menu', async () => {
    const card = await renderCard();

    const menu = await openRowMenu('Read the code');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pending' })); });
    await waitFor(() => expect(patched).toEqual([{ taskId: '4', status: 'pending' }]));
    await waitFor(() => expect(rowOf(card, 'Read the code')).toHaveTextContent('○'));
  });

  // Every status lives behind the row, which is a tap and not a hover, so the phone reaches it the same
  // way a mouse does.
  it('offers every status behind the row and patches the one that is chosen', async () => {
    await renderCard();

    const menu = await openRowMenu('Ship the fix');
    for (const name of ['Pending', 'In progress', 'Completed', 'Open the task list']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }

    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'In progress' })); });
    await waitFor(() => expect(patched).toEqual([{ taskId: '2', status: 'in_progress' }]));
    await waitFor(() => expect(within(rowOf(screen.getByTestId('chat-card'), 'Ship the fix')).getByTestId('chat-card-running')).toBeInTheDocument());
  });

  it('opens the row menu on a click only, never because the pointer crossed the row', async () => {
    // The row sits in the reading path: a pointer on its way to the composer crosses it on every pass,
    // and the generic ActionMenu opens on hover. Here that would pop a menu over the very text being read.
    await renderCard();
    const trigger = screen.getByRole('button', { name: 'Task actions: Ship the fix' });

    fireEvent.mouseEnter(trigger.parentElement!);
    fireEvent.mouseEnter(trigger);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('sends nothing when the status picked is the one the row already has', async () => {
    await renderCard();

    const menu = await openRowMenu('Draft the notes');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pending' })); });
    expect(patched).toEqual([]);
  });

  it('names the unresolved blockers of a waiting row in a tooltip', async () => {
    const card = await renderCard();

    // Exactly the blocked row gets one — "Draft the notes" waits on nothing.
    const tips = within(card).getAllByTestId('chat-card-blocked');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveAttribute('aria-label', 'Blocked by #1');

    await act(async () => { fireEvent.click(tips[0]!); });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Blocked by #1');
  });

  it('opens the full task list from the head button and from a row menu', async () => {
    const card = await renderCard();

    await act(async () => { fireEvent.click(within(card).getByTestId('chat-card-open-tasks')); });
    expect(await screen.findByRole('dialog', { name: 'Tasks' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tasks' })).toBeNull());

    const menu = await openRowMenu('Draft the notes');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open the task list' })); });
    expect(await screen.findByRole('dialog', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('folds the rows away on a click on the head and brings them back', async () => {
    const card = await renderCard();

    const head = within(card).getByRole('button', { expanded: true });
    fireEvent.click(head);
    await waitFor(() => expect(within(card).queryAllByTestId('chat-card-row')).toHaveLength(0));
    // The tally stays: a folded card still has to report what it is holding.
    expect(card.textContent).toContain('1/4');

    fireEvent.click(head);
    await waitFor(() => expect(within(card).getAllByTestId('chat-card-row')).toHaveLength(4));
  });

  it('previews a long list to the shared cap and unfolds the rest on demand', async () => {
    statusCards = [todoCard([
      ...CARD_ITEMS,
      { text: '#5 Open the branch', status: 'pending', id: '5', label: 'Open the branch' },
      { text: '#6 Close the branch', status: 'pending', id: '6', label: 'Close the branch' },
    ])];
    const card = await renderCard();

    expect(within(card).getAllByTestId('chat-card-row')).toHaveLength(4);
    fireEvent.click(within(card).getByRole('button', { name: /more|další|ďalš/i }));
    await waitFor(() => expect(within(card).getAllByTestId('chat-card-row')).toHaveLength(6));
    expect(card.textContent).toContain('Close the branch');
  });

  it('leaves the transcript once every task is ticked off', async () => {
    statusCards = [todoCard(CARD_ITEMS.map((item) => ({ ...item, status: 'completed' })))];
    setViewport(true);
    renderChat(<BrainChatSurface variant="full" />);
    await screen.findByRole('textbox');
    await waitFor(() => expect(screen.queryByTestId('chat-card')).toBeNull());
  });

  // The rule belongs to the CARD, not only to the transcript's filter above it: `CardBlock` is exported
  // and rendered directly too, and a finished list has nothing left to track wherever it is mounted.
  it('renders nothing for a finished card even when it is mounted directly', () => {
    const finished = todoCard(CARD_ITEMS.map((item) => ({ ...item, status: 'completed' }))) as unknown as BrainCard;
    renderChat(<CardBlock card={finished} live={false} />);
    expect(screen.queryByTestId('chat-card')).toBeNull();
  });

  // A refused patch must leave the row exactly as it was AND say so: nothing is written into the card
  // before the daemon agrees, so the rollback is that the card was never changed.
  it('reports a refused patch and leaves the row as it was', async () => {
    server.use(http.patch('*/api/plugins/todo/api/task', () => HttpResponse.json({ error: 'nope' }, { status: 503 })));
    const card = await renderCard();

    const menu = await openRowMenu('Draft the notes');
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Completed' })); });

    expect(await screen.findByText(/elowen 503/, { selector: '[data-slot="toast-description"]' })).toBeInTheDocument();
    expect(rowOf(card, 'Draft the notes')).toHaveTextContent('○');
    expect(card.textContent).toContain('1/4');
  });
});

/** The card is the checklist a PHONE gets, so nothing in it may depend on a pointer being present, and
 *  every control has to be nameable by something that cannot see it. */
describe('todo card — reachable on a 390px screen', () => {
  it('names every control and hides none of them behind a hover', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const card = await renderCard();

    const controls = within(card).getAllByRole('button');
    // the fold, the way into the list, four rows, one blocked marker
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const control of controls) {
      expect(control, control.outerHTML).toHaveAccessibleName();
    }
    // Nothing is revealed by a pointer: no control is painted out, and none waits on a parent's hover.
    expect(card.querySelectorAll('[class*="group-hover:"], [class*="opacity-0"], [class*="invisible"]')).toHaveLength(0);
  });
});

/** Card items are a GENERIC mechanism: any plugin may emit rows, and a plugin that lays its rows out
 *  properly emits ids too. Those ids are ITS handles — a tick box built from one would PATCH the todo
 *  plugin with an id that means nothing there. Only the card the todo plugin itself emits is task-shaped. */
describe('todo card — only the todo plugin gets controls', () => {
  it('leaves another plugin\'s card read-only, text and all', async () => {
    statusCards = [{
      id: 'other', title: 'Deploy steps', pinned: true,
      items: [{ text: '#1 Build the image', status: 'pending', id: '1', label: 'Build the image' }],
    }];
    const card = await renderCard();

    expect(card.textContent).toContain('#1 Build the image');
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(card).queryByRole('button', { name: /Task actions/ })).toBeNull();
    expect(within(card).queryByTestId('chat-card-open-tasks')).toBeNull();
    expect(patched).toEqual([]);
  });

  // A card emitted before structured items existed has rows but no handles, and a half-addressable list
  // would offer controls that work on some rows only — so it is all or nothing.
  it('leaves a todo card without task ids read-only', async () => {
    statusCards = [todoCard([
      { text: '#1 Reviewing the card', status: 'in_progress', startedAt: 100_000 },
      { text: '#2 Ship the fix', status: 'pending' },
    ])];
    const card = await renderCard();

    expect(card.textContent).toContain('#1 Reviewing the card');
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(card).queryByTestId('chat-card-open-tasks')).toBeNull();
    // …and it keeps the read-only rendering's own ticking clock rather than losing it with the controls.
    expect(within(card).getByTestId('chat-card-elapsed')).toHaveTextContent(/\d+[smh]/);
  });
});
