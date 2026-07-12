import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { createPickers } from '../../../src/cli/chat/pickers.js';
import { setChatTheme } from '../../../src/cli/chat/theme.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

let testHome: string | null = null;

afterEach(() => {
  setChatTheme('elowen');
  vi.unstubAllEnvs();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = null;
});

describe('picker theme application', () => {
  it.each([
    { name: 'mono', termSettings: null },
    {
      name: 'custom',
      termSettings: {
        theme: 'custom',
        palette: { foreground: '#eeeeee', background: '#111111', cyan: '#22ccbb' },
      },
    },
  ])('reopens the panel through reshowPanel after applying $name without owning visibility', ({ name, termSettings }) => {
    testHome = mkdtempSync(join(tmpdir(), 'elowen-pickers-'));
    vi.stubEnv('HOME', testHome);
    const render = vi.fn();
    const editor = { borderColor: (text: string) => text };
    const state = new ChatState({ transcript: new TranscriptModel() });
    const resources = {
      client: {}, tui: {}, editor, termSettings, cwdLabel: '', branchLabel: '', commandDefs: [],
    };
    const reshowPanel = vi.fn();
    const pickers = createPickers(
      state,
      resources as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel, reloadKeymap: vi.fn() },
    );

    expect(pickers.applyTheme(name)).toBe(true);
    expect(reshowPanel).toHaveBeenCalledOnce();
    expect(reshowPanel).toHaveBeenCalledWith();
    expect(render).toHaveBeenCalledOnce();
  });
});

describe('picker application lifetime', () => {
  it.each([
    { outcome: 'success', expectedRestarts: 1 },
    { outcome: 'failure', expectedRestarts: 0 },
  ])('restarts the parent stream only after a $outcome model switch', async ({ outcome, expectedRestarts }) => {
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const restartStream = vi.fn();
    let modal: { handleInput(data: string): void } | null = null;
    const overlayHandle = {
      hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false,
      focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true,
    };
    const tui = {
      terminal: { columns: 80, rows: 24 },
      showOverlay: vi.fn((component: { handleInput(data: string): void }) => {
        modal = component;
        return overlayHandle;
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const setModel = vi.fn(async () => {
      if (outcome === 'failure') throw new Error('model switch failed');
      return { model: 'next-model' };
    });
    const state = new ChatState({ transcript: new TranscriptModel(), modelName: 'old-model' });
    const pickers = createPickers(
      state,
      {
        client: {
          models: async () => [{ provider: 'mock', providerLabel: 'Mock', model: 'next-model' }],
          setModel,
        },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      { restartStream } as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openModelPicker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modal).not.toBeNull();
    (modal as unknown as { handleInput(data: string): void }).handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setModel).toHaveBeenCalledWith({ provider: 'mock', model: 'next-model' });
    expect(restartStream).toHaveBeenCalledTimes(expectedRestarts);
    await lifetime.stop();
  });

  it('does not publish a model response after the chat has stopped', async () => {
    const models = deferred<never[]>();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const render = vi.fn();
    const state = new ChatState({ transcript: new TranscriptModel(), notice: 'before-stop' });
    const pickers = createPickers(
      state,
      {
        client: { models: () => models.promise }, tui: {}, editor: {}, termSettings: null,
        cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openModelPicker();
    lifetime.stop();
    models.resolve([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.notice).toBe('before-stop');
    expect(render).not.toHaveBeenCalled();
  });

  it('does not open /status or publish an abort error after stop', async () => {
    const status = deferred<never>();
    const goal = deferred<never>();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const render = vi.fn();
    const tui = { showOverlay: vi.fn(), setFocus: vi.fn() };
    const state = new ChatState({ transcript: new TranscriptModel(), notice: 'stable' });
    const pickers = createPickers(
      state,
      {
        client: { status: () => status.promise, goal: () => goal.promise }, tui, editor: {}, termSettings: null,
        cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openStatusModal();
    lifetime.stop();
    status.reject(new Error('late status abort'));
    goal.resolve(null as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.notice).toBe('stable');
    expect(tui.showOverlay).not.toHaveBeenCalled();
    expect(tui.setFocus).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
