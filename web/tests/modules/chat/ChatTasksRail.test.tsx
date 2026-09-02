import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { ChatRailSplit } from '../../../modules/advisor/ChatRailSplit';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';
import { useMobileViewport } from '../../../lib/useMobile';

// The conversation's task list has two homes: the transcript card, which every surface has always had,
// and the rail's Tasks section, which can also CHANGE a row. Exactly one of them reports the rows at a
// time — a desktop with the rail open hands them over, a phone (no dock) and a collapsed rail keep the
// card. The rows themselves come off the card the stream already delivers, so the section costs no
// request of its own.

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

/** The rows as `pushTaskCard` emits them: the glued `text` every consumer understands, plus the
 *  structured fields a renderer that lays the row out uses instead of parsing it back. */
const CARD_ITEMS = [
  { text: '#1 Reviewing the rail', status: 'in_progress', startedAt: 100_000, id: '1', label: 'Reviewing the rail' },
  { text: '#2 Ship the fix (blocked by #1)', status: 'pending', id: '2', label: 'Ship the fix', blockedBy: ['1'] },
  { text: '#3 Draft the notes — reviewer', status: 'pending', id: '3', label: 'Draft the notes', owner: 'reviewer' },
  { text: '#4 Read the code', status: 'completed', id: '4', label: 'Read the code' },
  { text: '#5 Open the branch', status: 'completed', id: '5', label: 'Open the branch' },
];
const todoCard = (items: unknown[] = CARD_ITEMS) => ({ id: 'todos', title: 'Todos', pinned: true, items });

const STATUS = {
  running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, queued: [],
  cards: [todoCard()],
};

