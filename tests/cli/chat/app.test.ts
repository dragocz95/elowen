import { describe, it, expect } from 'vitest';
import { viewToPlainText } from '../../../src/cli/chat/app.js';
import { beginAssistant, pushUser, reduce, emptyView } from '../../../src/brain/transcript.js';

describe('viewToPlainText', () => {
  it('renders user and orca turns with labels, tools and text', () => {
    let v = beginAssistant(pushUser(emptyView(), 'ahoj'));
    v = reduce(v, { type: 'tool', name: 'orca_create_task' });
    v = reduce(v, { type: 'text', delta: 'hotovo' });
    const lines = viewToPlainText(v);
    expect(lines).toContain('you');
    expect(lines.some((l) => l.includes('ahoj'))).toBe(true);
    expect(lines.some((l) => l.includes('* orca_create_task'))).toBe(true);
    expect(lines.some((l) => l.includes('hotovo'))).toBe(true);
  });

  it('renders a reasoning segment prefixed and distinct from the answer', () => {
    let v = beginAssistant(pushUser(emptyView(), 'ahoj'));
    v = reduce(v, { type: 'reasoning', delta: 'let me think' });
    v = reduce(v, { type: 'text', delta: 'answer' });
    const lines = viewToPlainText(v);
    expect(lines.some((l) => l.includes('thought let me think'))).toBe(true);
    expect(lines.some((l) => l.includes('answer') && !l.includes('thought'))).toBe(true);
  });
});

describe('reduce — reasoning + notice', () => {
  it('accumulates reasoning into its own segment, separate from text', () => {
    let v = beginAssistant(pushUser(emptyView(), 'x'));
    v = reduce(v, { type: 'reasoning', delta: 'think ' });
    v = reduce(v, { type: 'reasoning', delta: 'more' });
    const turn = v.turns[v.turns.length - 1];
    expect(turn.role === 'orca' && turn.segments).toEqual([{ kind: 'reasoning', text: 'think more' }]);
  });

  it('shows a transient notice and clears it on done + on idle', () => {
    let v = beginAssistant(pushUser(emptyView(), 'x'));
    v = reduce(v, { type: 'notice', kind: 'retry', message: 'retrying — attempt 1/5…' });
    expect(v.notice).toBe('retrying — attempt 1/5…');
    v = reduce(v, { type: 'notice', kind: 'retry', message: 'retry succeeded', done: true });
    expect(v.notice).toBeUndefined();
    v = reduce(v, { type: 'notice', kind: 'compaction', message: 'compacting context…' });
    expect(v.notice).toBe('compacting context…');
    v = reduce(v, { type: 'idle' });
    expect(v.notice).toBeUndefined(); // settled turn drops the transient line
  });

  it('first answer text clears a pending notice', () => {
    let v = beginAssistant(pushUser(emptyView(), 'x'));
    v = reduce(v, { type: 'notice', kind: 'compaction', message: 'compacting context…' });
    v = reduce(v, { type: 'text', delta: 'done' });
    expect(v.notice).toBeUndefined();
  });
});

describe('parseCommand', () => {
  it('routes slash commands and passes the resume argument through', async () => {
    const { parseCommand } = await import('../../../src/cli/chat/commands.js');
    expect(parseCommand('/new')).toEqual({ cmd: 'new' });
    expect(parseCommand('/sessions')).toEqual({ cmd: 'sessions' });
    expect(parseCommand('/resume 2')).toEqual({ cmd: 'resume', arg: '2' });
    expect(parseCommand('/model')).toEqual({ cmd: 'model' });
    expect(parseCommand('/reasoning')).toEqual({ cmd: 'reasoning', arg: undefined });
    expect(parseCommand('/reasoning high')).toEqual({ cmd: 'reasoning', arg: 'high' });
    expect(parseCommand('/theme')).toEqual({ cmd: 'theme', arg: undefined });
    expect(parseCommand('/theme mono')).toEqual({ cmd: 'theme', arg: 'mono' });
    expect(parseCommand('/editor')).toEqual({ cmd: 'editor' });
    expect(parseCommand('/mcp')).toEqual({ cmd: 'mcp' });
    expect(parseCommand('/skills')).toEqual({ cmd: 'skills' });
    expect(parseCommand('/tools')).toEqual({ cmd: 'tools' });
    expect(parseCommand('/goal Fix tests')).toEqual({ cmd: 'goal', arg: 'Fix tests' });
    expect(parseCommand('/subgoal Run typecheck')).toEqual({ cmd: 'subgoal', arg: 'Run typecheck' });
    expect(parseCommand('/compact')).toEqual({ cmd: 'compact' });
    expect(parseCommand('/plan')).toEqual({ cmd: 'plan' });
    expect(parseCommand('/build')).toEqual({ cmd: 'build' });
    expect(parseCommand('/yolo')).toEqual({ cmd: 'yolo', arg: undefined });
    expect(parseCommand('/yolo off')).toEqual({ cmd: 'yolo', arg: 'off' });
    expect(parseCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/exit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseCommand('/unknown')).toBeNull();
    expect(parseCommand('běžná zpráva')).toBeNull();
  });
});

describe('isSlashCommandDraft', () => {
  it('is true while the input can still be a command name and false for ordinary text', async () => {
    const { isSlashCommandDraft } = await import('../../../src/cli/chat/commands.js');
    expect(isSlashCommandDraft('/')).toBe(true);
    expect(isSlashCommandDraft('/mo')).toBe(true);
    expect(isSlashCommandDraft('/model')).toBe(true);
    expect(isSlashCommandDraft('')).toBe(false); // leading '/' deleted → overlay closes
    expect(isSlashCommandDraft('/model high')).toBe(false); // arguments → the command name is committed
    expect(isSlashCommandDraft('/var/www/x')).toBe(false); // a path, not a command
    expect(isSlashCommandDraft('běžná zpráva')).toBe(false);
  });
});

describe('mode toggle key', () => {
  it('recognizes Shift+Tab and the Ctrl+Tab sequence some terminals emit', async () => {
    const { isModeToggleKey } = await import('../../../src/cli/chat/keys.js');
    expect(isModeToggleKey('\x1b[Z')).toBe(true);
    expect(isModeToggleKey('\x1b[9;5u')).toBe(true);
    expect(isModeToggleKey('\t')).toBe(false);
  });
});

describe('statusline', () => {
  it('renders only the toggled parts and hides entirely when the plugin is off', async () => {
    const { statusline } = await import('../../../src/cli/chat/shell.js');
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
