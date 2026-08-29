import { describe, it, expect, afterEach } from 'vitest';
import { stripInlineReasoning, extractText, toolDetail, toolDisplay, toolOutputView, isThinkingOnlyReply, shapeBrainMessages, withSubagentAnchors, withWorkflowAnchors, pendingSubmittedPlan, newestTurnStart, setToolOutputPolicy } from '../../src/brain/messageView.js';
import { makeToolOutputPolicy } from '../../src/brain/toolOutput.js';

describe('toolDisplay', () => {
  it('reports the actual tool name without disguising skill-file reads', () => {
    expect(toolDisplay('Read', { path: '/var/www/.config/elowen/plugins-data/skills/email-management.md' }))
      .toEqual({ name: 'Read', detail: '/var/www/.config/elowen/plugins-data/skills/email-managemen…' });
    expect(toolDisplay('SkillLoad', { name: 'email-management' }))
      .toEqual({ name: 'SkillLoad', detail: 'email-management' });
    expect(toolDisplay('Write', { path: '/x/skills/notes.md' }).name).toBe('Write');
  });
});

describe('toolDetail: read ranges', () => {
  it('shows the requested line range for paginated Read calls', () => {
    expect(toolDetail({ path: 'src/brain/messageView.ts', offset: 120, limit: 80 }, 'Read'))
      .toBe('src/brain/messageView.ts · lines 120–199');
    expect(toolDetail({ path: 'src/brain/messageView.ts', limit: 40 }, 'Read'))
      .toBe('src/brain/messageView.ts · lines 1–40');
    expect(toolDetail({ path: 'src/brain/messageView.ts', offset: 120 }, 'Read'))
      .toBe('src/brain/messageView.ts · from line 120');
  });

  it('keeps read pagination visible when a long path must be shortened', () => {
    const detail = toolDetail({ path: `/very/${'long/'.repeat(12)}file.ts`, offset: 20, limit: 10 }, 'Read');
    expect(detail).toHaveLength(60);
    expect(detail).toMatch(/… · lines 20–29$/);
  });

  it('leaves unpaginated reads and other tools unchanged', () => {
    expect(toolDetail({ path: 'src/a.ts' }, 'Read')).toBe('src/a.ts');
    expect(toolDetail({ path: 'src', offset: 2, limit: 3 }, 'ListDir')).toBe('src');
  });

  // Read/Write/Edit renamed `path` to `file_path` (the reference spelling the models are trained on), but
  // every conversation stored before that rename still carries the old key in its argument JSON, and those
  // rows are replayed verbatim. Both spellings therefore have to keep rendering — a transcript that went
  // blank on reload would be the visible cost of a rename that changed nothing about the stored data.
  it('renders both the stored `path` and the current `file_path` spelling', () => {
    expect(toolDetail({ file_path: 'src/a.ts' }, 'Read')).toBe('src/a.ts');
    expect(toolDetail({ path: 'src/a.ts' }, 'Read')).toBe('src/a.ts');
    expect(toolDetail({ file_path: 'src/a.ts', offset: 5, limit: 2 }, 'Read')).toBe('src/a.ts · lines 5–6');
    // Historical Edit calls carried path + oldText/newText; the path is still what identifies the call.
    expect(toolDetail({ path: 'src/a.ts', oldText: 'a', newText: 'b' }, 'Edit')).toBe('src/a.ts');
    expect(toolDetail({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'Edit')).toBe('src/a.ts');
  });

  // The `??` chain became a loop over TOOL_SUBJECT_KEYS when live recall started sharing that list.
  // A chain stops at the first key PRESENT, so a non-string value claims the slot and yields no detail;
  // a loop written to seek the first STRING would silently start rendering a later key instead.
  it('lets a present-but-unrenderable argument claim its slot rather than falling through', () => {
    expect(toolDetail({ path: 42, command: 'npm test' }, 'Bash')).toBeUndefined();
    expect(toolDetail({ command: 'npm test' }, 'Bash')).toBe('npm test');
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

describe('shapeBrainMessages: display metadata', () => {
  it('surfaces timestamps and optional settled turn duration without requiring it on legacy rows', () => {
    const views = shapeBrainMessages([
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'question' }), created_at: '2026-08-21 14:00:00' },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }), created_at: '2026-08-21 14:01:23', turn_duration_ms: 83_000 },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'legacy' }] }), created_at: '2026-08-20 10:00:00' },
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'row from before the column' }) },
    ]);
    // A user message is a turn of its own, and the chat stamps its bubble from this field alone. Dropping
    // it here (the assistant branch always kept it) left every sent message in the transcript timeless.
    expect(views[0]).toMatchObject({ role: 'user', text: 'question', createdAt: '2026-08-21 14:00:00' });
    expect(views[1]).toMatchObject({ role: 'assistant', createdAt: '2026-08-21 14:01:23', durationMs: 83_000 });
    expect(views[2]).not.toHaveProperty('durationMs');
    expect(views[3]).not.toHaveProperty('createdAt');
  });
});

