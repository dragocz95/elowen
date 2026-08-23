import { describe, it, expect } from 'vitest';
import { parseHeadlessArgs, runHeadless } from '../../../src/cli/chat/headless.js';
import type { BrainEvent } from '../../../src/brain/events.js';
import type { GoalView } from '../../../src/cli/chat/brainClient.js';

describe('cli/chat/headless.parseHeadlessArgs', () => {
  it('takes a bare positional as the prompt', () => {
    expect(parseHeadlessArgs(['do the thing']).prompt).toBe('do the thing');
  });
  it('parses -p and the model/session/mode flags', () => {
    const o = parseHeadlessArgs(['-p', 'hi', '--model', 'gpt-5.5', '--provider', 'openai', '--session', 'sess-1', '--plan']);
    expect(o).toMatchObject({ prompt: 'hi', model: 'gpt-5.5', provider: 'openai', session: 'sess-1', mode: 'plan' });
  });
  it('parses a goal run with a turn budget and output flags', () => {
    const o = parseHeadlessArgs(['--goal', 'refactor auth', '--max-turns', '12', '--json', '--verbose', '--timeout', '30']);
    expect(o).toMatchObject({ goal: 'refactor auth', maxTurns: 12, json: true, verbose: true, timeoutMs: 30_000 });
  });
  it('--new sets fresh, -c is a no-op (resume is the default)', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--new']).fresh).toBe(true);
    expect(parseHeadlessArgs(['-p', 'x', '-c']).fresh).toBe(false);
  });
  it('--resume <id> (alias of --session) targets a specific conversation', () => {
    expect(parseHeadlessArgs(['--resume', 'sess-9', 'hi']).session).toBe('sess-9');
    expect(parseHeadlessArgs(['--session', 'sess-9']).session).toBe('sess-9');
  });
  it('--list sets the list flag', () => {
    expect(parseHeadlessArgs(['--list']).list).toBe(true);
  });
  it('rejects an unknown flag and a bad --mode', () => {
    expect(parseHeadlessArgs(['--bogus']).error).toMatch(/unknown flag/);
    expect(parseHeadlessArgs(['--mode', 'sideways']).error).toMatch(/--mode/);
  });
  it('errors (not silently drops) when a value flag is missing its value', () => {
    const o = parseHeadlessArgs(['--model', '--json']);
    expect(o.error).toMatch(/--model needs a value/);
    expect(o.json).toBe(true); // the next flag is still parsed
    // the classic footgun: --goal with no value would otherwise silently run a plain turn
    expect(parseHeadlessArgs(['--goal', '--json', 'fix it']).error).toMatch(/--goal needs a value/);
  });
});

/** A fake BrainClient: `stream` captures the event sink and fires onOpen (which triggers the run's
 *  dispatch); the action methods then push scripted events through that sink. `goalRow` is what a goal
 *  run's poll observes (a settled row → the run exits with the mapped code). */
function fakeClient(goalRow: GoalView | null = null): { client: never; calls: string[] } {
  const calls: string[] = [];
  let sink: ((e: BrainEvent) => void) | undefined;
  const push = (...es: BrainEvent[]): void => { for (const e of es) sink?.(e); };
  const client = {
    bindLifetime() { /* no-op: this fixture never exercises the deadline race */ },
    async start(o: { session?: string }) { calls.push(`start:${JSON.stringify(o)}`); return { sessionId: o.session ?? 'sess-1' }; },
    async setModel(s: { provider?: string; model?: string }) { calls.push(`setModel:${s.provider ?? ''}/${s.model ?? ''}`); return { model: s.model ?? 'default' }; },
    async setThinkingLevel(l: string) { calls.push(`think:${l}`); return { thinkingLevel: l }; },
    async setFast(on?: boolean) { calls.push(`fast:${String(on)}`); return { fast: on ?? true, fastAvailable: true }; },
    async stream(onEvent: (e: BrainEvent) => void, signal: AbortSignal, _b: number, onOpen?: () => void) {
      sink = onEvent; onOpen?.();
      // A slash/turn can settle (and abort) synchronously inside onOpen's dispatch, before we'd register
      // the listener — so re-check the flag first (the real stream's reader.read() rejects on abort).
      if (signal.aborted) return;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    },
    // The daemon always echoes the accepted turn as a `user` event before streaming the reply — headless
    // gates its own output/completion on that echo (own-turn attribution), so a realistic fixture emits it.
    async send(text: string, mode: string) { calls.push(`send:${mode}:${text}`); push({ type: 'user', text }, { type: 'step', step: 1, maxSteps: 10 }, { type: 'text', delta: 'hello ' }, { type: 'text', delta: 'world' }, { type: 'idle' }); },
    async compact() { calls.push('compact'); return { message: 'compacted 3 turns', usage: null, compacted: true }; },
    async status() { calls.push('status'); return { model: 'm', title: 't' } as never; },
    async usageByModel() { calls.push('usageByModel'); return []; },
    async skills() { calls.push('skills'); return []; },
    async history() { return []; },
    async sessions() { calls.push('sessions'); return [{ id: 'brain-1', title: 'First chat', model: 'm', updated_at: '2026-07-07', active: true }]; },
    async renameSession(id: string, title: string) { calls.push(`rename:${id}:${title}`); return { id, title }; },
    async commands() { calls.push('commands'); return [{ name: 'review', description: 'Review code', kind: 'prompt', prompt: 'Review the following: $ARGUMENTS' }]; },
    async goal() { return goalRow; },
    async setGoal(text: string, _d: boolean, budget?: number) { calls.push(`setGoal:${text}:${budget ?? ''}`); return {} as GoalView; },
    async goalAction(a: string) { calls.push(`goalAction:${a}`); return { status: 'paused' } as GoalView; },
    async subgoal(a: string, v?: unknown) { calls.push(`subgoal:${a}:${v ?? ''}`); return {} as GoalView; },
  };
  return { client: client as never, calls };
}

