import { describe, expect, it } from 'vitest';
import { groupToolItems, turnsFromHistory, upsertCard } from '../../src/brain/transcript.js';
import type { ChatTurn, ToolItem } from '../../src/brain/transcript.js';
import { TranscriptModel } from '../../src/brain/transcriptModel.js';

const modelTurns = (model: TranscriptModel): ChatTurn[] => Array.from(
  { length: model.turnCount },
  (_, index) => model.turnAt(index)!,
);

const lastTool = (model: TranscriptModel): ToolItem => {
  const turn = model.turnAt(model.turnCount - 1);
  if (turn?.role !== 'elowen') throw new Error('expected elowen turn');
  const segment = turn.segments.find((candidate) => candidate.kind === 'tools');
  if (segment?.kind !== 'tools') throw new Error('expected tools segment');
  return segment.items[0]!;
};

const delegateTranscript = (): TranscriptModel => {
  const model = new TranscriptModel();
  model.apply({ type: 'user', text: 'do it' });
  model.apply({ type: 'tool', name: 'delegate', detail: 'research the config', id: 'call-1' });
  return model;
};

describe('groupToolItems: collapse consecutive same-tool rows', () => {
  it('folds a run of the same bare tool into one group carrying the LATEST detail and a count', () => {
    const items: ToolItem[] = [
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'b.ts' },
    ];
    const groups = groupToolItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.item.detail).toBe('b.ts');
  });

  it('does NOT merge across a different tool (grouping is strictly consecutive + same name)', () => {
    const groups = groupToolItems([
      { name: 'read_file', detail: 'a.ts' },
      { name: 'list_dir', detail: 'src' },
      { name: 'read_file', detail: 'b.ts' },
    ]);
    expect(groups.map((group) => [group.item.name, group.count])).toEqual([
      ['read_file', 1], ['list_dir', 1], ['read_file', 1],
    ]);
  });

  it('keeps an item carrying a diff / output / sub / command as its own group', () => {
    const groups = groupToolItems([
      { name: 'read_file', detail: 'a.ts' },
      { name: 'read_file', detail: 'b.ts', output: { title: 't', kind: 'result', text: 'x' } },
      { name: 'read_file', detail: 'c.ts' },
      { name: 'run_command', command: 'ls' },
      { name: 'run_command', command: 'pwd' },
      { name: 'edit_file', detail: 'd.ts', diff: '+ 1 x' },
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(groups.map((group) => group.item.name)).toEqual([
      'read_file', 'read_file', 'read_file', 'run_command', 'run_command', 'edit_file',
    ]);
  });
});

// One refusal repeated across four files is ONE thing that went wrong, and it was being told four times in
// four framed blocks — pushing the actual work off the screen. Folding it is what lets the transcript say
// it once, with each file still recoverable behind the count.
describe('groupToolItems: a repeated failure is one failure', () => {
  const refusal = (path: string): ToolItem => ({
    name: 'write_file', detail: path,
    output: { title: 'tool result', kind: 'result', tone: 'warning', status: 'needs attention',
      text: `Error: ${path} has not been read in this conversation. Read it first.` },
  });

  it('folds refusals that differ only by the file they name, keeping every one of them', () => {
    const groups = groupToolItems([refusal('/docs/routes.md'), refusal('/docs/pricing.md'), refusal('/docs/testing.md')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.members?.map((m) => m.detail)).toEqual(['/docs/routes.md', '/docs/pricing.md', '/docs/testing.md']);
  });

  it('keeps genuinely different failures apart — they are different things to fix', () => {
    const denied: ToolItem = { name: 'write_file', detail: '/docs/a.md',
      output: { title: 'tool result', kind: 'result', tone: 'danger', text: 'Error: permission denied' } };
    const groups = groupToolItems([refusal('/docs/routes.md'), denied, refusal('/docs/pricing.md')]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1]);
  });

  it('never folds a successful result — its output is content, not a repeated complaint', () => {
    const ok = (path: string): ToolItem => ({ name: 'read_file', detail: path,
      output: { title: 'tool result', kind: 'result', tone: 'success', text: 'ok' } });
    expect(groupToolItems([ok('a.ts'), ok('b.ts')]).map((g) => g.count)).toEqual([1, 1]);
  });

  // A failing command's output is the thing you actually want to read — the stack trace, the failing test.
  // Folding those away would hide the one output worth showing.
  it('never folds a failed console command', () => {
    const failed = (command: string): ToolItem => ({ name: 'run_command', command,
      output: { title: 'console', kind: 'console', tone: 'danger', status: 'exit 1', text: 'boom' } });
    expect(groupToolItems([failed('npm test'), failed('npm test')]).map((g) => g.count)).toEqual([1, 1]);
  });
});

