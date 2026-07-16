import { describe, it, expect, afterEach } from 'vitest';
import { stripInlineReasoning, extractText, toolDetail, toolOutputView, isThinkingOnlyReply, shapeBrainMessages, setToolOutputPolicy } from '../../src/brain/messageView.js';
import { makeToolOutputPolicy } from '../../src/brain/toolOutput.js';

describe('toolDetail: read ranges', () => {
  it('shows the requested line range for paginated read_file calls', () => {
    expect(toolDetail({ path: 'src/brain/messageView.ts', offset: 120, limit: 80 }, 'read_file'))
      .toBe('src/brain/messageView.ts · lines 120–199');
    expect(toolDetail({ path: 'src/brain/messageView.ts', limit: 40 }, 'read_file'))
      .toBe('src/brain/messageView.ts · lines 1–40');
    expect(toolDetail({ path: 'src/brain/messageView.ts', offset: 120 }, 'read_file'))
      .toBe('src/brain/messageView.ts · from line 120');
  });

  it('keeps read pagination visible when a long path must be shortened', () => {
    const detail = toolDetail({ path: `/very/${'long/'.repeat(12)}file.ts`, offset: 20, limit: 10 }, 'read_file');
    expect(detail).toHaveLength(60);
    expect(detail).toMatch(/… · lines 20–29$/);
  });

  it('leaves unpaginated reads and other tools unchanged', () => {
    expect(toolDetail({ path: 'src/a.ts' }, 'read_file')).toBe('src/a.ts');
    expect(toolDetail({ path: 'src', offset: 2, limit: 3 }, 'list_dir')).toBe('src');
  });
});

describe('shapeBrainMessages: compaction divider', () => {
  it('surfaces a persisted compaction row as an empty "compaction" view before the kept tail', () => {
    const rows = [
      { role: 'compaction', content: JSON.stringify({ role: 'compactionSummary', summary: 'older turns', tokensBefore: 999 }) },
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'recent question' }) },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] }) },
    ];
    const views = shapeBrainMessages(rows);
    expect(views[0]).toEqual({ role: 'compaction', text: '' }); // divider, summary stays out of the transcript
    expect(views[1]).toMatchObject({ role: 'user', text: 'recent question' });
    expect(views[2]).toMatchObject({ role: 'assistant', text: 'recent answer' });
  });
});

describe('shapeBrainMessages: durable sub-agent state', () => {
  it('keeps the tool-call id and attaches the validated sidecar snapshot for reconnect/drill-in', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'delegate-1', name: 'delegate', arguments: { task: 'inspect' } }],
      }),
    }];
    const [view] = shapeBrainMessages(rows, [{
      toolCallId: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect',
      detail: 'read_file src/a.ts', tools: 2, tokens: 900, seconds: 4, model: 'm',
    }]);
    expect(view?.segments?.[0]).toMatchObject({
      kind: 'tool', id: 'delegate-1', name: 'delegate',
      sub: {
        sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect',
        detail: 'read_file src/a.ts', tools: 2, tokens: 900, seconds: 4, model: 'm',
      },
    });
  });
});

describe('shapeBrainMessages: durable workflow state', () => {
  it('attaches the DAG to its own workflow_start call and no other tool row', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'workflow_start', arguments: { title: 'Ship it' } },
          { type: 'toolCall', id: 'call-2', name: 'read_file', arguments: { path: 'src/a.ts' } },
        ],
      }),
    }];
    const run = {
      id: 'wf-1', toolCallId: 'call-1', title: 'Ship it', status: 'running' as const,
      nodes: [{ id: 'gather', task: 'gather facts', status: 'done' as const, deps: [], sessionId: 'child', tokens: 120 }],
    };
    const [view] = shapeBrainMessages(rows, [], [], [run]);
    expect(view?.segments?.[0]).toMatchObject({ kind: 'tool', id: 'call-1', name: 'workflow_start', wf: run });
    expect(view?.segments?.[1]).not.toHaveProperty('wf');
  });
});

