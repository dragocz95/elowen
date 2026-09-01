import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { ChatRailSplit } from '../../../modules/advisor/ChatRailSplit';
import { useMobileViewport } from '../../../lib/useMobile';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';

// The DAG modal is the web's answer to the CLI workflow modal: a running workflow row in the telemetry
// rail opens the graph, the graph tracks the live snapshot, and a phone gets a readable list instead of a
// micro-web. What the graph LOOKS like cannot be asserted here — jsdom measures nothing — so these tests
// cover the wiring, the liveness and the variant choice; the geometry is tested in tests/lib/workflowDag.


/** The chat page as the shell composes it — stable split host, dock on desktop, overlay on a phone. */
function ChatPage() {
  const mobile = useMobileViewport();
  return <ChatRailSplit workspace={<ChatView />} docked={mobile === false} />;
}

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
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

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

function setViewport(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: mobile, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  } as MediaQueryList));
}

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

interface TestNode { id: string; task: string; status: 'pending' | 'running' | 'done' | 'error'; deps: string[]; result?: string; error?: string }
const dagEvents = (nodes: TestNode[]) => ([
  { type: 'tool', name: 'WorkflowStart', id: 'w-call' },
  { type: 'workflow', id: 'wf-1', toolCallId: 'w-call', title: 'Rail parity', status: 'running', nodes },
]);

const NODES: TestNode[] = [
  { id: 'explore', task: 'prozkoumat kód', status: 'done' as const, deps: [], result: 'nalezeno pět volajících' },
  { id: 'write', task: 'napsat implementaci', status: 'running' as const, deps: ['explore'] },
  { id: 'verify', task: 'ověřit testy', status: 'pending' as const, deps: ['write'] },
];

/** The desktop rail arrives as the compact 52px instrument strip, so the workflow ROW a DAG opens from
 *  does not exist until the reader expands it. Expanding through the rail's own control keeps this a test
 *  of the real path rather than of the provider's initial state. */
async function expandDesktopTelemetry(): Promise<void> {
  await screen.findByTestId('telemetry-stub');
  await act(async () => { fireEvent.click(screen.getByTestId('telemetry-collapse')); });
  await screen.findByTestId('telemetry-head');
}