describe('shapeBrainMessages: platform envelopes', () => {
  it('hides history, unwraps live messages and leaves lookalike user JSON visible', () => {
    const history = JSON.stringify({
      source: 'platform_history', untrusted: true, platform: 'msteams', channelId: 'chat-1', text: 'imported text',
    });
    const live = JSON.stringify({
      source: 'platform_message', untrusted: true, platform: 'msteams', channelId: 'chat-1',
      author: { id: '29:1a', name: 'Michal' }, text: 'live text',
    });
    const visibleJson = JSON.stringify({
      source: 'platform_message', untrusted: true, platform: 'msteams', channelId: 'chat-1', text: 'ordinary user text',
    });
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: history }) },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: history }] }) },
      { role: 'user', content: JSON.stringify({ role: 'user', content: live }) },
      { role: 'user', content: JSON.stringify({ role: 'user', content: visibleJson }) },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'normal answer' }] }) },
    ];
    const before = structuredClone(rows);

    expect(shapeBrainMessages(rows).map((view) => ({ role: view.role, text: view.text }))).toEqual([
      { role: 'user', text: 'live text' },
      { role: 'user', text: visibleJson },
      { role: 'assistant', text: 'normal answer' },
    ]);
    expect(rows).toEqual(before);
  });
});

describe('shapeBrainMessages: durable sub-agent state', () => {
  const run = {
    toolCallId: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'running' as const, task: 'inspect',
    detail: 'Read src/a.ts', tools: 2, tokens: 900, seconds: 4, model: 'm',
  };

  it('keeps the tool-call id and attaches the validated sidecar snapshot for reconnect/drill-in', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'delegate-1', name: 'Delegate', arguments: { task: 'inspect' } }],
      }),
    }];
    const [view] = shapeBrainMessages(rows, [run]);
    expect(view?.segments?.[0]).toMatchObject({
      kind: 'tool', id: 'delegate-1', name: 'Delegate',
      sub: {
        sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect',
        detail: 'Read src/a.ts', tools: 2, tokens: 900, seconds: 4, model: 'm',
      },
    });
  });

  it('accepts DelegateContinue but never attaches a sidecar to a foreign tool with the same id', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'delegate-1', name: 'Read', arguments: { path: 'src/a.ts' } },
          { type: 'toolCall', id: 'delegate-1', name: 'DelegateContinue', arguments: { id: 'child' } },
        ],
      }),
    }];
    const [view] = shapeBrainMessages(rows, [run]);
    const { toolCallId: _toolCallId, ...sub } = run;
    expect(view?.segments?.[0]).not.toHaveProperty('sub');
    expect(view?.segments?.[1]).toMatchObject({ name: 'DelegateContinue', sub });
  });

  it('still synthesizes over a foreign id collision and recognizes a real DelegateContinue anchor', () => {
    const foreign = [{ role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, name: 'Read', id: 'delegate-1' }] }];
    expect(withSubagentAnchors(foreign, [run])[0]).toMatchObject({ synthetic: true, id: 'sub-anchor-delegate-1' });
    const real = [{ role: 'assistant' as const, text: '', segments: [{ kind: 'tool' as const, name: 'DelegateContinue', id: 'delegate-1', sub: run }] }];
    expect(withSubagentAnchors(real, [run])).toEqual(real);
  });
});

