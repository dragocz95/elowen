import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

/** `POST /brain/command` refuses a name in two different words, and the difference is the contract.
 *
 *  "unknown command" means the catalog has no executable command by that name — a typo, or a kind this
 *  endpoint never runs (a picker, an info line). "command is not server-dispatchable" means the command
 *  is real and this is the wrong place to ask: /maskot is a CLI overlay and /voice is the chat adapter's
 *  own state. A caller that shows the user "no such command" for the second case is lying to
 *  them, which is why the two survived the move to a catalog-driven dispatch and are pinned here.
 *
 *  Only the refusal paths are exercised, and they all decide before touching the brain — hence the empty
 *  stub, which is enough to get past the route family's `brain unavailable` guard. */
async function appWithBrain() {
  return makeTestApp({ extra: { brain: {} as never } });
}

const post = (token: string, body: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function refuse(name: unknown) {
  const { app, token } = await appWithBrain();
  const res = await app.request('/brain/command', post(token, { name }));
  return { status: res.status, body: await res.json() as { error?: string } };
}

describe('POST /brain/command refusals', () => {
  it.each([
    ['a name no command carries', 'definitely-not-a-command'],
    ['a picker, which no surface executes by name', 'model'],
    ['an info command, which the surface renders itself', 'stats'],
  ])('answers "unknown command" for %s', async (_why, name) => {
    expect(await refuse(name)).toEqual({ status: 400, body: { error: 'unknown command' } });
  });

  it.each([
    ['/maskot, a CLI-local action', 'maskot'],
    ['/voice, an adapter-owned action', 'voice'],
  ])('keeps "command is not server-dispatchable" for %s', async (_why, name) => {
    expect(await refuse(name)).toEqual({ status: 400, body: { error: 'command is not server-dispatchable' } });
  });

  // A non-string `name` never reaches the catalog, so it lands on the first refusal like any other
  // name the catalog cannot resolve.
  it('answers "unknown command" for a body with no usable name', async () => {
    expect(await refuse(42)).toEqual({ status: 400, body: { error: 'unknown command' } });
  });
});

describe('POST /brain/command /goal dispatch', () => {
  it('owns status, actions, drafts and new goals without a Web-specific protocol', async () => {
    const calls: unknown[][] = [];
    const goal = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Ship parity', draft: '', subgoals: '[]',
      turns_used: 2, turn_budget: 20, last_verdict: '', last_evidence: 'Tests added', paused_reason: '',
      created_at: '2026-08-30 10:00:00', updated_at: '2026-08-30 10:05:00',
    };
    const brain = {
      goalStatus: (...args: unknown[]) => { calls.push(['status', ...args]); return goal; },
      goalAction: (...args: unknown[]) => { calls.push(['action', ...args]); return args[1] === 'clear' ? null : goal; },
      setGoal: async (...args: unknown[]) => { calls.push(['set', ...args]); return goal; },
    };
    const { app, token } = await makeTestApp({ extra: { brain: brain as never } });
    const run = async (argument?: string) => {
      const res = await app.request('/brain/command', post(token, { name: 'goal', session: 'brain-1', ...(argument ? { argument } : {}) }));
      expect(res.status).toBe(200);
      return res.json() as Promise<{ data: { goal: typeof goal | null } }>;
    };

    expect((await run()).data.goal).toEqual(goal);
    expect((await run('show')).data.goal).toEqual(goal);
    expect((await run('pause')).data.goal).toEqual(goal);
    expect((await run('clear')).data.goal).toBeNull();
    expect((await run('draft Prepare release')).data.goal).toEqual(goal);
    expect((await run('Ship parity')).data.goal).toEqual(goal);

    expect(calls).toEqual([
      ['status', 1, 'brain-1'],
      ['status', 1, 'brain-1'],
      ['action', 1, 'pause', 'brain-1'],
      ['action', 1, 'clear', 'brain-1'],
      ['set', 1, 'Prepare release', { draft: true }, 'brain-1'],
      ['set', 1, 'Ship parity', { draft: false }, 'brain-1'],
    ]);
  });
});
