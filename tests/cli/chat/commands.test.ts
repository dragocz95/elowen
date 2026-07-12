import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compactNotice, resolveThinkingLevel, wireSubmit } from '../../../src/cli/chat/commands.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';
import { LocalShellBuffer } from '../../../src/cli/chat/localShell.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe('resolveThinkingLevel', () => {
  it('accepts canonical ids and provider-facing labels without leaking the label to PI', () => {
    const levels = ['low', 'high', 'xhigh', 'max'];
    const labels = { xhigh: 'ultra', max: 'max' };
    expect(resolveThinkingLevel('high', levels, labels)).toBe('high');
    expect(resolveThinkingLevel('Ultra', levels, labels)).toBe('xhigh');
    expect(resolveThinkingLevel('max', levels, labels)).toBe('max');
    expect(resolveThinkingLevel('minimal', levels, labels)).toBeNull();
  });
});

describe('compactNotice', () => {
  it('a real compaction shows no local notice — the daemon stream owns the status', () => {
    expect(compactNotice({ compacted: true })).toBeNull();
    expect(compactNotice({ compacted: true, message: 'ignored' })).toBeNull();
  });

  it('a benign no-op surfaces the server message (it emits no stream event to announce itself)', () => {
    expect(compactNotice({ compacted: false, message: 'Nothing to compact yet.' })).toBe('Nothing to compact yet.');
  });

  it('a no-op with no server message falls back to a default so the command never looks silent', () => {
    expect(compactNotice({ compacted: false })).toBe('Nothing to compact yet.');
  });
});

describe('sub-agent child submit echo', () => {
  it('does not append a local user turn; the child daemon stream is the sole echo authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-child-submit-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const subagentSend = vi.fn(async () => {});
      const childTranscript = new TranscriptModel();
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      state.childView = { sessionId: 'brain-ch-subagent-child', transcript: childTranscript, loading: false };
      wireSubmit(
        state,
        {
          client: { subagentSend }, editor, shellContext: {}, attachmentChips: {}, commandDefs: [], tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );
      const before = childTranscript.revision;
      onSubmit?.('guide the child');
      await Promise.resolve();

      expect(subagentSend).toHaveBeenCalledWith('brain-ch-subagent-child', 'guide the child');
      expect(childTranscript.revision).toBe(before);
      expect(childTranscript.turnCount).toBe(0);
      expect(render).toHaveBeenCalledOnce(); // only flushes the cleared editor
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('application lifetime for local input work', () => {
  it('kills publication from an unfinished !cmd after the chat stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-local-lifetime-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<{ command: string; output: string; exitCode: number; truncated: boolean }>();
      const runLocal = vi.fn((_command: string, _cwd: string, _signal: AbortSignal) => pending.promise);
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const transcript = new TranscriptModel();
      const shellContext = new LocalShellBuffer();
      const render = vi.fn();
      const state = new ChatState({ transcript });
      wireSubmit(
        state,
        { client: {}, editor, shellContext, attachmentChips: {}, commandDefs: [], tui: {}, lifetime } as never,
        { render } as never,
        { stream: {}, pickers: {}, runLocalShell: runLocal } as never,
      );

      onSubmit?.('!printf pending');
      expect(runLocal).toHaveBeenCalledWith('printf pending', process.cwd(), lifetime.signal);
      const revision = transcript.revision;
      lifetime.stop();
      pending.resolve({ command: 'printf pending', output: 'late', exitCode: 0, truncated: false });
      await Promise.resolve();
      await Promise.resolve();

      expect(transcript.revision).toBe(revision);
      expect(shellContext.pending).toBe(false);
      expect(render).toHaveBeenCalledOnce();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not attach a clipboard result that arrives after the chat stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-clipboard-lifetime-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<{ image?: { name: string; data: string; mimeType: string; bytes: number }; error?: string }>();
      const readClipboard = vi.fn((_signal: AbortSignal) => pending.promise);
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: {}, editor, shellContext: new LocalShellBuffer(),
          attachmentChips: { set: vi.fn() }, commandDefs: [], tui: {}, lifetime,
        } as never,
        { render } as never,
        { stream: {}, pickers: {}, readClipboardImage: readClipboard } as never,
      );

      onSubmit?.('/paste');
      expect(readClipboard).toHaveBeenCalledWith(lifetime.signal);
      lifetime.stop();
      pending.resolve({ image: { name: 'late.png', data: 'iVBORw0KGgo=', mimeType: 'image/png', bytes: 8 } });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.pendingImages).toEqual([]);
      expect(render).toHaveBeenCalledOnce();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