describe('shapeBrainMessages: durable workflow state', () => {
  it('attaches the DAG to its own WorkflowStart call and no other tool row', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'WorkflowStart', arguments: { title: 'Ship it' } },
          { type: 'toolCall', id: 'call-2', name: 'Read', arguments: { path: 'src/a.ts' } },
        ],
      }),
    }];
    const run = {
      id: 'wf-1', toolCallId: 'call-1', title: 'Ship it', status: 'running' as const,
      nodes: [{ id: 'gather', task: 'gather facts', status: 'done' as const, deps: [], sessionId: 'child', tokens: 120 }],
    };
    const [view] = shapeBrainMessages(rows, [], [], [run]);
    expect(view?.segments?.[0]).toMatchObject({ kind: 'tool', id: 'call-1', name: 'WorkflowStart', wf: run });
    expect(view?.segments?.[1]).not.toHaveProperty('wf');
  });

  // An id collision must not decorate a foreign tool with workflow state: the DAG belongs to its
  // WorkflowStart row only, so attachment is gated on the tool NAME as well as the call id.
  it('never attaches the DAG to a non-WorkflowStart call that happens to carry the same id', () => {
    const rows = [{
      role: 'assistant',
      content: JSON.stringify({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'Read', arguments: { path: 'src/a.ts' } }],
      }),
    }];
    const run = {
      id: 'wf-1', toolCallId: 'call-1', status: 'running' as const,
      nodes: [{ id: 'gather', task: 'gather facts', status: 'running' as const, deps: [] }],
    };
    const [view] = shapeBrainMessages(rows, [], [], [run]);
    expect(view?.segments?.[0]).not.toHaveProperty('wf');
  });
});

describe('withWorkflowAnchors: orphaned running workflows', () => {
  const runningRun = {
    id: 'wf-1', toolCallId: 'call-wf', title: 'Ship it', status: 'running' as const,
    nodes: [{ id: 'gather', task: 'gather facts', status: 'running' as const, deps: [] }],
  };
  const tailViews = () => [
    { role: 'compaction' as const, text: '' },
    { role: 'user' as const, text: 'recent question' },
  ];

  // The incident this guards: compaction trimmed the WorkflowStart row out of the durable history while
  // the engine kept running the DAG — every client keys the panel AND live-event attachment on that row,
  // so the running workflow silently vanished from its own conversation's UI.
  it('prepends a synthetic WorkflowStart anchor for a running workflow with no anchor row', () => {
    const views = withWorkflowAnchors(tailViews(), [runningRun]);
    expect(views).toHaveLength(3);
    expect(views[0]).toEqual({
      id: 'wf-anchor-call-wf',
      // The one HTTP-served view whose id is NOT a SQLite row UUID — marked so a client can tell it
      // from, and drop it in favour of, the real anchor row once paging loads that row.
      synthetic: true,
      role: 'assistant',
      text: '',
      segments: [{ kind: 'tool', name: 'WorkflowStart', id: 'call-wf', detail: 'Ship it', wf: runningRun }],
    });
    // The tail is untouched and keeps its order.
    expect(views.slice(1)).toEqual(tailViews());
  });

  // The latent collision case: a foreign tool segment carrying the same call id must not count as the
  // anchor — suppressing the synthesis over it would key the panel and every later live snapshot to a
  // row that is not a workflow anchor at all.
  it('still synthesizes when only a NON-WorkflowStart segment carries the anchor id', () => {
    const collided = [{
      role: 'assistant' as const, text: '',
      segments: [{ kind: 'tool' as const, name: 'Read', id: 'call-wf' }],
    }];
    const views = withWorkflowAnchors(collided, [runningRun]);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ id: 'wf-anchor-call-wf', synthetic: true });
    expect(views[0]?.segments?.[0]).toMatchObject({ name: 'WorkflowStart', id: 'call-wf', wf: runningRun });
  });

  it('does nothing when the real anchor row is among the views', () => {
    const anchored = [
      {
        role: 'assistant' as const, text: '',
        segments: [{ kind: 'tool' as const, name: 'WorkflowStart', id: 'call-wf', wf: runningRun }],
      },
      ...tailViews(),
    ];
    expect(withWorkflowAnchors(anchored, [runningRun])).toEqual(anchored);
  });

  it('never resurrects a terminal workflow — only a running one is invisible-and-lying', () => {
    const done = { ...runningRun, status: 'done' as const };
    const cancelled = { ...runningRun, id: 'wf-2', toolCallId: 'call-2', status: 'cancelled' as const };
    expect(withWorkflowAnchors(tailViews(), [done, cancelled])).toEqual(tailViews());
  });

  it('keys the anchor check on the tool call id, not on any tool row being present', () => {
    const otherTool = [{
      role: 'assistant' as const, text: '',
      segments: [{ kind: 'tool' as const, name: 'Read', id: 'call-other' }],
    }];
    const views = withWorkflowAnchors(otherTool, [runningRun]);
    expect(views).toHaveLength(2);
    expect(views[0]?.segments?.[0]).toMatchObject({ id: 'call-wf', wf: runningRun });
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
    expect(isThinkingOnlyReply(asst({ stopReason: 'stop', content: [{ type: 'toolCall', id: '1', name: 'Read', arguments: {} }] }))).toBe(false);
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
  // Callers pass the raw result of JSON.parse on a stored row, and `null` / a bare scalar parse without
  // error — reading `.content` off them must not throw, or one bad row takes a whole transcript down.
  it('reads a non-object message as empty text instead of throwing', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText(42)).toBe('');
    expect(extractText('plain')).toBe('');
    expect(extractText([{ type: 'text', text: 'x' }])).toBe('');
  });
});