describe('durable transcript parsing', () => {
  it('renders a compaction row as a divider turn, keeping the tail that follows', () => {
    const turns = turnsFromHistory([
      { role: 'compaction', text: '' },
      { role: 'user', text: 'recent q' },
      { role: 'assistant', text: 'recent a' },
    ]);
    expect(turns[0]).toEqual({ role: 'divider' });
    expect(turns[1]).toEqual({ role: 'you', text: 'recent q' });
    expect(turns[2]).toMatchObject({ role: 'elowen', streaming: false });
  });

  it('rehydrates a durable running child with its drill-in session id', () => {
    const model = new TranscriptModel([{ role: 'assistant', text: '', segments: [{
      kind: 'tool', id: 'call-1', name: 'delegate', detail: 'inspect',
      sub: { sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect', tools: 1, seconds: 3 },
    }] }]);
    const turn = model.turnAt(0);
    if (!turn || turn.role !== 'elowen' || turn.segments[0]?.kind !== 'tools') throw new Error('expected delegate row');
    expect(turn.segments[0].items[0]).toMatchObject({
      id: 'call-1', sub: { sessionId: 'brain-ch-subagent-child', status: 'running' },
    });
    expect(model.thinking).toBe(false);
  });
});

describe('transcript card projection', () => {
  it('appends, replaces and removes cards by stable id', () => {
    const first = { id: 'todos', title: 'Todos', items: [{ text: 'one', status: 'pending' as const }] };
    const updated = { id: 'todos', title: 'Todos', items: [{ text: 'one', status: 'completed' as const }] };
    expect(upsertCard([], first)).toEqual([first]);
    expect(upsertCard([first], updated)).toEqual([updated]);
    expect(upsertCard([updated], { id: 'todos' })).toEqual([]);
  });
});

describe('TranscriptModel event fold', () => {
  it('resets the transcript to the fresh conversation, then rebuilds from the daemon stream', () => {
    const model = new TranscriptModel([
      { role: 'user', text: 'yesterday' },
      { role: 'assistant', text: 'old answer' },
    ]);
    model.apply({ type: 'session', sessionId: 'brain-1-x' });
    expect(model.turnCount).toBe(0);
    model.apply({ type: 'user', text: 'today' });
    model.apply({ type: 'text', delta: 'fresh answer' });
    expect(modelTurns(model)).toEqual([
      { role: 'you', text: 'today' },
      { role: 'elowen', segments: [{ kind: 'text', text: 'fresh answer' }], streaming: true },
    ]);
  });

  it('resets to empty regardless of prior content, including an already empty transcript', () => {
    const populated = new TranscriptModel([{ role: 'assistant', text: 'x' }]);
    populated.apply({ type: 'session', sessionId: 's' });
    expect(populated.turnCount).toBe(0);
    const empty = new TranscriptModel();
    empty.apply({ type: 'session', sessionId: 's' });
    expect(empty.turnCount).toBe(0);
  });

  it('appends a queued user turn and opens a separate assistant reply', () => {
    const model = new TranscriptModel([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply to first' },
    ]);
    model.apply({ type: 'user', text: 'second\n\nthird' });
    expect(model.turnAt(model.turnCount - 1)).toEqual({ role: 'you', text: 'second\n\nthird' });
    model.apply({ type: 'text', delta: 'combined answer' });
    expect(model.turnAt(model.turnCount - 1)).toEqual({
      role: 'elowen', segments: [{ kind: 'text', text: 'combined answer' }], streaming: true,
    });
  });

  it('attaches both a diff and its notes-only output to the matching tool', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'user', text: 'edit it' });
    model.apply({ type: 'tool', name: 'edit_file', detail: 'a.ts', id: 'c1' });
    const output = {
      title: 'tool result', kind: 'result' as const, text: '', tone: 'normal' as const,
      notes: ['formatted a.ts with prettier'],
    };
    model.apply({ type: 'diff', diff: '+    1 x', id: 'c1', output });
    expect(lastTool(model)).toMatchObject({ diff: '+    1 x', output });
  });

  it('replaces live command progress and supersedes it with final output', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'user', text: 'run tests' });
    model.apply({ type: 'tool', name: 'run_command', command: 'npm test', id: 'r1' });
    model.apply({ type: 'tool_progress', id: 'r1', text: 'PASS a.test' });
    expect(lastTool(model)).toMatchObject({ command: 'npm test', progress: 'PASS a.test' });
    model.apply({ type: 'tool_progress', id: 'r1', text: 'PASS a.test\nPASS b.test' });
    expect(lastTool(model).progress).toBe('PASS a.test\nPASS b.test');
    model.apply({
      type: 'tool_output', id: 'r1',
      output: { title: 'tool result', kind: 'console', text: '$ npm test\nPASS a.test\nPASS b.test\n[exit 0]' },
    });
    expect(lastTool(model).progress).toBeUndefined();
    expect(lastTool(model).output).toMatchObject({ kind: 'console', command: 'npm test' });
  });

  it('keeps progress-bearing commands as separate render groups', () => {
    const groups = groupToolItems([
      { name: 'run_command', id: 'r1', progress: 'building…' },
      { name: 'run_command', id: 'r2', progress: 'linking…' },
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 1]);
  });
});

