import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** EventSource stand-in — the surface only needs the stream to exist and to be drivable by hand. */
class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { /* nothing to tear down */ }
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

let sendBodies: Record<string, unknown>[] = [];
let renameCalls: { id: string; title: string }[] = [];
let thinkBodies: Record<string, unknown>[] = [];
let modelBodies: Record<string, unknown>[] = [];
let sessionTasks = [
  { id: '1', subject: 'Inspect auth', description: 'Check private token handling', status: 'pending', metadata: {}, blockedBy: [], blocks: [] },
  { id: '2', subject: 'Ship fix', description: 'Deploy after verification', status: 'in_progress', metadata: {}, blockedBy: ['1'], blocks: [] },
];
let thinkingLevel = 'low';

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', async ({ request }) => { sendBodies.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ ok: true }, { status: 202 }); }),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
    thinkingLevel, thinkingLevels: ['low', 'high'], thinkingLevelLabels: { low: 'Low', high: 'High' },
  })),
  http.post('*/api/brain/think', async ({ request }) => {
    const body = (await request.json()) as { level: string };
    thinkBodies.push(body as unknown as Record<string, unknown>);
    thinkingLevel = body.level;
    return HttpResponse.json({ thinkingLevel: body.level });
  }),
  http.get('*/api/plugins/todo/api/tasks', () => HttpResponse.json({ tasks: sessionTasks })),
  http.patch('*/api/plugins/todo/api/task', async ({ request }) => {
    const body = (await request.json()) as { taskId: string; status: 'pending' | 'in_progress' | 'completed' };
    sessionTasks = sessionTasks.map((task) => task.id === body.taskId ? { ...task, status: body.status } : task);
    return HttpResponse.json({ task: sessionTasks.find((task) => task.id === body.taskId), tasks: sessionTasks });
  }),
  http.delete('*/api/plugins/todo/api/task', ({ request }) => {
    const taskId = new URL(request.url).searchParams.get('taskId');
    sessionTasks = sessionTasks.filter((task) => task.id !== taskId);
    return HttpResponse.json({ success: true, taskId, tasks: sessionTasks });
  }),
  http.get('*/api/plugins/skills/list', () => HttpResponse.json([
    { name: 'deploy', description: 'Ship it', source: 'user', owner: 1, canDelete: true, disableModelInvocation: false, scope: 'personal', active: true },
    { name: 'pdf', description: 'Read PDFs', source: 'bundled', owner: null, canDelete: false, disableModelInvocation: false, scope: 'bundled', active: true },
  ])),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/models', () => HttpResponse.json([
    { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'e1', source: 'oauth' },
    { provider: 'openai-codex', providerLabel: 'OpenAI', model: 'gpt-5.6-sol', exec: 'e2', source: 'oauth' },
  ])),
  http.post('*/api/brain/model', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    modelBodies.push(body);
    return HttpResponse.json({ model: String(body['model']) });
  }),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Katalog dílů', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.patch('*/api/brain/sessions/:id', async ({ request, params }) => {
    const body = (await request.json()) as { title: string };
    renameCalls.push({ id: String(params['id']), title: body.title });
    return HttpResponse.json({ id: params['id'], title: body.title });
  }),
  // The catalog the daemon publishes for the web surface (single source of truth).
  http.get('*/api/brain/commands', () => HttpResponse.json({
    commands: [
      { name: 'plan', description: 'Plan mode', kind: 'mode' },
      { name: 'build', description: 'Build mode', kind: 'mode' },
      { name: 'workflow', description: 'Workflow mode', kind: 'mode' },
      { name: 'rename', description: 'Rename this conversation', kind: 'picker' },
      { name: 'reasoning', description: 'Set the reasoning effort', kind: 'picker' },
      { name: 'skills', description: 'Inspect and manage loaded skills', kind: 'picker' },
      { name: 'tasks', description: 'Inspect and manage conversation tasks', kind: 'picker' },
      { name: 'model', description: 'Switch the model', kind: 'picker' },
      { name: 'help', description: 'List every command', kind: 'info' },
    ],
  })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; sendBodies = []; renameCalls = []; thinkBodies = []; modelBodies = []; sessionTasks = [
  { id: '1', subject: 'Inspect auth', description: 'Check private token handling', status: 'pending', metadata: {}, blockedBy: [], blocks: [] },
  { id: '2', subject: 'Ship fix', description: 'Deploy after verification', status: 'in_progress', metadata: {}, blockedBy: ['1'], blocks: [] },
]; thinkingLevel = 'low'; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** Run a slash command through the composer's menu, exactly as the user does. */
async function runSlash(name: string) {
  const composer = await screen.findByRole('textbox');
  act(() => fireEvent.change(composer, { target: { value: `/${name}` } }));
  const menu = await screen.findByTestId('chat-slash-menu');
  const item = await within(menu).findByText(`/${name}`);
  await act(async () => { fireEvent.mouseDown(item); });
}

async function send(text: string) {
  const composer = await screen.findByRole('textbox');
  act(() => fireEvent.change(composer, { target: { value: text } }));
  await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
}

describe('web slash commands: work mode + rename', () => {
  it('sends in build mode by default and shows no mode pill', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await send('ahoj');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ mode: 'build' });
    expect(screen.queryByTestId('chat-work-mode')).toBeNull();
  });

  it('/plan switches the work mode, shows it, and stamps every following send', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('plan');
    expect(await screen.findByTestId('chat-work-mode')).toBeInTheDocument();
    await send('rozmysli to');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: 'rozmysli to', mode: 'plan' });

    // …and back: /build clears the pill and the stamp returns to build.
    await runSlash('build');
    await waitFor(() => expect(screen.queryByTestId('chat-work-mode')).toBeNull());
    await send('do it');
    await waitFor(() => expect(sendBodies.length).toBe(2));
    expect(sendBodies[1]).toMatchObject({ mode: 'build' });
  });

  it('/workflow stamps the workflow mode', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('workflow');
    await send('rozděl to');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ mode: 'workflow' });
  });

  it('/rename opens a dialog prefilled with the conversation title and PATCHes the new one', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await screen.findByText('Katalog dílů');
    await runSlash('rename');
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('textbox');
    expect(field).toHaveValue('Katalog dílů');
    act(() => fireEvent.change(field, { target: { value: '  Objednávky  ' } }));
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    await waitFor(() => expect(renameCalls).toEqual([{ id: 'brain-1', title: 'Objednávky' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // `/reasoning` used to be absent from the web catalog because nothing here could render it. Both halves
  // of the CLI command are covered: the effort picker (POST /brain/think) and the `show` sub-behaviour.
  it('opens the same reasoning drawer from the brain button', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    expect(await screen.findByRole('dialog', { name: 'Reasoning' })).toHaveClass('animate-drawer-in');
  });

  it('/reasoning opens the drawer and applies a slider step to the bound conversation', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('reasoning');
    let dialog = await screen.findByRole('dialog');
    const slider = within(dialog).getByRole('slider', { name: 'Effort' });
    expect(slider).toHaveValue('0');
    await act(async () => { fireEvent.change(slider, { target: { value: '1' } }); });
    await waitFor(() => expect(thinkBodies).toEqual([{ level: 'high', session: 'brain-1' }]));
    expect(within(dialog).getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('slider', { name: 'Effort' })).toHaveValue('1'));
  });

  it('/reasoning toggles the Thought rows (the CLI\u2019s "/reasoning show")', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('reasoning');
    const dialog = await screen.findByRole('dialog');
    const toggle = within(dialog).getByRole('switch');
    const before = toggle.getAttribute('aria-checked');
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).not.toBe(before));
  });

  it('keeps the thought switch usable when the model offers no effort levels', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: true, sessionId: 'brain-1', model: 'plain', usage: null, statusline: null, cards: [], queued: [],
      thinkingLevel: '', thinkingLevels: [], thinkingLevelLabels: {},
    })));
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    fireEvent.click(await screen.findByTestId('chat-thoughts-toggle'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('No effort levels')).toBeInTheDocument();
    const toggle = within(dialog).getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  // `/skills` used to be a toast of names glued together; it is a modal now, and loading one sends PI's
  // native `/skill:name` exactly as the CLI's picker does.
  it('/skills lists the loaded skills and loads one into the conversation', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('skills');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('/skill:deploy')).toBeInTheDocument();
    expect(within(dialog).getByText('/skill:pdf')).toBeInTheDocument();
    // A bundled skill is protected, exactly as in the CLI picker.
    const deletes = within(dialog).getAllByRole('button', { name: 'Delete' });
    expect(deletes[0]).not.toBeDisabled();
    expect(deletes[1]).toBeDisabled();

    const load = within(dialog).getAllByRole('button', { name: 'Load into conversation' })[0]!;
    await act(async () => { fireEvent.click(load); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: '/skill:deploy' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('/tasks shows descriptions, updates status and deletes with confirmation', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('tasks');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Check private token handling')).toBeInTheDocument();
    expect(within(dialog).getByText('Deploy after verification')).toBeInTheDocument();

    const status = within(dialog).getByRole('combobox', { name: 'Status: Inspect auth' });
    await act(async () => { fireEvent.change(status, { target: { value: 'completed' } }); });
    await waitFor(() => expect(sessionTasks[0]?.status).toBe('completed'));

    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Delete' })[0]!);
    // `alertdialog`, not `dialog`: a confirmation is an alert dialog now, which is what makes it
    // undismissable by a stray press outside it.
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this task?' });
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' })); });
    await waitFor(() => expect(sessionTasks.map((task) => task.id)).toEqual(['2']));
    await waitFor(() => expect(screen.queryByText('Inspect auth')).toBeNull());
  });

  // The decision itself now comes from the DAEMON (the work mode rides the snapshot's control frame), so
  // these two drive the mode the way the daemon reports it and use the composer's own `/plan` only for
  // what it still owns: the mode pill and the mode the next send is stamped with.
  async function submitPlanInPlanMode(): Promise<void> {
    await runSlash('plan');
    const es = FakeES.instances[0];
    if (!es) throw new Error('no stream opened');
    act(() => {
      es.emit({ type: 'snapshot', history: [], events: [], control: { streaming: false, pendingAsk: null, workMode: 'plan', pendingPlan: null } });
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'call-1' });
      es.emit({ type: 'tool_end', id: 'call-1', plan: '1. read\n2. write' });
      es.emit({ type: 'idle' });
    });
  }

  it('offers the plan decision once a plan is submitted and implements it in build mode', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await submitPlanInPlanMode();
    await screen.findByTestId('plan-decision-implement');
    await act(async () => { fireEvent.click(screen.getByTestId('plan-decision-implement')); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: 'Implement the plan you proposed above.', mode: 'build' });
    // Approving leaves plan mode, so the decision and the mode pill are gone.
    await waitFor(() => expect(screen.queryByTestId('plan-decision-implement')).toBeNull());
    expect(screen.queryByTestId('chat-work-mode')).toBeNull();
  });

  it('keeps the plan decision available when approving it fails', async () => {
    // Leaving plan mode up front removed this control the moment a send failed, so the plan was still
    // waiting but the only button that could approve it was gone. The mode follows the daemon's acceptance.
    server.use(http.post('*/api/brain/send', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await submitPlanInPlanMode();
    await screen.findByTestId('plan-decision-implement');
    await act(async () => { fireEvent.click(screen.getByTestId('plan-decision-implement')); });

    // Still approvable, and still in plan mode — the failed attempt changed nothing.
    expect(await screen.findByTestId('plan-decision-implement')).toBeInTheDocument();
    expect(screen.getByTestId('chat-work-mode')).toBeInTheDocument();

    // And a retry works once the daemon accepts it.
    server.use(http.post('*/api/brain/send', async ({ request }) => {
      sendBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true }, { status: 202 });
    }));
    await act(async () => { fireEvent.click(screen.getByTestId('plan-decision-implement')); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('plan-decision-implement')).toBeNull());
  });
});

