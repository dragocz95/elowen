import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useEffect } from 'react';
import type { PluginChatArtifactProps } from 'elowen-plugin-ui-kit';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { ToastProvider } from '../../../components/ui/Toast';
import type { BrainInlineArtifact } from '../../../lib/types';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';

/** An artifact that expands into its own surface covers the chat it belongs to — the question card
 *  included. This mounts the real surface over a real parked ask and checks the whole path the plugin
 *  contract rides on: that the artifact is told a prompt is waiting, that what it is told carries nothing
 *  about the question, that `reveal` brings the host's own card back, and that it all clears with the ask. */

const mocks = vi.hoisted(() => ({ loadPluginUi: vi.fn(), listing: { data: [] as unknown[], isLoading: false } }));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePluginUi: () => mocks.listing,
}));
vi.mock('../../../lib/pluginUi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPluginUi: mocks.loadPluginUi,
}));

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

const artifact: BrainInlineArtifact = {
  id: 'artifact-1', plugin: 'browser', sessionId: 'brain-1', toolCallId: 'call-1', view: 'preview',
  fallback: 'Browser preview is unavailable.', data: {}, expiresAt: '2030-01-01T00:00:00.000Z',
  status: 'open', createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
};
/** The artifact hangs off a tool call, so the transcript needs the call it belongs to. */
const HISTORY = [{
  id: 'm1', role: 'assistant', text: '',
  segments: [{ kind: 'tool', name: 'BrowserOpen', id: 'call-1', detail: 'example.com' }],
}];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: HISTORY, hasMore: false, nextBefore: null })
    : HttpResponse.json(HISTORY)),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null,
    cards: [], artifacts: [artifact], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
);

let seen: PluginChatArtifactProps[] = [];
const View = (props: PluginChatArtifactProps) => {
  seen.push(props);
  return (
    <button type="button" data-testid="artifact-alert" onClick={() => props.pendingInput?.reveal()}>
      {props.pendingInput ? props.pendingInput.label : 'nothing waiting'}
    </button>
  );
};

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; seen = []; });
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  mocks.listing.data = [{ name: 'browser', url: '/b.js', cssUrl: '/b.css', apiVersion: 15, nav: [], settings: [] }];
  mocks.loadPluginUi.mockResolvedValue({ requiresApiVersion: 15, chatArtifacts: { preview: View } });
});

function Attach() {
  const { ensureAttached } = useBrainChat();
  useEffect(() => { ensureAttached(); }, [ensureAttached]);
  return null;
}

describe('an inline artifact and the question card it covers', () => {
  it('is told a prompt is waiting, can bring the real card back, and clears with the ask', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper><ToastProvider><BrainChatProvider>
        <Attach />
        <BrainChatSurface variant="full" />
      </BrainChatProvider></ToastProvider></Wrapper>,
    );
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    const stream = FakeES.instances[0]!;
    // The transcript is hydrated by the stream's snapshot frame, and the artifact hangs off the tool call
    // in it — the same anchoring production uses.
    stream.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', history: HISTORY, events: [], hasMore: false, nextBefore: null,
      artifacts: [artifact],
    });

    // Nothing parked: the artifact is told exactly that, rather than being left to guess.
    expect(await screen.findByTestId('artifact-alert')).toHaveTextContent('nothing waiting');
    expect(seen.at(-1)!.pendingInput).toBeNull();

    stream.emit('ask', {
      id: 'ask-1',
      questions: [{
        question: 'Which environment should I deploy to?',
        header: 'Deploy target',
        multiSelect: false,
        options: [{ label: 'staging' }, { label: 'production' }],
      }],
    });

    await waitFor(() => expect(screen.getByTestId('artifact-alert')).toHaveTextContent(en.brainChat.askWaiting));
    const pending = seen.at(-1)!.pendingInput!;
    // The host's own translated line and the way back — and not one word of the question, which stays
    // with the card that owns answering it.
    expect(Object.keys(pending).sort()).toEqual(['label', 'reveal']);
    expect(JSON.stringify(pending.label)).not.toContain('production');
    expect(pending.label).toBe(en.brainChat.askWaiting);

    // The real card is on screen behind the artifact, and `reveal` is what puts the reader in front of it.
    const card = screen.getByText('Which environment should I deploy to?').closest('[tabindex="-1"]');
    expect(card).not.toBeNull();
    (card as HTMLElement).scrollIntoView = vi.fn();
    act(() => { pending.reveal(); });
    expect((card as HTMLElement).scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(card);

    // Answered or withdrawn: the alert goes with the question.
    stream.emit('ask_resolved', { id: 'ask-1' });
    await waitFor(() => expect(screen.getByTestId('artifact-alert')).toHaveTextContent('nothing waiting'));
    expect(seen.at(-1)!.pendingInput).toBeNull();
  });
});