describe('shapeBrainMessages: rows that parse but are not messages', () => {
  // `null` and bare scalars are valid JSON, so the parse alone lets them through and every later
  // `.content` read throws — which used to fail the ENTIRE transcript, not just the damaged row.
  it('isolates a JSON null / scalar / array row and keeps the healthy rows around it', () => {
    const rows = [
      { id: 'a', role: 'user', content: JSON.stringify({ role: 'user', content: 'before' }) },
      { id: 'null-user-row', role: 'user', content: 'null' },
      { id: 'null-assistant-row', role: 'assistant', content: 'null' },
      { id: 'number-row', role: 'assistant', content: '42' },
      { id: 'array-row', role: 'assistant', content: '[{"type":"text","text":"nope"}]' },
      { id: 'broken-row', role: 'assistant', content: '{"content": [' },
      { id: 'z', role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'after' }] }) },
    ];
    const views = shapeBrainMessages(rows);
    expect(views.map((v) => v.id)).toEqual(['a', 'z']);
    expect(views[1]).toMatchObject({ role: 'assistant', text: 'after' });
  });
});

describe('toolOutputView', () => {
  it('shows isError tool results even when the text lacks error keywords', () => {
    const out = toolOutputView('plugin_call', {}, { isError: true, content: [{ type: 'text', text: 'Unauthorized' }] });
    expect(out).toMatchObject({ tone: 'warning', text: 'Unauthorized', status: 'needs attention' });
  });

  it('keeps only a compact tail of long command output', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = toolOutputView('Bash', { command: 'printf' }, { content: [{ type: 'text', text }], details: { exitCode: 0 } });
    expect(out?.text).toContain('6 earlier lines hidden');
    expect(out?.fullText).toContain('line 1');
    expect(out?.text).toContain('line 12');
    expect(out?.text).not.toContain('line 1\n');
  });

  it('always surfaces a shell command on the first line, even when it exited silently', () => {
    const out = toolOutputView('Bash', { command: 'mkdir -p build' }, { content: [{ type: 'text', text: '' }], details: { exitCode: 0 } });
    expect(out).toBeDefined();
    expect(out?.command).toBe('mkdir -p build');
    expect(out?.kind).toBe('console');
    // A clean exit 0 is the default state of a settled row — it carries NO status to display.
    expect(out?.status).toBeUndefined();
    expect(out?.tone).toBe('success');
  });

  it('a failing command keeps its exit code as the status', () => {
    const out = toolOutputView('Bash', { command: 'false' }, { content: [{ type: 'text', text: 'boom' }], details: { exitCode: 3 } });
    expect(out?.status).toBe('exit 3');
    expect(out?.tone).toBe('warning');
  });

  it('marks a silent successful shell command as done when no exit code is reported', () => {
    const out = toolOutputView('bash', { command: 'cd /tmp' }, { content: [{ type: 'text', text: '' }] });
    expect(out?.command).toBe('cd /tmp');
    expect(out?.status).toBe('done');
  });

  it('still hides a non-console tool that produced no useful output', () => {
    const out = toolOutputView('Read', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }] });
    expect(out).toBeUndefined();
  });

  it('strips the console framing from the body: command echo, cwd (→ structured field) and exit marker', () => {
    // The terminal plugin frames its result verbatim as `$ <cmd>\n(cwd: …)\n<output>\n[exit N]`.
    const framed = '$ rm -rf public/x && echo done\n(cwd: /var/www/wemx)\ndone\n[exit 0]';
    const out = toolOutputView('Bash', { command: 'rm -rf public/x && echo done' }, { content: [{ type: 'text', text: framed }], details: { exitCode: 0 } });
    expect(out?.command).toBe('rm -rf public/x && echo done'); // echoed once, from args
    expect(out?.status).toBeUndefined();                       // clean success → no status noise
    expect(out?.text).not.toMatch(/^\$ /);                     // no leading command echo left in the body
    expect(out?.text).not.toContain('[exit 0]');               // no trailing exit marker left in the body
    expect(out?.cwd).toBe('/var/www/wemx');                    // cwd lifted into its structured field
    expect(out?.text).toBe('done');                            // only the real output survives in the body
  });

  it('strips the framing on the LIVE path too, where the end event carries no args (the "[exit 0]" leak)', () => {
    // `tool_execution_end` has no args → no command — but the tool KIND is known, so the framing must
    // still never reach the display text (its last line used to become the chat adapters' summary).
    const framed = '$ sudo ls -lt /var/log/letsencrypt/ | head -5\n(cwd: /var/www/elowen)\ntotal 12\nletsencrypt.log\n[exit 0]';
    const out = toolOutputView('Bash', undefined, { content: [{ type: 'text', text: framed }], details: { exitCode: 0 } });
    expect(out?.text).not.toContain('[exit 0]');
    expect(out?.text.split('\n').at(-1)).toBe('letsencrypt.log');
    expect(out?.cwd).toBe('/var/www/elowen');
    expect(out?.status).toBeUndefined();
    expect(out?.tone).toBe('success');
    expect(out?.fullText ?? out?.text).not.toContain('[exit 0]');
  });

  it('a live-path FAILURE still exposes its exit code structurally', () => {
    const framed = '$ false\n(cwd: /var/www/elowen)\nboom: something broke\n[exit 3]';
    const out = toolOutputView('Bash', undefined, { content: [{ type: 'text', text: framed }], details: { exitCode: 3 } });
    expect(out?.status).toBe('exit 3');
    expect(out?.tone).toBe('warning');
    expect(out?.text).not.toContain('[exit 3]');
  });

  it('a SILENT live-path failure keeps its block: the exit-code status is the whole story', () => {
    const framed = '$ false\n(cwd: /var/www/elowen)\n[exit 3]';
    const out = toolOutputView('Bash', undefined, { content: [{ type: 'text', text: framed }], details: { exitCode: 3 } });
    expect(out).toBeDefined();
    expect(out?.status).toBe('exit 3');
    expect(out?.tone).toBe('warning');
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
    setToolOutputPolicy(makeToolOutputPolicy(() => ['Bash']));
    // ListDir / Memory* are NOT on the show allowlist → their (successful) output is dropped so
    // repeated calls can collapse.
    expect(toolOutputView('ListDir', { path: 'src' }, { content: [{ type: 'text', text: 'a.ts\nb.ts' }] })).toBeUndefined();
    expect(toolOutputView('MemorySearch', {}, { content: [{ type: 'text', text: 'a memory' }] })).toBeUndefined();
    // Bash IS on the allowlist → its console output surfaces.
    const shown = toolOutputView('Bash', { command: 'ls' }, { content: [{ type: 'text', text: 'a.ts' }], details: { exitCode: 0 } });
    expect(shown).toMatchObject({ kind: 'console', text: 'a.ts', tone: 'success' });
    expect(shown?.status).toBeUndefined();
  });

  it('titles LSP output as "LSP diagnostics"/"LSP result" so a check reads as LSP, not a generic result', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['Lsp*']));
    const diag = toolOutputView('LspDiagnostics', {}, { content: [{ type: 'text', text: 'no problems' }] });
    expect(diag?.title).toBe('LSP diagnostics');
    const nav = toolOutputView('LspGoToDefinition', {}, { content: [{ type: 'text', text: 'src/x.ts:10:2' }] });
    expect(nav?.title).toBe('LSP result');
  });

  it('hides output by default — a tool on NO show list stays hidden (regression: default is hide)', () => {
    // Only Bash is allowlisted. CronList (structured control data) declares nothing → hidden.
    // Under the old hide-list default-show, CronList dumped its raw JSON into the transcript.
    setToolOutputPolicy(makeToolOutputPolicy(() => ['Bash']));
    expect(toolOutputView('CronList', {}, { content: [{ type: 'text', text: '[{"id":1}]' }] })).toBeUndefined();
    expect(toolOutputView('AskUserQuestion', {}, { content: [{ type: 'text', text: 'picked A' }] })).toBeUndefined();
    expect(toolOutputView('some_third_party_tool', {}, { content: [{ type: 'text', text: 'noise' }] })).toBeUndefined();
  });

  it('an unlisted tool\'s FAILURE still surfaces (warning tone overrides the hide default)', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['Bash']));
    const failed = toolOutputView('ListDir', { path: 'nope' }, { isError: true, content: [{ type: 'text', text: 'ENOENT' }] });
    expect(failed).toMatchObject({ tone: 'warning', text: 'ENOENT' });
    const nonZero = toolOutputView('ListDir', { path: 'x' }, { content: [{ type: 'text', text: 'boom' }], details: { exitCode: 2 } });
    expect(nonZero?.tone).toBe('warning');
  });

  it('an unlisted tool\'s hook note still surfaces (a diff-less annotated result)', () => {
    setToolOutputPolicy(makeToolOutputPolicy(() => ['Bash']));
    const out = toolOutputView('Write', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }], details: { notes: ['formatted a.ts'] } });
    expect(out?.notes).toEqual(['formatted a.ts']);
  });
});