/** Every PATCH the rail sent, so a tick box can be asserted against the wire and not against a spy. */
let patched: { taskId: string; status?: string; subject?: string }[] = [];
let sessionTasks = [
  { id: '3', subject: 'Draft the notes', description: '', status: 'pending', owner: 'reviewer', metadata: {}, blockedBy: [], blocks: [] },
];
let statusCards: unknown[] = [todoCard()];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ ...STATUS, cards: statusCards })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ tasks: sessionTasks })),
  http.patch('*/api/plugins/todo/api/task', async ({ request }) => {
    const body = (await request.json()) as { taskId: string; status?: string; subject?: string };
    patched.push(body);
    return HttpResponse.json({ task: sessionTasks[0], tasks: sessionTasks });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  patched = [];
  statusCards = [todoCard()];
  localStorage.clear();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The chat page as the shell composes it: the split group always owns /chat, and only a measured
 *  desktop gets the trailing dock. */
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

async function expandRail(): Promise<void> {
  await screen.findByTestId('telemetry-stub');
  fireEvent.click(screen.getByTestId('telemetry-collapse'));
  await screen.findByTestId('telemetry-head');
}

async function renderDesktopRail(): Promise<HTMLElement> {
  setViewport(false);
  renderChat(<ChatPage />);
  await expandRail();
  return screen.findByTestId('telemetry-tasks');
}

describe('telemetry rail — tasks section', () => {
  it('builds the section from the structured card, running work first', async () => {
    const section = await renderDesktopRail();

    // The tally and the meter read the same done/total, and the head keeps them while the section folds.
    expect(section.textContent).toContain('2/5');
    const meter = within(section).getByRole('progressbar', { name: 'Tasks' });
    expect(meter).toHaveAttribute('aria-valuenow', '40');

    // The rows are laid out from the FIELDS, so no row repeats the glued "#2 … (blocked by #1)" text.
    const rows = within(section).getAllByTestId('telemetry-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Reviewing the rail'),
      expect.stringContaining('Ship the fix'),
      expect.stringContaining('Draft the notes'),
      expect.stringContaining('Read the code'),
    ]);
    expect(section.textContent).not.toContain('(blocked by #1)');
    expect(section.textContent).not.toContain('#2');
    // An in-progress row carries its own clock rather than a label baked into the text.
    expect(rows[0]!.textContent).toMatch(/\d+[smh]/);
    // An owner rides beside its row.
    expect(section.textContent).toContain('reviewer');
  });

  it('previews the list to the shared todo cap and unfolds the rest on demand', async () => {
    const section = await renderDesktopRail();

    expect(within(section).getAllByTestId('telemetry-row')).toHaveLength(4);
    expect(section.textContent).not.toContain('Open the branch');

    fireEvent.click(within(section).getByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(within(section).getAllByTestId('telemetry-row')).toHaveLength(5));
    expect(section.textContent).toContain('Open the branch');
  });

  it('moves a pending row to completed through its row menu and patches that task', async () => {
    const section = await renderDesktopRail();

    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Task actions: Draft the notes · reviewer' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'Completed' })); });
    await waitFor(() => expect(patched).toEqual([{ taskId: '3', status: 'completed' }]));

    // The plugin's HTTP routes answer the caller without re-emitting the panel, so the card is rebuilt
    // locally from the response. That rebuild has to keep the structured fields: a row that came back
    // without its id would still be listed but its menu could no longer address it.
    await waitFor(() => expect(within(section).getAllByTestId('telemetry-row')).toHaveLength(1));
    expect(within(section).getByRole('button', { name: 'Task actions: Draft the notes · reviewer' })).toBeEnabled();
  });

  it('reopens a completed row through the same row menu', async () => {
    const section = await renderDesktopRail();

    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Task actions: Read the code' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'Pending' })); });
    await waitFor(() => expect(patched).toEqual([{ taskId: '4', status: 'pending' }]));
  });

  it('shows the running row as the shared spinner — no tick boxes anywhere in the rail', async () => {
    const section = await renderDesktopRail();

    expect(within(section).getByTestId('telemetry-task-running')).toBeInTheDocument();
    expect(within(section).queryByRole('checkbox')).toBeNull();
  });

  it('names the unresolved blockers of a waiting row in a tooltip', async () => {
    const section = await renderDesktopRail();

    // Exactly the blocked row gets one — "Draft the notes" waits on nothing.
    const tips = within(section).getAllByTestId('telemetry-task-blocked');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveAttribute('aria-label', 'Blocked by #1');

    await act(async () => { fireEvent.click(tips[0]!); });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Blocked by #1');
  });

  it('leaves the section out once every task is ticked off', async () => {
    statusCards = [todoCard(CARD_ITEMS.map((item) => ({ ...item, status: 'completed' })))];
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    await screen.findByTestId('telemetry-head');
    expect(screen.queryByTestId('telemetry-tasks')).toBeNull();
  });

  it('opens the full task list from a row menu', async () => {
    const section = await renderDesktopRail();

    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Task actions: Draft the notes · reviewer' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'Open the task list' })); });
    expect(await screen.findByRole('dialog', { name: 'Tasks' })).toBeInTheDocument();
  });
});

describe('todo card — one home at a time', () => {
  it('hands the rows to the rail on a desktop with the rail open', async () => {
    await renderDesktopRail();
    expect(screen.queryByTestId('chat-card')).toBeNull();
  });

  it('keeps the transcript card while the desktop rail is collapsed', async () => {
    setViewport(false);
    renderChat(<ChatPage />);
    await screen.findByTestId('telemetry-stub');
    // The compact strip counts the work but cannot show it, so the card stays where it was.
    expect(await screen.findByTestId('telemetry-compact-tasks')).toHaveTextContent('2/5');
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Reviewing the rail');
  });

  it('keeps the transcript card on a phone, which has no dock to hand them to', async () => {
    setViewport(true);
    renderChat(<ChatPage />);
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Reviewing the rail');
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
  });

  // The rail takes over the checklist ROWS, not the card: it has nowhere to put a freeform body, so a
  // card carrying one still belongs under the transcript.
  it('keeps a card with a freeform body in the transcript even beside an open rail', async () => {
    statusCards = [{ ...todoCard(), body: 'Deploy notes for the release' }];
    await renderDesktopRail();
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Deploy notes for the release');
  });
});