describe('shapeBrainMessages: session-event interleave', () => {
  it('merges session-change markers into the transcript by timestamp', () => {
    const rows = [
      { id: 'm1', role: 'user', content: JSON.stringify({ role: 'user', content: 'hello' }), created_at: '2026-07-16 09:00:00' },
      { id: 'm2', role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }), created_at: '2026-07-16 09:00:05' },
    ];
    const views = shapeBrainMessages(rows, [], [{ id: 'evt-1', kind: 'model', detail: 'anthropic/claude', at: '2026-07-16T09:00:10.000Z' }]);
    expect(views.map((v) => [v.role, v.id])).toEqual([['user', 'm1'], ['assistant', 'm2'], ['event', 'evt-1']]);
    expect(views[2]).toEqual({ id: 'evt-1', role: 'event', text: '', kind: 'model', detail: 'anthropic/claude' });
  });

  // Second-precision message stamps mean a marker routinely ties with the row it borders. A marker is
  // recorded BETWEEN turns, so a tie must resolve the way the live fold renders it.
  it('places a marker tying with a user row BEFORE it — a mode switch precedes the turn it applies to', () => {
    const rows = [
      { id: 'm1', role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }), created_at: '2026-07-16 09:00:00' },
      { id: 'm2', role: 'user', content: JSON.stringify({ role: 'user', content: 'now in workflow' }), created_at: '2026-07-16 09:00:00' },
    ];
    const views = shapeBrainMessages(rows, [], [{ id: 'evt-1', kind: 'mode', detail: 'Workflow', at: '2026-07-16T09:00:00.000Z' }]);
    expect(views.map((v) => [v.role, v.id])).toEqual([['assistant', 'm1'], ['event', 'evt-1'], ['user', 'm2']]);
  });

  it('returns messages unchanged when there are no session events', () => {
    const rows = [{ id: 'm1', role: 'user', content: JSON.stringify({ role: 'user', content: 'hi' }), created_at: '2026-07-16 09:00:00' }];
    expect(shapeBrainMessages(rows, [], []).map((v) => v.role)).toEqual(['user']);
  });
});

describe('isThinkingOnlyReply', () => {
  const asst = (m: Record<string, unknown>) => ({ role: 'assistant', ...m });

  it('detects a stop turn whose content is ONLY thinking (no text, no tool call)', () => {
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: [{ type: 'thinking', thinking: '…I will tell the user' }] }))).toBe(true);
  });

  it('a turn with visible text or a tool call is NOT thinking-only', () => {
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }] }))).toBe(false);
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: [{ type: 'toolCall', id: '1', name: 'read_file', arguments: {} }] }))).toBe(false);
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: 'plain string reply' }))).toBe(false);
  });

  it('errored/aborted turns and non-assistant messages are excluded — they have their own paths', () => {
    expect(isThinkingOnlyReply(asst({ stopReason: 'error', content: [] }))).toBe(false);
    expect(isThinkingOnlyReply(asst({ stopReason: 'aborted', content: [{ type: 'thinking', thinking: 'x' }] }))).toBe(false);
    expect(isThinkingOnlyReply({ role: 'user', stopReason: 'stop', content: [] })).toBe(false);
  });

  it('counts inline <think>-only text as thinking-only (extractText strips it to nothing)', () => {
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: [{ type: 'text', text: '<think>only reasoning</think>' }] }))).toBe(true);
  });
});