describe('toolOutputView — hook-appended notes (details.notes)', () => {
  it('a diff result stays hidden without notes, but yields a notes-only view WITH them', () => {
    const base = { content: [{ type: 'text', text: 'Edited a.ts' }], details: { diff: '+    1 x' } };
    expect(toolOutputView('Edit', { path: 'a.ts' }, base)).toBeUndefined();
    const out = toolOutputView('Edit', { path: 'a.ts' }, { ...base, details: { ...base.details, notes: ['formatted a.ts with prettier'] } });
    expect(out).toMatchObject({ kind: 'result', text: '', tone: 'normal', notes: ['formatted a.ts with prettier'] });
  });

  it('notes earn an otherwise-hidden non-console result its block and ride a shown one', () => {
    const hidden = toolOutputView('Write', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }], details: { notes: ['formatted a.ts with prettier'] } });
    expect(hidden?.notes).toEqual(['formatted a.ts with prettier']);
    const shown = toolOutputView('Bash', { command: 'x' }, { content: [{ type: 'text', text: 'out' }], details: { exitCode: 0, notes: ['note'] } });
    expect(shown).toMatchObject({ text: 'out', notes: ['note'] });
  });

  it('validates the untrusted notes array: non-strings dropped, whitespace collapsed, capped at 5', () => {
    const notes = [' a  note ', 42, '', 'b', 'c', 'd', 'e', 'f'];
    const out = toolOutputView('Write', { path: 'a.ts' }, { content: [], details: { diff: '+ x', notes } });
    expect(out?.notes).toEqual(['a note', 'b', 'c', 'd', 'e']);
    // A non-array (or all-invalid) notes value contributes nothing — the diff result stays hidden.
    expect(toolOutputView('Write', {}, { content: [], details: { diff: '+ x', notes: 'nope' } })).toBeUndefined();
    expect(toolOutputView('Write', {}, { content: [], details: { diff: '+ x', notes: [42, '  '] } })).toBeUndefined();
  });
});

