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
    async start(o: { session?: string }) { calls.push(`start:${JSON.stringify(o)}`); return { sessionId: o.session ?? 'sess-1' }; },
    async setModel(s: { provider?: string; model?: string }) { calls.push(`setModel:${s.provider ?? ''}/${s.model ?? ''}`); return { model: s.model ?? 'default' }; },
    async setThinkingLevel(l: string) { calls.push(`think:${l}`); return { thinkingLevel: l }; },
    async stream(onEvent: (e: BrainEvent) => void, signal: AbortSignal, _b: number, onOpen?: () => void) {
      sink = onEvent; onOpen?.();
      // A slash/turn can settle (and abort) synchronously inside onOpen's dispatch, before we'd register
      // the listener — so re-check the flag first (the real stream's reader.read() rejects on abort).
      if (signal.aborted) return;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    },
    async send(text: string, mode: string) { calls.push(`send:${mode}:${text}`); push({ type: 'step', step: 1, maxSteps: 10 }, { type: 'text', delta: 'hello ' }, { type: 'text', delta: 'world' }, { type: 'idle' }); },
    async compact() { calls.push('compact'); return { message: 'compacted 3 turns', usage: null, compacted: true }; },
    async status() { calls.push('status'); return { model: 'm', title: 't' } as never; },
    async skills() { calls.push('skills'); return []; },
    async sessions() { calls.push('sessions'); return [{ id: 'brain-1', title: 'First chat', model: 'm', updated_at: '2026-07-07', active: true }]; },
    async commands() { calls.push('commands'); return [{ name: 'review', description: 'Review code', kind: 'prompt', prompt: 'Review the following: $ARGS' }]; },
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

  it('expands a plugin prompt command (/review …) instead of sending the literal slash', async () => {
    const { client, calls } = fakeClient();
    const { io: sink } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/review auth module'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('send:build:Review the following: auth module');
    // an unknown slash still goes through literally (it may be meaningful text)
    const b = fakeClient();
    await runHeadless('http://x', {}, ['-p', '/nonexistent hello'], { client: b.client, io: io().io });
    expect(b.calls).toContain('send:build:/nonexistent hello');
  });

  it('dispatches a /status slash and exits 0', async () => {
    const { client, calls } = fakeClient();
    const { io: sink, out } = io();
    const code = await runHeadless('http://x', {}, ['-p', '/status'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('status');
    expect(out.join('')).toContain('"model"');
  });

  it('runs a goal (--goal) and maps a done outcome to exit 0', async () => {
    const { client, calls } = fakeClient({ status: 'done', last_verdict: 'done', last_evidence: 'shipped', turns_used: 3, turn_budget: 8, paused_reason: '' } as GoalView);
    const { io: sink } = io();
    const code = await runHeadless('http://x', {}, ['--goal', 'ship it', '--max-turns', '8'], { client, io: sink });
    expect(code).toBe(0);
    expect(calls).toContain('setGoal:ship it:8');
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