describe('web slash commands: /help and /model overlays', () => {
  /** `/help` was a toast that glued the bare names together and vanished — no descriptions, and nothing
   *  to click. A command menu that cannot be read or used is worse than no menu, so this pins the two
   *  things the toast could not do: show what a command DOES, and run it. */
  it('/help lists the catalog with descriptions and runs the command that is clicked', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('help');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('/plan')).toBeInTheDocument();
    expect(within(dialog).getByText('Plan mode')).toBeInTheDocument();
    // `/help` does not list itself: re-opening the overlay you are reading is not a command.
    expect(within(dialog).queryByText('/help')).toBeNull();

    await act(async () => { fireEvent.click(within(dialog).getByText('/plan')); });
    expect(await screen.findByTestId('chat-work-mode')).toBeInTheDocument();
  });

  it('/help filters by name and by description', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('help');
    const dialog = await screen.findByRole('dialog');

    act(() => fireEvent.change(within(dialog).getByLabelText('Filter commands'), { target: { value: 'rename' } }));
    await waitFor(() => expect(within(dialog).queryByText('/plan')).toBeNull());
    expect(within(dialog).getByText('/rename')).toBeInTheDocument();

    // The description is searchable too — people look for what a command does, not its name.
    act(() => fireEvent.change(within(dialog).getByLabelText('Filter commands'), { target: { value: 'effort' } }));
    await waitFor(() => expect(within(dialog).queryByText('/rename')).toBeNull());
    expect(within(dialog).getByText('/reasoning')).toBeInTheDocument();
  });

  /** `/model` used to take over the composer's suggestion dropdown and list flat `provider/model` text,
   *  so the same choice looked different depending on where it was started. It is now the overlay, built
   *  from the same rows as the header picker — grouped by provider, with brand icons. */
  it('/model opens the grouped catalog with icons and switches the conversation', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('model');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Anthropic')).toBeInTheDocument();
    const row = within(dialog).getByRole('option', { name: /claude-opus-5/ });
    // The brand icon is what the plain dropdown could not carry; without it this is the old flat list.
    expect(row.querySelector('img, svg')).not.toBeNull();

    await act(async () => { fireEvent.click(row); });
    await waitFor(() => expect(modelBodies.length).toBe(1));
    expect(modelBodies[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    // Picking closes the overlay rather than leaving it over the conversation.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