describe('stripInlineReasoning', () => {
  it('leaves text without reasoning tags untouched', () => {
    expect(stripInlineReasoning('just a normal answer')).toBe('just a normal answer');
  });

  it('removes a complete <think>…</think> block, keeping the answer', () => {
    expect(stripInlineReasoning('<think>let me reason\nabout this</think>\n\nThe answer is 42.')).toBe('The answer is 42.');
    expect(stripInlineReasoning('<thinking>hmm</thinking>Hello')).toBe('Hello');
  });

  it('removes an unclosed trailing reasoning block (stream cut off before the answer)', () => {
    expect(stripInlineReasoning('<think>still reasoning and never closed')).toBe('');
  });

  it('drops reasoning that streamed before a lone closing tag', () => {
    expect(stripInlineReasoning('reasoning with no open tag</think>\n\nFinal answer.')).toBe('Final answer.');
  });

  it('handles multiple blocks and preserves interleaved answer text', () => {
    expect(stripInlineReasoning('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });
});

describe('extractText strips leaked reasoning', () => {
  it('sanitizes an array-content assistant message', () => {
    const msg = { content: [{ type: 'text', text: '<think>secret</think>visible' }] };
    expect(extractText(msg)).toBe('visible');
  });
  it('sanitizes a string-content message', () => {
    expect(extractText({ content: '<think>x</think>ok' })).toBe('ok');
  });
});

describe('toolOutputView', () => {
  it('shows isError tool results even when the text lacks error keywords', () => {
    const out = toolOutputView('plugin_call', {}, { isError: true, content: [{ type: 'text', text: 'Unauthorized' }] });
    expect(out).toMatchObject({ tone: 'warning', text: 'Unauthorized', status: 'needs attention' });
  });

  it('keeps only a compact tail of long command output', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = toolOutputView('run_command', { command: 'printf' }, { content: [{ type: 'text', text }], details: { exitCode: 0 } });
    expect(out?.text).toContain('6 earlier lines hidden');
    expect(out?.fullText).toContain('line 1');
    expect(out?.text).toContain('line 12');
    expect(out?.text).not.toContain('line 1\n');
  });

  it('always surfaces a shell command on the first line, even when it exited silently', () => {
    const out = toolOutputView('run_command', { command: 'mkdir -p build' }, { content: [{ type: 'text', text: '' }], details: { exitCode: 0 } });
    expect(out).toBeDefined();
    expect(out?.command).toBe('mkdir -p build');
    expect(out?.kind).toBe('console');
    expect(out?.status).toBe('exit 0');
  });

  it('marks a silent successful shell command as done when no exit code is reported', () => {
    const out = toolOutputView('bash', { command: 'cd /tmp' }, { content: [{ type: 'text', text: '' }] });
    expect(out?.command).toBe('cd /tmp');
    expect(out?.status).toBe('done');
  });

  it('still hides a non-console tool that produced no useful output', () => {
    const out = toolOutputView('read_file', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }] });
    expect(out).toBeUndefined();
  });

  it('strips the redundant `$ command` echo and `[exit N]` from a console body (renderer re-adds both)', () => {
    // The terminal plugin frames its result verbatim as `$ <cmd>\n(cwd: …)\n<output>\n[exit N]`.
    const framed = '$ rm -rf public/x && echo done\n(cwd: /var/www/wemx)\ndone\n[exit 0]';
    const out = toolOutputView('run_command', { command: 'rm -rf public/x && echo done' }, { content: [{ type: 'text', text: framed }], details: { exitCode: 0 } });
    expect(out?.command).toBe('rm -rf public/x && echo done'); // echoed once, from args
    expect(out?.status).toBe('exit 0');                        // exit shown once, as the chip
    expect(out?.text).not.toMatch(/^\$ /);                     // no leading command echo left in the body
    expect(out?.text).not.toContain('[exit 0]');               // no trailing exit marker left in the body
    expect(out?.text).toContain('(cwd: /var/www/wemx)');       // cwd + real output survive
    expect(out?.text).toContain('done');
  });

  it('leaves genuine output that merely starts with `$ ` or ends in brackets intact', () => {
    // No numeric exit and the first line is real output — nothing to strip.
    const out = toolOutputView('bash', { command: 'cat prompt.txt' }, { content: [{ type: 'text', text: '$ enter value\n[done]' }] });
    expect(out?.text).toContain('$ enter value');
    expect(out?.text).toContain('[done]');
  });
});

describe('toolOutputView — single-source show policy', () => {
  // Injected once at bootstrap in prod; each test sets its own and restores the show-all default.
  afterEach(() => setToolOutputPolicy(() => true));

  it('hides an unlisted tool\'s successful output but keeps a shown tool\'s', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['run_command']));
    // list_dir / memory_* are NOT on the show allowlist → their (successful) output is dropped so
    // repeated calls can collapse.
    expect(toolOutputView('list_dir', { path: 'src' }, { content: [{ type: 'text', text: 'a.ts\nb.ts' }] })).toBeUndefined();
    expect(toolOutputView('memory_search', {}, { content: [{ type: 'text', text: 'a memory' }] })).toBeUndefined();
    // run_command IS on the allowlist → its console output surfaces.
    const shown = toolOutputView('run_command', { command: 'ls' }, { content: [{ type: 'text', text: 'a.ts' }], details: { exitCode: 0 } });
    expect(shown).toMatchObject({ kind: 'console', text: 'a.ts', status: 'exit 0' });
  });

  it('hides output by default — a tool on NO show list stays hidden (regression: default is hide)', () => {
    // Only run_command is allowlisted. cron_list (structured control data) declares nothing → hidden.
    // Under the old hide-list default-show, cron_list dumped its raw JSON into the transcript.
    setToolOutputPolicy(makeToolOutputPolicy(() => ['run_command']));
    expect(toolOutputView('cron_list', {}, { content: [{ type: 'text', text: '[{"id":1}]' }] })).toBeUndefined();
    expect(toolOutputView('ask_user_question', {}, { content: [{ type: 'text', text: 'picked A' }] })).toBeUndefined();
    expect(toolOutputView('some_third_party_tool', {}, { content: [{ type: 'text', text: 'noise' }] })).toBeUndefined();
  });

  it('an unlisted tool\'s FAILURE still surfaces (warning tone overrides the hide default)', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['run_command']));
    const failed = toolOutputView('list_dir', { path: 'nope' }, { isError: true, content: [{ type: 'text', text: 'ENOENT' }] });
    expect(failed).toMatchObject({ tone: 'warning', text: 'ENOENT' });
    const nonZero = toolOutputView('list_dir', { path: 'x' }, { content: [{ type: 'text', text: 'boom' }], details: { exitCode: 2 } });
    expect(nonZero?.tone).toBe('warning');
  });

  it('an unlisted tool\'s hook note still surfaces (a diff-less annotated result)', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['run_command']));
    const out = toolOutputView('write_file', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }], details: { notes: ['formatted a.ts'] } });
    expect(out?.notes).toEqual(['formatted a.ts']);
  });
});

