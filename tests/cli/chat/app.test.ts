import { describe, it, expect } from 'vitest';
import { viewToPlainText } from '../../../src/cli/chat/app.js';
import { beginAssistant, pushUser, reduce, emptyView } from '../../../src/cli/chat/render.js';

describe('viewToPlainText', () => {
  it('renders user and orca turns with labels, tools and text', () => {
    let v = beginAssistant(pushUser(emptyView(), 'ahoj'));
    v = reduce(v, { type: 'tool', name: 'orca_create_task' });
    v = reduce(v, { type: 'text', delta: 'hotovo' });
    const lines = viewToPlainText(v);
    expect(lines).toContain('you');
    expect(lines.some((l) => l.includes('ahoj'))).toBe(true);
    expect(lines.some((l) => l.includes('⏺ orca_create_task'))).toBe(true);
    expect(lines.some((l) => l.includes('hotovo'))).toBe(true);
  });
});

describe('parseCommand', () => {
  it('routes slash commands and passes the resume argument through', async () => {
    const { parseCommand } = await import('../../../src/cli/chat/app.js');
    expect(parseCommand('/new')).toEqual({ cmd: 'new' });
    expect(parseCommand('/sessions')).toEqual({ cmd: 'sessions' });
    expect(parseCommand('/resume 2')).toEqual({ cmd: 'resume', arg: '2' });
    expect(parseCommand('/model')).toEqual({ cmd: 'model' });
    expect(parseCommand('/compact')).toEqual({ cmd: 'compact' });
    expect(parseCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/exit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseCommand('/unknown')).toBeNull();
    expect(parseCommand('běžná zpráva')).toBeNull();
  });
});

describe('statusline', () => {
  it('renders only the toggled parts and hides entirely when the plugin is off', async () => {
    const { statusline } = await import('../../../src/cli/chat/app.js');
    const usage = { tokens: 34_500, contextWindow: 200_000, percent: 17.25, totalTokens: 1_234_567, cost: 0.4218 };
    expect(statusline(null, usage, 'opus')).toBe('');
    expect(statusline({}, usage, 'opus')).toBe('');
    expect(statusline({ showModel: true }, usage, 'opus')).toBe('opus');
    expect(statusline({ showContext: true, showTokens: true, showCost: true }, usage, 'opus'))
      .toBe('context 17% (35k/200k)  ·  Σ 1.2M tok  ·  $0.42');
    // unknown context tokens (right after compaction) → context part omitted
    expect(statusline({ showContext: true }, { ...usage, tokens: null, percent: null }, 'opus')).toBe('');
  });
});
