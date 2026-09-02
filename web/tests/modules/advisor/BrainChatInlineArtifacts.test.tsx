import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useEffect } from 'react';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import type { BrainInlineArtifact } from '../../../lib/types';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) }); });
  }
}

const baseArtifact: BrainInlineArtifact = {
  id: 'artifact-1',
  plugin: 'browser',
  sessionId: 'brain-1',
  toolCallId: 'tool-1',
  view: 'preview',
  fallback: 'Browser preview is unavailable.',
  data: { state: 'initial' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  status: 'open',
  createdAt: '2029-01-01T00:00:00.000Z',
  updatedAt: '2029-01-01T00:00:00.000Z',
};

let statusArtifacts: BrainInlineArtifact[] = [];
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true,
    sessionId: 'brain-1',
    model: 'm',
    provider: 'test',
    usage: null,
    statusline: null,
    cards: [],
    artifacts: statusArtifacts,
    queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; statusArtifacts = []; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function ArtifactProbe() {
  const { artifacts, ensureAttached } = useBrainChat();
  useEffect(() => { ensureAttached(); }, [ensureAttached]);
  return <output data-testid="artifacts">{JSON.stringify(artifacts)}</output>;
}

async function renderProbe(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><ArtifactProbe /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances).toHaveLength(1));
  return FakeES.instances[0]!;
}

describe('BrainChatProvider inline artifacts', () => {
  it('hydrates open artifacts from status without mixing them into BrainCards', async () => {
    statusArtifacts = [{ ...baseArtifact, data: { state: 'from-status' } }];
    await renderProbe();
    await waitFor(() => expect(screen.getByTestId('artifacts')).toHaveTextContent('from-status'));
  });

  it('folds snapshot-tail updates and live update/close events by plugin and artifact id', async () => {
    const stream = await renderProbe();
    stream.emit('snapshot', {
      type: 'snapshot',
      sessionId: 'brain-1',
      history: [],
      hasMore: false,
      nextBefore: null,
      artifacts: [baseArtifact],
      events: [{
        type: 'inline_artifact',
        artifact: { ...baseArtifact, data: { state: 'snapshot-update' }, updatedAt: '2029-01-01T00:01:00.000Z' },
      }],
    });
    await waitFor(() => expect(screen.getByTestId('artifacts')).toHaveTextContent('snapshot-update'));

    stream.emit('inline_artifact', {
      artifact: { ...baseArtifact, data: { state: 'live-update' }, updatedAt: '2029-01-01T00:02:00.000Z' },
    });
    await waitFor(() => expect(screen.getByTestId('artifacts')).toHaveTextContent('live-update'));

    stream.emit('inline_artifact', {
      artifact: {
        id: baseArtifact.id,
        plugin: baseArtifact.plugin,
        sessionId: baseArtifact.sessionId,
        toolCallId: baseArtifact.toolCallId,
        status: 'closed',
        reason: 'closed',
      },
    });
    await waitFor(() => expect(screen.getByTestId('artifacts')).toHaveTextContent('[]'));
  });
});