describe('tool output tone (needs attention)', () => {
  it('a clean exit 0 is success even when the output mentions errors/warnings', () => {
    const v = toolOutputView('Bash', { command: 'grep -rn error src' }, {
      content: [{ type: 'text', text: 'src/a.ts: handleError()\nnpm warn deprecated foo@1' }],
      details: { exitCode: 0 },
    });
    expect(v?.tone).toBe('success');
    expect(v?.status).toBeUndefined();
  });

  it('a non-zero exit stays a warning', () => {
    const v = toolOutputView('Bash', { command: 'false' }, { content: [], details: { exitCode: 2 } });
    expect(v?.tone).toBe('warning');
  });

  it('without an exit code, prose merely mentioning "error" does not flag the row', () => {
    const v = toolOutputView('Bash', { command: 'cat notes.txt' }, {
      content: [{ type: 'text', text: 'the error handling chapter explains retries' }],
    });
    expect(v?.tone).not.toBe('warning');
  });

  it('without an exit code, a line starting with Error still warns', () => {
    const v = toolOutputView('Bash', { command: 'node x' }, {
      content: [{ type: 'text', text: 'Error: connect ECONNREFUSED' }],
    });
    expect(v?.tone).toBe('warning');
  });

  it('an informational listing that NAMES a failed item is not itself a failure', () => {
    // DelegateList prints each sub-agent's own status; one that ended in `error` puts that word at the
    // start of a later line. That is the listed run's outcome, not this call's — the row must stay calm.
    const list = '2 sub-agents in this conversation (newest first).\n\n'
      + '- brain-ch-subagent-sub-dlg-a\n  fix the money bug\n  error · 80 messages · 45m ago · gpt-5.6-terra\n'
      + '- brain-ch-subagent-sub-dlg-b\n  add the measurement\n  done · 80 messages · 42m ago · gpt-5.6-terra';
    const v = toolOutputView('DelegateList', {}, { content: [{ type: 'text', text: list }] });
    expect(v?.tone).not.toBe('warning');
  });
});