/** Card items are a GENERIC mechanism: any plugin may emit rows, and a plugin that lays its rows out
 *  properly emits ids too. Those ids are ITS handles — a tick box built from one would PATCH the todo
 *  plugin with an id that means nothing there. Only the card the todo plugin itself emits is task-shaped,
 *  and every surface has to agree on that or the two halves disagree about who owns the rows. */
describe('todo card — only the todo plugin owns the rail', () => {
  const foreignCard = {
    id: 'other', title: 'Deploy steps', pinned: true,
    items: [{ text: '#1 Build the image', status: 'pending', id: '1', label: 'Build the image' }],
  };

  it('leaves another plugin\'s card out of the Tasks section', async () => {
    statusCards = [foreignCard];
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    await screen.findByTestId('telemetry-head');
    expect(screen.queryByTestId('telemetry-tasks')).toBeNull();
    // …and nothing of its rows could have been sent to the todo API.
    expect(patched).toEqual([]);
  });

  it('keeps another plugin\'s card in the transcript, where it is the only report of that work', async () => {
    statusCards = [foreignCard];
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Build the image');
  });

  it('hands over the todo card while a foreign card sitting beside it keeps rendering', async () => {
    statusCards = [foreignCard, todoCard()];
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    const section = await screen.findByTestId('telemetry-tasks');
    // The section counts the TODO rows alone — the foreign row is not part of the tally.
    expect(section.textContent).toContain('2/5');
    const cards = await screen.findAllByTestId('chat-card');
    expect(cards.map((card) => card.textContent).join('\n')).toContain('Build the image');
    expect(cards.map((card) => card.textContent).join('\n')).not.toContain('Reviewing the rail');
  });
});

/** A card emitted before structured items existed has rows but no ids, so the rail cannot build its
 *  section from the card alone — it asks the plugin for the task list instead. Until that answer lands the
 *  rail shows NOTHING, and a transcript card hidden "because the rail has it" would leave the reader with
 *  no checklist at all. The handover therefore waits for the rows to actually exist. */
describe('todo card — a legacy card waits for the fallback before handing over', () => {
  const LEGACY_ITEMS = [
    { text: 'Reviewing the rail', status: 'in_progress', startedAt: 100_000 },
    { text: 'Ship the fix', status: 'pending' },
  ];

  it('keeps the transcript card while the fallback query is still in flight', async () => {
    statusCards = [todoCard(LEGACY_ITEMS)];
    server.use(http.get('*/api/plugins/todo/api/tasks', () => new Promise(() => {})));
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Reviewing the rail');
    expect(screen.queryByTestId('telemetry-tasks')).toBeNull();
  });

  it('keeps the transcript card when the fallback query fails', async () => {
    statusCards = [todoCard(LEGACY_ITEMS)];
    server.use(http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ error: 'nope' }, { status: 503 })));
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    const card = await screen.findByTestId('chat-card');
    expect(card.textContent).toContain('Reviewing the rail');
    await waitFor(() => expect(screen.queryByTestId('telemetry-tasks')).toBeNull());
    expect(card.textContent).toContain('Reviewing the rail');
  });

  it('hands the rows over once the fallback has answered with them', async () => {
    statusCards = [todoCard(LEGACY_ITEMS)];
    setViewport(false);
    renderChat(<ChatPage />);
    await expandRail();
    const section = await screen.findByTestId('telemetry-tasks');
    expect(within(section).getAllByTestId('telemetry-row').map((row) => row.textContent))
      .toEqual([expect.stringContaining('Draft the notes')]);
    await waitFor(() => expect(screen.queryByTestId('chat-card')).toBeNull());
  });
});