describe('toolOutputView — hook-appended notes (details.notes)', () => {
  it('a diff result stays hidden without notes, but yields a notes-only view WITH them', () => {
    const base = { content: [{ type: 'text', text: 'Edited a.ts' }], details: { diff: '+    1 x' } };
    expect(toolOutputView('edit_file', { path: 'a.ts' }, base)).toBeUndefined();
    const out = toolOutputView('edit_file', { path: 'a.ts' }, { ...base, details: { ...base.details, notes: ['formatted a.ts with prettier'] } });
    expect(out).toMatchObject({ kind: 'result', text: '', tone: 'normal', notes: ['formatted a.ts with prettier'] });
  });

  it('notes earn an otherwise-hidden non-console result its block and ride a shown one', () => {
    const hidden = toolOutputView('write_file', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }], details: { notes: ['formatted a.ts with prettier'] } });
    expect(hidden?.notes).toEqual(['formatted a.ts with prettier']);
    const shown = toolOutputView('run_command', { command: 'x' }, { content: [{ type: 'text', text: 'out' }], details: { exitCode: 0, notes: ['note'] } });
    expect(shown).toMatchObject({ text: 'out', notes: ['note'] });
  });

  it('validates the untrusted notes array: non-strings dropped, whitespace collapsed, capped at 5', () => {
    const notes = [' a  note ', 42, '', 'b', 'c', 'd', 'e', 'f'];
    const out = toolOutputView('write_file', { path: 'a.ts' }, { content: [], details: { diff: '+ x', notes } });
    expect(out?.notes).toEqual(['a note', 'b', 'c', 'd', 'e']);
    // A non-array (or all-invalid) notes value contributes nothing — the diff result stays hidden.
    expect(toolOutputView('write_file', {}, { content: [], details: { diff: '+ x', notes: 'nope' } })).toBeUndefined();
    expect(toolOutputView('write_file', {}, { content: [], details: { diff: '+ x', notes: [42, '  '] } })).toBeUndefined();
  });
});

describe('tool output tone (needs attention)', () => {
  it('a clean exit 0 is success even when the output mentions errors/warnings', () => {
    const v = toolOutputView('run_command', { command: 'grep -rn error src' }, {
      content: [{ type: 'text', text: 'src/a.ts: handleError()\nnpm warn deprecated foo@1' }],
      details: { exitCode: 0 },
    });
    expect(v?.tone).toBe('success');
    expect(v?.status).toBe('exit 0');
  });

  it('a non-zero exit stays a warning', () => {
    const v = toolOutputView('run_command', { command: 'false' }, { content: [], details: { exitCode: 2 } });
    expect(v?.tone).toBe('warning');
  });

  it('without an exit code, prose merely mentioning "error" does not flag the row', () => {
    const v = toolOutputView('run_command', { command: 'cat notes.txt' }, {
      content: [{ type: 'text', text: 'the error handling chapter explains retries' }],
    });
    expect(v?.tone).not.toBe('warning');
  });

  it('without an exit code, a line starting with Error still warns', () => {
    const v = toolOutputView('run_command', { command: 'node x' }, {
      content: [{ type: 'text', text: 'Error: connect ECONNREFUSED' }],
    });
    expect(v?.tone).toBe('warning');
  });
});