const io = () => { const out: string[] = [], err: string[] = []; return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err }; };

describe('cli/chat/headless.runHeadless', () => {
  it('runs a plain turn: streams the text to stdout and exits 0', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['hello'], { client, io: sink });
    expect(code).toBe(0);
    expect(out.join('')).toContain('hello world');
    expect(calls).toContain('send:build:hello');
  });

  it('waits for idle when HTTP admission resolves before the first SSE event', async () => {
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(onFrame: (frame: BrainEvent) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onOpen?.();
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!signal.aborted) {
          onFrame({ type: 'user', text: 'delayed' });
          onFrame({ type: 'text', delta: 'delayed answer' });
          onFrame({ type: 'idle' });
        }
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async send() { /* HTTP 202 admission resolves immediately */ },
      async history() { return [{ id: 'answer', role: 'assistant', text: 'delayed answer' }]; },
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['delayed'], { client: client as never, io: sink });
    expect(code).toBe(0);
    expect(out.join('')).toContain('delayed answer');
  });

  it('fails an admission rejection even after prior stream activity', async () => {
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(onFrame: (frame: BrainEvent) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onOpen?.();
        onFrame({ type: 'text', delta: 'activity from the existing turn' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (!signal.aborted) onFrame({ type: 'idle' });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async send() { throw new Error('new prompt was not admitted'); },
      async history() { return []; },
    };
    const { io: sink, err } = io();
    const code = await runHeadless('http://x', {}, ['new prompt'], { client: client as never, io: sink });
    expect(code).toBe(1);
    expect(err.join('')).toContain('new prompt was not admitted');
  });

  it('does not finish on an already-running conversation\'s idle, and never leaks its tail, before this invocation\'s own prompt is echoed', async () => {
    const calls: string[] = [];
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(onFrame: (frame: BrainEvent) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onOpen?.();
        // A turn that was ALREADY running when we attached: its non-terminal tail arrives first...
        onFrame({ type: 'step', step: 1, maxSteps: 5 });
        onFrame({ type: 'text', delta: 'old partial answer' });
        // ...then it settles, live, BEFORE this invocation's own prompt has even been echoed back.
        onFrame({ type: 'idle' });
        // Only now does OUR prompt start.
        onFrame({ type: 'user', text: 'new question' });
        onFrame({ type: 'text', delta: 'fresh answer' });
        onFrame({ type: 'idle' });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async send(text: string, mode: string) { calls.push(`send:${mode}:${text}`); },
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['new question'], { client: client as never, io: sink });
    const printed = out.join('');

    expect(code).toBe(0);
    expect(calls).toEqual(['send:build:new question']);
    expect(printed).not.toContain('old partial answer');
    expect(printed).toContain('fresh answer');
  });

  it('awaits the server-side abort (bounded) before finishing an unanswered ask, so the process cannot exit before the session lock is released', async () => {
    let abortResolved = false;
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((r) => { resolveAbort = r; });
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(onFrame: (frame: BrainEvent) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onOpen?.();
        onFrame({ type: 'user', text: 'do it' });
        onFrame({ type: 'ask', id: 'q1', questions: [{ question: 'which file?', header: 'h', multiSelect: false, options: [] }] });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async send() {},
      async abort() { await abortPromise; abortResolved = true; },
    };
    const { io: sink } = io();
    const promise = runHeadless('http://x', {}, ['do it'], { client: client as never, io: sink });
    // Let the ask handler's microtasks run: the abort call must be in flight but not yet resolved —
    // proving the caller waits for it rather than firing it and moving on in the same tick.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(abortResolved).toBe(false);
    resolveAbort();
    const code = await promise;
    expect(code).toBe(5);
    expect(abortResolved).toBe(true);
  });

  it('bounds --list by --timeout even when the daemon never answers (the deadline is created before the first request)', async () => {
    let boundSignal: AbortSignal | undefined;
    const client = {
      bindLifetime(signal: AbortSignal) { boundSignal = signal; },
      async sessions(): Promise<never> {
        return new Promise((_resolve, reject) => { boundSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      },
    };
    const { io: sink, err } = io();
    const code = await runHeadless('http://x', {}, ['--list', '--timeout', '0.05'], { client: client as never, io: sink });
    expect(code).toBe(124);
    expect(err.join('')).toContain('timeout after');
  });

  it('bounds session start by --timeout too, not just the stream, so a hung daemon cannot hang the whole command', async () => {
    let boundSignal: AbortSignal | undefined;
    const client = {
      bindLifetime(signal: AbortSignal) { boundSignal = signal; },
      async start(): Promise<never> {
        return new Promise((_resolve, reject) => { boundSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      },
    };
    const { io: sink, err } = io();
    const code = await runHeadless('http://x', {}, ['hello', '--timeout', '0.05'], { client: client as never, io: sink });
    expect(code).toBe(124);
    expect(err.join('')).toContain('timeout after');
  });

  it('recovers a reconnect snapshot tail without reprinting durable history or prior live text', async () => {
    const calls: string[] = [];
    let snapshotRequested: boolean | undefined;
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(
        onFrame: (frame: BrainEvent | { type: 'snapshot'; cursor: number; history: { id?: string; role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        onOpen?: () => void,
        _session?: string,
        snapshot?: boolean,
      ) {
        snapshotRequested = snapshot;
        // Initial history is a baseline, not output for this invocation.
        onFrame({ type: 'snapshot', cursor: 1, history: [{ id: 'old-u', role: 'user', text: 'old question' }, { id: 'old-a', role: 'assistant', text: 'old answer' }], events: [] });
        onOpen?.();
        await Promise.resolve();

        // The original connection printed the prefix, then dropped. The replacement snapshot coalesces
        // it with bytes that arrived while the socket was gone.
        onFrame({ type: 'user', text: 'new question', durableId: 'u-live' });
        onFrame({ type: 'text', delta: 'hello ' });
        onFrame({
          type: 'snapshot', cursor: 4,
          history: [{ id: 'old-u', role: 'user', text: 'old question' }, { id: 'old-a', role: 'assistant', text: 'old answer' }],
          events: [{ type: 'user', text: 'new question', durableId: 'u-live' }, { type: 'text', delta: 'hello world' }],
        });
        // The turn settles while disconnected. The next snapshot has the complete durable assistant row
        // plus idle; it must neither lose `world` nor print `hello world` a second time.
        onFrame({
          type: 'snapshot', cursor: 5,
          history: [
            { id: 'old-u', role: 'user', text: 'old question' }, { id: 'old-a', role: 'assistant', text: 'old answer' },
            { id: 'new-u', role: 'user', text: 'new question' }, { id: 'new-a', role: 'assistant', text: 'hello world' },
          ],
          events: [{ type: 'idle' }],
        });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async send(text: string, mode: string) { calls.push(`send:${mode}:${text}`); },
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['new question'], { client: client as never, io: sink });

    const printed = out.join('');
    expect(code).toBe(0);
    expect(snapshotRequested).toBe(true);
    expect(calls).toEqual(['send:build:new question']);
    expect(printed).toContain('hello world');
    expect(printed.match(/hello world/g)).toHaveLength(1);
    expect(printed).not.toContain('old answer');
  });

  it('uses durable row ids so compaction can replace identical text without losing it or reprinting a mutable row', async () => {
    const initial = [
      { id: 'old-ok', role: 'assistant', text: 'OK' },
      { id: 'delegate-row', role: 'assistant', text: 'already rendered', segments: [{ kind: 'tool', name: 'Delegate', sub: { status: 'running' } }] },
    ];
    const settled = [
      // The old identical OK row was compacted away. The delegate row changed only its durable sidecar.
      { id: 'delegate-row', role: 'assistant', text: 'already rendered', segments: [{ kind: 'tool', name: 'Delegate', sub: { status: 'done' } }] },
      { id: 'new-ok', role: 'assistant', text: 'OK' },
    ];
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async history() { return settled; },
      async stream(onFrame: (frame: unknown) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onFrame({ type: 'snapshot', cursor: 1, run: 0, history: initial, events: [] });
        onOpen?.();
        await Promise.resolve();
        // A `user` echo for THIS invocation's prompt ('answer') must precede idle — own-turn attribution
        // gates on it, same as the real daemon.
        onFrame({ type: 'snapshot', cursor: 2, run: 1, history: settled, events: [{ type: 'user', text: 'answer' }, { type: 'idle' }] });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      async send() {},
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['answer'], { client: client as never, io: sink });
    const printed = out.join('');

    expect(code).toBe(0);
    expect(printed.match(/OK/g)).toHaveLength(1);
    expect(printed).not.toContain('already rendered');
  });

  it('normalizes state replacements and resets a goal replay journal between terminal runs', async () => {
    let historyReads = 0;
    let frameSink!: (frame: unknown) => void;
    const one = [{ id: 'a-one', role: 'assistant', text: 'one' }];
    const two = [...one, { id: 'a-two', role: 'assistant', text: 'two' }];
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async history() { return ++historyReads === 1 ? one : two; },
      async stream(onFrame: (frame: unknown) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        frameSink = onFrame;
        onFrame({ type: 'snapshot', cursor: 1, run: 0, history: [], events: [] });
        onOpen?.();
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      async setGoal() {
        // Two updates to the same state key must collapse exactly like LiveEventReplay; the reconnect
        // tail below contains only the second one and must not cause `one` to be emitted again.
        frameSink({ type: 'tool_progress', id: 'build', text: 'old' });
        frameSink({ type: 'tool_progress', id: 'build', text: 'new' });
        frameSink({ type: 'step', step: 1, maxSteps: 8 });
        frameSink({ type: 'text', delta: 'one' });
        frameSink({ type: 'idle' });
        // Goal continuation: no user event separates runs. `run:2` is the server-authoritative reset.
        frameSink({ type: 'snapshot', cursor: 5, run: 2, history: one, events: [
          { type: 'tool_progress', id: 'build', text: 'newer' },
          { type: 'step', step: 1, maxSteps: 8 }, { type: 'text', delta: 'two' },
        ] });
        frameSink({ type: 'snapshot', cursor: 7, run: 2, history: two, events: [{ type: 'idle' }] });
        return {};
      },
      async goal() { return { status: 'done', last_verdict: 'done', last_evidence: '', subgoals: '[]', turns_used: 2, turn_budget: 4, paused_reason: '' }; },
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['--goal', 'finish both'], { client: client as never, io: sink });
    const printed = out.join('');

    expect(code).toBe(0);
    const reply = printed.split('[goal')[0] ?? '';
    expect(reply.match(/one/g)).toHaveLength(1);
    expect(reply.match(/two/g)).toHaveLength(1);
  });

  it('recovers a truncated reconnect from settled durable history before exiting', async () => {
    const history = [{ id: 'a-recovered', role: 'assistant', text: 'full reply recovered from SQLite' }];
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async history() { return history; },
      async stream(onFrame: (frame: unknown) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        onFrame({ type: 'snapshot', cursor: 1, run: 0, history: [], events: [] });
        onOpen?.();
        await Promise.resolve();
        onFrame({ type: 'snapshot', cursor: 999, run: 1, truncated: true, history: [], events: [] });
        // Own-turn attribution gates on the `user` echo for this invocation's prompt ('recover').
        onFrame({ type: 'user', text: 'recover' });
        onFrame({ type: 'idle' });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      async send() {},
    };
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['recover'], { client: client as never, io: sink });

    expect(code).toBe(0);
    expect(out.join('')).toContain('full reply recovered from SQLite');
  });

  it('continues the active conversation by default; --new starts fresh; prints the session id', async () => {
    // default → resume active (start with no session/fresh)
    const a = fakeClient(); const sa = io();
    await runHeadless('http://x', {}, ['hi'], { client: a.client, io: sa.io });
    expect(a.calls).toContain('start:{}');
    expect(sa.err.join('')).toMatch(/\[session /);
    // --new → fresh
    const b = fakeClient(); const sb = io();
    await runHeadless('http://x', {}, ['hi', '--new'], { client: b.client, io: sb.io });
    expect(b.calls).toContain('start:{"fresh":true}');
    // --session <id> → that conversation
    const d = fakeClient(); const sd = io();
    await runHeadless('http://x', {}, ['hi', '--session', 'sess-9'], { client: d.client, io: sd.io });
    expect(d.calls).toContain('start:{"session":"sess-9"}');
  });

  it('applies --model before the turn', async () => {
    const { client, calls } = fakeClient();
    const { io: sink } = io();
    await runHeadless('http://x', {}, ['-p', 'hi', '--provider', 'openai', '--model', 'gpt-5.5'], { client, io: sink });
    expect(calls).toContain('setModel:openai/gpt-5.5');
  });

  it('--json emits each event as JSONL', async () => {
    const { client } = fakeClient();
    const { io: sink, out } = io();
    await runHeadless('http://x', {}, ['hi', '--json'], { client, io: sink });
    const lines = out.join('').trim().split('\n').map((l) => JSON.parse(l) as BrainEvent);
    expect(lines.some((e) => e.type === 'text')).toBe(true);
    expect(lines.some((e) => e.type === 'idle')).toBe(true);
  });

  it('sends a plugin prompt command (/review …) RAW — the daemon lets PI expand it natively', async () => {
    const { client, calls } = fakeClient();
    const { io: sink } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/review auth module'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('send:build:/review auth module');
    // an unknown slash likewise goes through literally (it may be meaningful text)
    const b = fakeClient();
    await runHeadless('http://x', {}, ['-p', '/nonexistent hello'], { client: b.client, io: io().io });
    expect(b.calls).toContain('send:build:/nonexistent hello');
  });

  // `/status` is retired on the CLI: `/stats` is the one session-info command and its payload already
  // carries the whole status object (plus the per-model totals).
  it('dispatches a /stats slash and exits 0', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/stats'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('status');
    expect(out.join('')).toContain('"model"');
  });

  it('sets Fast explicitly in headless CLI instead of dropping the slash argument', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/fast off'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('fast:false');
    expect(out.join('')).toContain('fast: off');
  });

  it('renames the bound conversation from headless CLI', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/rename Release triage'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('rename:sess-1:Release triage');
    expect(out.join('')).toContain('renamed: Release triage');
  });

  it('runs a goal (--goal) and maps a done outcome to exit 0', async () => {
    const { client, calls } = fakeClient({ status: 'done', last_verdict: 'done', last_evidence: 'shipped', turns_used: 3, turn_budget: 8, paused_reason: '' } as GoalView);
    const { io: sink } = io();
    const code = await runHeadless('http://x', {}, ['--goal', 'ship it', '--max-turns', '8'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('setGoal:ship it:8');
  });

  it('emits one terminal goal JSONL record when SSE and polling observe the same transition', async () => {
    const done = {
      session_id: 'sess-1', user_id: 1, status: 'done' as const, goal: 'Ship once', draft: '',
      subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: 'done', last_evidence: 'verified',
      paused_reason: '', created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:01',
    };
    let sink!: (event: BrainEvent) => void;
    const client = {
      bindLifetime() {},
      async start() { return { sessionId: 'sess-1' }; },
      async stream(onFrame: (frame: BrainEvent) => void, signal: AbortSignal, _backoff: number, onOpen?: () => void) {
        sink = onFrame;
        onOpen?.();
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      async setGoal() { sink({ type: 'goal', goal: done }); return done; },
      async goal() { return done; },
      async history() { return []; },
    };
    const { io: sinkIo, out } = io();

    const code = await runHeadless('http://x', {}, ['--goal', 'Ship once', '--json'], {
      client: client as never, io: sinkIo,
    });
    const goalLines = out.join('').trim().split('\n').map((line) => JSON.parse(line))
      .filter((event) => event.type === 'goal' && event.goal?.status === 'done');

    expect(code).toBe(0);
    expect(goalLines).toHaveLength(1);
  });

  it('maps a blocked goal to exit 4', async () => {
    const { client } = fakeClient({ status: 'paused', last_verdict: 'blocked', paused_reason: 'no key', turns_used: 2, turn_budget: 8, last_evidence: '' } as GoalView);
    const { io: sink } = io();
    expect(await runHeadless('http://x', {}, ['--goal', 'x'], { client, io: sink })).toBe(4);
  });

  it('--list prints the conversations and exits 0 (no prompt needed)', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['--list'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('sessions');
    expect(out.join('')).toContain('brain-1');
    expect(out.join('')).toContain('First chat');
  });

  it('exits 2 with usage when neither a prompt nor a goal is given', async () => {
    const { client } = fakeClient();
    const { io: sink, err } = io();
    expect(await runHeadless('http://x', {}, [], { client, io: sink })).toBe(2);
    expect(err.join('')).toContain('usage:');
  });
});