describe('TranscriptModel subagent progress', () => {
  it('attaches progress to the matching delegate call and replaces it when done', () => {
    const model = delegateTranscript();
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 'brain-ch-subagent-sub-x', status: 'running',
      task: 'research the config', detail: 'read_file src/a.ts', tools: 2, tokens: 1500, seconds: 7,
    });
    expect(lastTool(model).sub).toMatchObject({
      sessionId: 'brain-ch-subagent-sub-x', status: 'running', detail: 'read_file src/a.ts',
      tools: 2, tokens: 1500, seconds: 7,
    });
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 'brain-ch-subagent-sub-x', status: 'done',
      task: 'research the config', tools: 5, tokens: 9000, seconds: 31,
    });
    expect(lastTool(model).sub).toMatchObject({ status: 'done', tools: 5, tokens: 9000, seconds: 31 });
  });

  it('patches the settled original row without creating a turn or spinner', () => {
    const model = delegateTranscript();
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'running', task: 't', tools: 1, seconds: 2,
    });
    model.apply({ type: 'idle' });
    const turnsBefore = model.turnCount;
    expect(model.thinking).toBe(false);
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'done', task: 't', tools: 5, seconds: 31,
    });
    expect(model.turnCount).toBe(turnsBefore);
    expect(model.thinking).toBe(false);
    expect(lastTool(model).sub?.status).toBe('done');
  });

  it('treats an unknown call id as a true no-op', () => {
    const model = delegateTranscript();
    model.apply({ type: 'idle' });
    const revision = model.revision;
    const turn = model.turnAt(1);
    expect(model.apply({
      type: 'subagent', id: 'other', sessionId: 's', status: 'running', task: 't', tools: 0, seconds: 0,
    })).toBe(false);
    expect(model.revision).toBe(revision);
    expect(model.turnAt(1)).toBe(turn);
    expect(model.thinking).toBe(false);
  });

  it('coalesces notice-only revisions with a later sparse turn patch', () => {
    const model = delegateTranscript();
    model.apply({ type: 'idle' });
    const base = model.revision;
    for (let index = 0; index < 100; index += 1) {
      model.apply({ type: 'notice', kind: 'retry', message: `retry ${index}` });
    }
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'running', task: 't', tools: 2, seconds: 3,
    });
    expect(model.changesSince(base)).toEqual({ kind: 'turns', indices: [1], revision: model.revision });
  });

  it('keeps a sparse old-turn patch separate from an appended suffix', () => {
    const model = delegateTranscript();
    model.apply({ type: 'idle' });
    const base = model.revision;
    model.apply({ type: 'user', text: 'new question' });
    model.apply({
      type: 'subagent', id: 'call-1', sessionId: 's', status: 'done', task: 't', tools: 4, seconds: 5,
    });
    expect(model.changesSince(base)).toEqual({
      kind: 'patch', from: 2, indices: [1], revision: model.revision,
    });
  });
});
