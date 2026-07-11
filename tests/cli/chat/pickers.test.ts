import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { createPickers } from '../../../src/cli/chat/pickers.js';
import { setChatTheme } from '../../../src/cli/chat/theme.js';

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
