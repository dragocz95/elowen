import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { resetCapabilitiesCache, setCapabilities, TuiMainScreen } from '@earendil-works/pi-tui';
import type { BrainEvent, BrainInlineArtifact, BrainInlineArtifactClosed } from '../../../src/brain/events.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { BrainClient } from '../../../src/cli/chat/brainClient.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import {
  ArtifactThumbnail,
  InlineArtifactCollection,
  InlineArtifactFrameController,
  InlineArtifactPresenter,
  type InlineArtifactFrame,
} from '../../../src/cli/chat/inlineArtifacts.js';
import { StreamCoordinator } from '../../../src/cli/chat/streamCoordinator.js';
import { SnapshotHydrator } from '../../../src/cli/chat/snapshotHydrator.js';
import { HydrationNoticeOwner } from '../../../src/cli/chat/hydrationNoticeOwner.js';
import type { Flows } from '../../../src/cli/chat/flows.js';
import type { ChatApplicationActions } from '../../../src/cli/chat/chatCapabilities.js';
import { TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import { ChatViewport } from '../../../src/cli/chat/chatViewport.js';
import { resolveCliTerminalCapabilities } from '../../../src/cli/chat/terminalCapabilities.js';
import type { ChatTurn } from '../../../src/brain/transcript.js';

beforeAll(() => { initTheme(); });
afterEach(() => {
  vi.useRealTimers();
  resetCapabilitiesCache();
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nxoAAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z';
const LARGE_PNG = (() => {
  const data = Buffer.from(PNG, 'base64');
  data.writeUInt32BE(800, 16);
  data.writeUInt32BE(600, 20);
  return data.toString('base64');
})();
const isImageLine = (line: string): boolean => line.includes('\x1b_G') || line.includes('\x1b]1337;File=');

function renderMainScreen(component: { render: (width: number) => string[]; invalidate: () => void }): string {
  let output = '';
  const terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: (data: string) => { output += data; },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  } as unknown as ConstructorParameters<typeof TuiMainScreen>[0];
  const tui = new TuiMainScreen(terminal);
  tui.addChild(component);
  tui.renderNow();
  return output;
}

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
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const history = [
      { role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, id: 'call-browser', name: 'Browser' }] },
      ...Array.from({ length: 1_999 }, (_, index) => ({ role: 'assistant' as const, text: `settled ${index}` })),
    ];
    const transcript = new TranscriptModel(history);
    const collection = new InlineArtifactCollection([openArtifact()]);
    const viewport = new ChatViewport({
      transcript, inlineArtifacts: collection,
      renderInlineArtifacts: (toolCallId) => collection.forToolCall(toolCallId).map((artifact) => artifact.fallback),
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

describe('artifact media stream and latest-frame controller', () => {
  it('uses the bearer token, accepts only frame JPEG/PNG events, and reconnects after backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      attempts++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (attempts === 1) {
            controller.enqueue(new TextEncoder().encode(
              'event: status\ndata: {"fallback":"loading"}\n\n'
              + `event: frame\ndata: {"data":"${PNG}","mimeType":"image/png"}\n\n`,
            ));
          }
          controller.close();
        },
      });
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new BrainClient({ base: 'http://daemon', token: 'secret', fetchImpl });
    const ac = new AbortController();
    const frames: InlineArtifactFrame[] = [];
    const streaming = client.streamArtifactMedia('/plugins/browser/api/live', (frame) => frames.push(frame), ac.signal, 1_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([{ data: PNG, mimeType: 'image/png' }]);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    ac.abort();
    await streaming;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a one-frame queue, publishes at most 2 FPS, and aborts/clears on stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let emit!: (frame: InlineArtifactFrame) => void;
    let signal!: AbortSignal;
    const stream = vi.fn((_path: string, onFrame: (frame: InlineArtifactFrame) => void, streamSignal: AbortSignal) => {
      emit = onFrame;
      signal = streamSignal;
      return new Promise<void>((resolve) => streamSignal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const published: InlineArtifactFrame[] = [];
    const controller = new InlineArtifactFrameController('/live', stream, (frame) => published.push(frame));
    const first = { data: PNG, mimeType: 'image/png' as const };
    const second = { data: JPEG, mimeType: 'image/jpeg' as const };
    const latest = { data: `${PNG}latest`, mimeType: 'image/png' as const };

    emit(first);
    emit(second);
    emit(latest);
    expect(published).toEqual([first]);
    await vi.advanceTimersByTimeAsync(499);
    expect(published).toEqual([first]);
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toEqual([first, latest]);

    emit(second);
    controller.stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(published).toEqual([first, latest]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('artifact terminal rendering', () => {
  it('reuses the Kitty image id across new Image instances, but never assigns one for iTerm2', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const thumbnail = new ArtifactThumbnail();
    const bounds = { maxWidthCells: 30, maxHeightCells: 8 };
    thumbnail.update({ data: PNG, mimeType: 'image/png' }, 'kitty', bounds);
    thumbnail.render(40, 'kitty', bounds);
    const kittyId = thumbnail.getImageId();
    expect(kittyId).toBeTypeOf('number');

    thumbnail.update({ data: JPEG, mimeType: 'image/jpeg' }, 'kitty', bounds);
    thumbnail.render(40, 'kitty', bounds);
    expect(thumbnail.getImageId()).toBe(kittyId);

    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true });
    thumbnail.update({ data: PNG, mimeType: 'image/png' }, 'iterm2', bounds);
    thumbnail.render(40, 'iterm2', bounds);
    expect(thumbnail.getImageId()).toBeUndefined();
  });

  it('renders VS Code iTerm image rows plus fallback through the main-screen renderer, while off stays text-only', () => {
    const detected = { images: null, trueColor: true, hyperlinks: true } as const;
    setCapabilities(resolveCliTerminalCapabilities(detected, {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
      COLORTERM: 'truecolor',
      ELOWEN_CLI_IMAGES: 'auto',
    }));
    let emit!: (frame: InlineArtifactFrame) => void;
    const stream = vi.fn((_path: string, onFrame: (frame: InlineArtifactFrame) => void, signal: AbortSignal) => {
      emit = onFrame;
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const presenter = new InlineArtifactPresenter({
      collection: new InlineArtifactCollection([openArtifact()]),
      stream,
      maxHeightCells: () => 8,
      onInvalidate: () => {},
    });
    emit({ data: LARGE_PNG, mimeType: 'image/png' });
    const imageOutput = renderMainScreen({
      render: (width) => presenter.render('call-browser', width),
      invalidate: () => {},
    });
    expect(imageOutput).toContain('Opening page');
    expect(imageOutput).toContain('\x1b]1337;File=');
    expect(imageOutput).toMatch(/\x1b\[\d+A\x1b]1337;File=/);
    presenter.stop();

    setCapabilities(resolveCliTerminalCapabilities(detected, {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
      ELOWEN_CLI_IMAGES: 'off',
    }));
    const disabledStream = vi.fn(async () => {});
    const disabled = new InlineArtifactPresenter({
      collection: new InlineArtifactCollection([openArtifact()]),
      stream: disabledStream,
      maxHeightCells: () => 8,
      onInvalidate: () => {},
    });
    const fallbackOutput = renderMainScreen({
      render: (width) => disabled.render('call-browser', width),
      invalidate: () => {},
    });
    expect(fallbackOutput).toContain('Opening page');
    expect(fallbackOutput).not.toContain('\x1b]1337;File=');
    expect(disabledStream).not.toHaveBeenCalled();
    disabled.stop();
  });

  it('shows the changing artifact fallback and does not open media SSE without an image protocol', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const collection = new InlineArtifactCollection([openArtifact()]);
    const stream = vi.fn(async () => {});
    const presenter = new InlineArtifactPresenter({
      collection, stream, maxHeightCells: () => 8, onInvalidate: () => {},
    });
    expect(presenter.render('call-browser', 60).join('\n')).toContain('Opening page');
    expect(stream).not.toHaveBeenCalled();

    collection.apply(openArtifact({ fallback: 'Clicking Sign in…' }));
    expect(presenter.render('call-browser', 60).join('\n')).toContain('Clicking Sign in');
    collection.apply(closeArtifact());
    expect(presenter.render('call-browser', 60)).toEqual([]);
    presenter.stop();
  });

  it('requests an iTerm2 full redraw and leaves image protocol rows untouched by viewport chrome', () => {
    let emit!: (frame: InlineArtifactFrame) => void;
    const stream = vi.fn((_path: string, onFrame: (frame: InlineArtifactFrame) => void, signal: AbortSignal) => {
      emit = onFrame;
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const collection = new InlineArtifactCollection([openArtifact()]);
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true });
    const invalidate = vi.fn();
    const iterm = new InlineArtifactPresenter({
      collection, stream, maxHeightCells: () => 8,
      onInvalidate: (toolCallId, fullRedraw) => invalidate(toolCallId, fullRedraw),
    });
    emit({ data: PNG, mimeType: 'image/png' });
    expect(invalidate).toHaveBeenLastCalledWith('call-browser', true);
    iterm.stop();

    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    let kittyEmit!: (frame: InlineArtifactFrame) => void;
    const kittyStream = vi.fn((_path: string, onFrame: (frame: InlineArtifactFrame) => void, signal: AbortSignal) => {
      kittyEmit = onFrame;
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const transcript = new TranscriptModel([
      { role: 'assistant', text: '', segments: [{ kind: 'tool' as const, id: 'call-browser', name: 'Browser' }] },
    ]);
    let viewport!: ChatViewport;
    const kitty = new InlineArtifactPresenter({
      collection, stream: kittyStream, maxHeightCells: () => 8,
      onInvalidate: (toolCallId) => viewport?.invalidateToolCall(toolCallId),
    });
    viewport = new ChatViewport({
      transcript, inlineArtifacts: collection,
      renderInlineArtifacts: (toolCallId, width) => kitty.render(toolCallId, width),
      notice: '', modelName: '', thinkingSeconds: 0,
    }, getMarkdownTheme(), () => 18, () => 1, () => 80);
    viewport.render(80);
    kittyEmit({ data: PNG, mimeType: 'image/png' });
    const imageLine = viewport.render(80).find((line) => isImageLine(line));
    expect(imageLine).toBeDefined();
    expect(imageLine).not.toMatch(/│$/);
    kitty.stop();
  });

  it('places each artifact immediately after its anchored tool call', () => {
    const turn: ChatTurn = {
      role: 'elowen', streaming: false,
      segments: [{ kind: 'tools', items: [
        { name: 'FirstTool', id: 'call-1' },
        { name: 'SecondTool', id: 'call-2' },
      ] }],
    };
    const rows = new TurnRenderer(getMarkdownTheme()).render(turn, 0, 80, {
      showThoughts: true,
      thinkingSeconds: 0,
      composingMarkerReady: false,
      spinnerFrame: 0,
      expandedThoughts: new Set(),
      expandedTools: new Set(),
      renderInlineArtifacts: (toolCallId) => [`artifact:${toolCallId}`],
    }).map((row) => row.line);
    const firstTool = rows.findIndex((row) => row.includes('FirstTool'));
    const firstArtifact = rows.indexOf('artifact:call-1');
    const secondTool = rows.findIndex((row) => row.includes('SecondTool'));
    const secondArtifact = rows.indexOf('artifact:call-2');
    expect(firstTool).toBeLessThan(firstArtifact);
    expect(firstArtifact).toBeLessThan(secondTool);
    expect(secondTool).toBeLessThan(secondArtifact);
  });
});
