import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compactNotice, resolveThinkingLevel, wireSubmit } from '../../../src/cli/chat/commands.js';
import { emptyView } from '../../../src/brain/transcript.js';

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
      const childView = { sessionId: 'brain-ch-subagent-child', view: emptyView(), loading: false };
      const render = vi.fn();
      const rt = {
        client: { subagentSend }, editor, childView, notice: '', render,
        shellContext: {}, attachmentChips: {},
      };
      wireSubmit(rt as never, { stream: {}, pickers: {} } as never);
      const before = childView.view;
      onSubmit?.('guide the child');
      await Promise.resolve();

      expect(subagentSend).toHaveBeenCalledWith('brain-ch-subagent-child', 'guide the child');
      expect(childView.view).toBe(before);
      expect(childView.view.turns).toEqual([]);
      expect(render).toHaveBeenCalledOnce(); // only flushes the cleared editor
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