/** Mount the real chat page (rail + modal wiring) and hand back the stream so a test can push frames. */
async function renderChat(mobile = false): Promise<FakeES> {
  setViewport(mobile);
  const { wrapper: Wrapper } = createWrapper();
  // The dock is a shell-level panel beside the page now, so the harness composes it the way Shell does.
  render(<Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider><ChatPage /></TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  // On a phone the rail is a drawer that each test opens itself; only the desktop dock needs expanding.
  if (!mobile) await expandDesktopTelemetry();
  return FakeES.instances[0]!;
}

/** Open the DAG modal the way a user does: click the workflow row in the telemetry rail. */
async function openDag(es: FakeES, nodes: TestNode[] = NODES): Promise<void> {
  for (const event of dagEvents(nodes)) es.emit(event.type, event);
  const section = await screen.findByTestId('telemetry-workflow');
  await act(async () => { fireEvent.click(within(section).getAllByTestId('telemetry-row')[0]!); });
  await screen.findByTestId('workflow-modal');
}

describe('workflow DAG modal', () => {
  it('opens from the rail row with every node of the graph', async () => {
    const es = await renderChat();
    await openDag(es);

    expect(screen.getByTestId('workflow-dag-graph')).toBeInTheDocument();
    for (const node of NODES) expect(screen.getByTestId(`workflow-node-${node.id}`)).toBeInTheDocument();
    // One curve per real dependency — the DAG's edges, not just its boxes. Scoped to the edge class
    // rather than every <path>, so the arrowhead marker's own path is not counted as a dependency.
    const edges = screen.getByTestId('workflow-dag-graph').querySelectorAll('path.wf-dag__edge');
    expect(edges).toHaveLength(2);
    // A dependency is directed, so every edge has to carry the arrowhead that says which way it runs.
    for (const edge of edges) expect(edge.getAttribute('marker-end')).toBe('url(#wf-dag-arrowhead)');
  });

  it('closes on Escape', async () => {
    const es = await renderChat();
    await openDag(es);
    // Raised inside the modal, the way a real Escape arrives: the dialog is Radix-driven now and listens
    // on the document, which `window` sits above rather than inside.
    await act(async () => { fireEvent.keyDown(screen.getByTestId('workflow-modal'), { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByTestId('workflow-modal')).toBeNull());
  });

  it('selects the running node first, so the live work is what the modal opens on', async () => {
    const es = await renderChat();
    await openDag(es);
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('napsat implementaci');
  });

  it('shows a clicked node’s task and outcome in the detail pane', async () => {
    const es = await renderChat();
    await openDag(es);
    await act(async () => { fireEvent.click(screen.getByTestId('workflow-node-explore')); });

    const detail = screen.getByTestId('workflow-node-detail');
    expect(detail.textContent).toContain('prozkoumat kód');
    expect(detail.textContent).toContain('nalezeno pět volajících');
  });

  it('reports a failed node’s error rather than its (absent) result', async () => {
    const es = await renderChat();
    await openDag(es, [
      { id: 'explore', task: 'prozkoumat kód', status: 'error', deps: [], error: 'sub-agent spadl' },
    ]);
    await act(async () => { fireEvent.click(screen.getByTestId('workflow-node-explore')); });
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('sub-agent spadl');
  });

  it('follows the live DAG — a new frame updates the open modal', async () => {
    const es = await renderChat();
    await openDag(es);
    expect(screen.getByTestId('workflow-node-write').dataset.status).toBe('running');

    for (const event of dagEvents([
      { ...NODES[0]! },
      { id: 'write', task: 'napsat implementaci', status: 'done', deps: ['explore'], result: 'hotovo' },
      { id: 'verify', task: 'ověřit testy', status: 'running', deps: ['write'] },
      { id: 'ship', task: 'nasadit', status: 'pending', deps: ['verify'] },
    ])) es.emit(event.type, event);

    await waitFor(() => expect(screen.getByTestId('workflow-node-write').dataset.status).toBe('done'));
    // A node appended mid-run (WorkflowAddNodes) has to appear too, not only the status changes.
    expect(screen.getByTestId('workflow-node-ship')).toBeInTheDocument();
  });

  it('keeps the selection pinned to its node across a live update', async () => {
    const es = await renderChat();
    await openDag(es);
    await act(async () => { fireEvent.click(screen.getByTestId('workflow-node-explore')); });
    for (const event of dagEvents([
      { ...NODES[0]! },
      { id: 'write', task: 'napsat implementaci', status: 'done', deps: ['explore'], result: 'hotovo' },
      { id: 'verify', task: 'ověřit testy', status: 'running', deps: ['write'] },
    ])) es.emit(event.type, event);

    await waitFor(() => expect(screen.getByTestId('workflow-node-write').dataset.status).toBe('done'));
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('prozkoumat kód');
  });

  it('walks the graph with the arrow keys', async () => {
    const es = await renderChat();
    await openDag(es);
    const graph = screen.getByTestId('workflow-dag-graph');

    await act(async () => { fireEvent.keyDown(graph, { key: 'ArrowLeft' }); });
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('prozkoumat kód');
    await act(async () => { fireEvent.keyDown(graph, { key: 'ArrowRight' }); });
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('napsat implementaci');
    // Clamped at the last wave — arrowing past the end must not jump back to the start.
    await act(async () => { fireEvent.keyDown(graph, { key: 'ArrowRight' }); });
    await act(async () => { fireEvent.keyDown(graph, { key: 'ArrowRight' }); });
    expect(screen.getByTestId('workflow-node-detail').textContent).toContain('ověřit testy');
  });

  it('scrolls the graph in the shared body and keeps the node detail pinned below it', async () => {
    const es = await renderChat();
    await openDag(es);

    // `ModalBody`'s own signature (components/ui/Modal.tsx). The DAG used to build a body per branch —
    // `min-h-0 flex-1 overflow-auto` with a p-3 on the phone and a p-4 on a desktop — so the graph and the
    // list sat at different insets from the same header, each scrolling in a region the shell had already
    // provided one of.
    const dialog = screen.getByRole('dialog');
    const bodies = dialog.querySelectorAll('.overflow-y-auto.overscroll-contain');
    expect(bodies, 'the dialog has exactly one scroll region').toHaveLength(1);
    const body = bodies[0]!;

    expect(body.contains(screen.getByTestId('workflow-dag-graph')), 'the graph scrolls in the shared body').toBe(true);
    // And the dock stays OUT of it: a detail pane pinned under the scroll, the way an action row is.
    const detail = screen.getByTestId('workflow-node-detail');
    expect(body.contains(detail), 'the node detail is pinned, not scrolled away with the graph').toBe(false);
    expect(detail.className).toMatch(/\bshrink-0\b/);
  });

  it('renders the node list instead of the graph on a phone', async () => {
    const es = await renderChat(true);
    // On mobile the rail is a drawer, so the row is reached through it.
    for (const event of dagEvents(NODES)) es.emit(event.type, event);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show telemetry|Zobrazit telemetrii/i }));
    });
    const section = await screen.findByTestId('telemetry-workflow');
    await act(async () => { fireEvent.click(within(section).getAllByTestId('telemetry-row')[0]!); });

    await screen.findByTestId('workflow-modal');
    // A phone gets the same information in a readable list — never a hand-sized web of boxes.
    expect(screen.getByTestId('workflow-dag-list')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-dag-graph')).toBeNull();
    for (const node of NODES) expect(screen.getByTestId(`workflow-node-${node.id}`)).toBeInTheDocument();
  });
});