describe('newestTurnStart', () => {
  it('puts the whole transcript in the newest turn when there is no user row', () => {
    expect(newestTurnStart([])).toBe(0);
    expect(newestTurnStart([{ role: 'assistant' }, { role: 'toolResult' }])).toBe(0);
  });

  it('starts the newest turn one past the LAST user row, ignoring earlier ones', () => {
    expect(newestTurnStart([{ role: 'user' }, { role: 'assistant' }])).toBe(1);
    expect(newestTurnStart([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'toolResult' }])).toBe(3);
  });

  it('ends the newest turn at the transcript end when the last row is user', () => {
    expect(newestTurnStart([{ role: 'assistant' }, { role: 'user' }])).toBe(2);
  });
});

describe('pendingSubmittedPlan', () => {
  const planCall = (id: string, plan: string) => [
    { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'ExitPlanMode', arguments: { plan } }] }) },
    { role: 'toolResult', content: JSON.stringify({ role: 'toolResult', toolCallId: id, details: { plan } }) },
  ];

  it('reports the plan the newest turn submitted, keyed by its tool call id', () => {
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'plan the migration' }) },
      ...planCall('call-1', '# Migrate the store\n\n1. Add the column'),
    ];
    expect(pendingSubmittedPlan(rows)).toEqual({ id: 'call-1', plan: '# Migrate the store\n\n1. Add the column' });
  });

  it('still reports it when the turn carried on past the tool call', () => {
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'plan it' }) },
      ...planCall('call-1', '# Ship it'),
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Tell me if that works.' }] }) },
    ];
    expect(pendingSubmittedPlan(rows)).toEqual({ id: 'call-1', plan: '# Ship it' });
  });

  it('drops the decision once a newer user turn moved the conversation on', () => {
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'plan it' }) },
      ...planCall('call-1', '# Ship it'),
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'actually, forget it' }) },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'sure' }] }) },
    ];
    expect(pendingSubmittedPlan(rows)).toBeNull();
  });

  it('takes the LAST plan when one turn submitted two, and ignores every other tool', () => {
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'plan it' }) },
      ...planCall('call-1', '# First take'),
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'Read', arguments: { path: 'a.ts' } }] }) },
      { role: 'toolResult', content: JSON.stringify({ role: 'toolResult', toolCallId: 'read-1', details: { plan: 'not a plan tool' } }) },
      ...planCall('call-2', '# Second take'),
    ];
    expect(pendingSubmittedPlan(rows)).toEqual({ id: 'call-2', plan: '# Second take' });
  });

  it('answers null for a turn whose ExitPlanMode call never got its result', () => {
    const rows = [
      { role: 'user', content: JSON.stringify({ role: 'user', content: 'plan it' }) },
      { role: 'assistant', content: JSON.stringify({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'ExitPlanMode', arguments: { plan: '# Ship it' } }] }) },
    ];
    expect(pendingSubmittedPlan(rows)).toBeNull();
  });
});
