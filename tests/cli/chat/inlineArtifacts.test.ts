import { beforeAll, describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import type { BrainEvent, BrainInlineArtifact, BrainInlineArtifactClosed } from '../../../src/brain/events.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { BrainClient } from '../../../src/cli/chat/brainClient.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { InlineArtifactCollection } from '../../../src/cli/chat/inlineArtifacts.js';
import { StreamCoordinator } from '../../../src/cli/chat/streamCoordinator.js';
import { SnapshotHydrator } from '../../../src/cli/chat/snapshotHydrator.js';
import { HydrationNoticeOwner } from '../../../src/cli/chat/hydrationNoticeOwner.js';
import type { Flows } from '../../../src/cli/chat/flows.js';
import type { ChatApplicationActions } from '../../../src/cli/chat/chatCapabilities.js';
import { TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import { ChatViewport } from '../../../src/cli/chat/chatViewport.js';
import type { ChatTurn } from '../../../src/brain/transcript.js';

beforeAll(() => { initTheme(); });

const openArtifact = (patch: Partial<BrainInlineArtifact> = {}): BrainInlineArtifact => ({
  id: 'preview',
  plugin: 'browser',
  sessionId: 'brain-1',
  toolCallId: 'call-browser',
  view: 'browser.preview',
  fallback: 'Opening page…',
  media: { transport: 'sse', path: '/plugins/browser/api/artifacts/preview/stream' },
  expiresAt: '2026-09-02T13:00:00.000Z',
  status: 'open',
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
  ...patch,
});

const closeArtifact = (): BrainInlineArtifactClosed => ({
  id: 'preview', plugin: 'browser', sessionId: 'brain-1', toolCallId: 'call-browser',
  status: 'closed', reason: 'closed',
});

const actions = (): ChatApplicationActions => ({
  render: () => {}, renderForced: () => {}, refreshRateLimits: async () => {},
  onTurnSettled: () => {}, onTurnActive: () => {}, refreshMeta: async () => {},
  invalidateAsyncState: () => {}, quit: () => {}, suspendTerminal: () => {}, resumeTerminal: () => {},
});

const toolTurn = (...ids: string[]): ChatTurn => ({
  role: 'elowen', streaming: false,
  segments: [{ kind: 'tools', items: ids.map((id, index) => ({ name: `Tool${index}`, id })) }],
});

describe('inline artifact state and hydration', () => {
  it('hydrates ChatState, replaces from a stream snapshot, updates, and closes by identity', () => {
    const seeded = openArtifact({ fallback: 'Seeded' });
    const rt = new ChatState({ transcript: new TranscriptModel(), artifacts: [seeded] });
    expect(rt.artifacts.all().map((artifact) => artifact.fallback)).toEqual(['Seeded']);

    let onFrame!: (frame: BrainEvent | { type: 'snapshot'; cursor: number; history: []; events: BrainEvent[]; artifacts?: BrainInlineArtifact[] }) => void;
    const client = {
      stream: (callback: typeof onFrame) => { onFrame = callback; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      processes: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    rt.streamAc = ac;
    const coordinator = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    coordinator.openStream(ac);

    onFrame({ type: 'snapshot', cursor: 1, history: [], events: [], artifacts: [openArtifact({ fallback: 'Hydrated' })] });
    expect(rt.artifacts.all().map((artifact) => artifact.fallback)).toEqual(['Hydrated']);

    onFrame({ type: 'inline_artifact', artifact: openArtifact({ fallback: 'Page loaded', updatedAt: '2026-09-02T12:00:01.000Z' }) });
    expect(rt.artifacts.all().map((artifact) => artifact.fallback)).toEqual(['Page loaded']);

    onFrame({ type: 'inline_artifact', artifact: closeArtifact() });
    expect(rt.artifacts.all()).toEqual([]);
    coordinator.stop();
  });

  it('reports only anchored tool ids across updates instead of invalidating all history', () => {
    const collection = new InlineArtifactCollection([openArtifact()]);
    const revision = collection.revision;
    collection.apply(openArtifact({ fallback: 'Updated' }));
    expect(collection.changesSince(revision)).toEqual({
      kind: 'tools', toolCallIds: ['call-browser'], revision: collection.revision,
    });
  });

  it('repaints one anchored old turn without walking its long settled suffix', () => {
    const history = [
      { role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, id: 'call-browser', name: 'Browser' }] },
      ...Array.from({ length: 1_999 }, (_, index) => ({ role: 'assistant' as const, text: `settled ${index}` })),
    ];
    const transcript = new TranscriptModel(history);
    const collection = new InlineArtifactCollection([openArtifact()]);
    const viewport = new ChatViewport({
      transcript, inlineArtifacts: collection,
      notice: '', modelName: '', thinkingSeconds: 0,
    }, getMarkdownTheme(), () => 18, () => 1, () => 80);
    viewport.render(80);
    viewport.scroll(1_000_000);
    viewport.render(80);
    expect(viewport.metrics().transcriptRowsExact).toBe(true);
    viewport.scroll(-1_000_000);
    viewport.render(80);

    collection.apply(openArtifact({ fallback: 'Updated old preview' }));
    viewport.render(80);
    expect(viewport.metrics().renderedTurns).toBeLessThanOrEqual(1);
    expect(viewport.metrics().layoutVisits).toBeLessThanOrEqual(1);
  });
});

describe('artifact transcript rows', () => {
  it('shows the changing artifact fallback under its tool call and drops the row when it closes', () => {
    const collection = new InlineArtifactCollection([openArtifact()]);
    const renderer = new TurnRenderer(getMarkdownTheme());
    const rows = (): string => renderer.render(toolTurn('call-browser'), 0, 80, {
      showThoughts: true,
      thinkingSeconds: 0,
      composingMarkerReady: false,
      spinnerFrame: 0,
      expandedThoughts: new Set(),
      expandedTools: new Set(),
      inlineArtifacts: collection,
    }).map((row) => row.line).join('\n');

    expect(rows()).toContain('Opening page');
    collection.apply(openArtifact({ fallback: 'Clicking Sign in…' }));
    expect(rows()).toContain('Clicking Sign in');
    collection.apply(closeArtifact());
    expect(rows()).not.toContain('Clicking Sign in');
  });

  it('falls back to the view name when the plugin sends an empty fallback', () => {
    const collection = new InlineArtifactCollection([openArtifact({ fallback: '   ' })]);
    const rows = new TurnRenderer(getMarkdownTheme()).render(toolTurn('call-browser'), 0, 80, {
      showThoughts: true,
      thinkingSeconds: 0,
      composingMarkerReady: false,
      spinnerFrame: 0,
      expandedThoughts: new Set(),
      expandedTools: new Set(),
      inlineArtifacts: collection,
    }).map((row) => row.line).join('\n');
    expect(rows).toContain('browser.preview');
  });

  it('places each artifact immediately after its anchored tool call', () => {
    const collection = new InlineArtifactCollection([
      openArtifact({ id: 'first', toolCallId: 'call-1', fallback: 'first artifact' }),
      openArtifact({ id: 'second', toolCallId: 'call-2', fallback: 'second artifact' }),
    ]);
    const rows = new TurnRenderer(getMarkdownTheme()).render(toolTurn('call-1', 'call-2'), 0, 80, {
      showThoughts: true,
      thinkingSeconds: 0,
      composingMarkerReady: false,
      spinnerFrame: 0,
      expandedThoughts: new Set(),
      expandedTools: new Set(),
      inlineArtifacts: collection,
    }).map((row) => row.line);
    const firstTool = rows.findIndex((row) => row.includes('Tool0'));
    const firstArtifact = rows.findIndex((row) => row.includes('first artifact'));
    const secondTool = rows.findIndex((row) => row.includes('Tool1'));
    const secondArtifact = rows.findIndex((row) => row.includes('second artifact'));
    expect(firstTool).toBeLessThan(firstArtifact);
    expect(firstArtifact).toBeLessThan(secondTool);
    expect(secondTool).toBeLessThan(secondArtifact);
  });

  it('never emits a terminal image protocol sequence for an artifact carrying live media', () => {
    const collection = new InlineArtifactCollection([openArtifact()]);
    const transcript = new TranscriptModel([
      { role: 'assistant', text: '', segments: [{ kind: 'tool' as const, id: 'call-browser', name: 'Browser' }] },
    ]);
    const viewport = new ChatViewport({
      transcript, inlineArtifacts: collection,
      notice: '', modelName: '', thinkingSeconds: 0,
    }, getMarkdownTheme(), () => 18, () => 1, () => 80);
    const lines = viewport.render(80).join('\n');
    expect(lines).toContain('Opening page');
    expect(lines).not.toContain('\x1b]1337;File=');
    expect(lines).not.toContain('\x1b_G');
  });
});
