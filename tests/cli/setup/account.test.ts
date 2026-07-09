import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runAccountStep } from '../../../src/cli/setup/steps/account.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The account step drives Elowen's prompt adapter for interactive input; stub it so the sign-in flow is
// scriptable. `select` returns the top-level choice and the post-failure "What now?" choice; text/password
// feed canned credentials; everything else is a silent no-op.
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  select: vi.fn(),
  text: vi.fn(async () => 'admin'),
  password: vi.fn(async () => 'wrong-password'),
  confirm: vi.fn(),
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  note: () => {},
  isCancel: () => false,
}));

async function prompts(): Promise<{ select: Mock; text: Mock; password: Mock }> {
  const m = await import('../../../src/cli/ui/prompts.js');
  return { select: m.select as unknown as Mock, text: m.text as unknown as Mock, password: m.password as unknown as Mock };
}

/** Fetch double: /setup reports an existing admin (needsSetup:false); /auth/login always 401s. Records
 *  every login attempt so we can prove the loop is bounded. */
function loginAlways401(): { fetchFn: typeof fetch; logins: () => number } {
  let logins = 0;
  const fetchFn = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path === '/setup') return new Response(JSON.stringify({ needsSetup: false }), { status: 200 });
    if (path === '/auth/login') { logins++; return new Response('nope', { status: 401 }); }
    throw new Error(`unmocked route: ${path}`);
  }) as unknown as typeof fetch;
  return { fetchFn, logins: () => logins };
}

const ctx = (fetchFn: typeof fetch, embedded = false): WizardCtx => ({ base: 'http://x', fetchFn, answers: {}, embedded });

describe('cli/setup account step — existing admin (non-trapping sign-in)', () => {
  it('a wrong password with "Skip sign-in" reaches a bounded terminal state, not a loop', async () => {
    const { select } = await prompts();
    select.mockResolvedValueOnce('signin'); // top-level: try to sign in
    select.mockResolvedValueOnce('skip'); // after the 401: skip sign-in
    const { fetchFn, logins } = loginAlways401();
    const c = ctx(fetchFn);

    const result = await runAccountStep(c);

    expect(result).toEqual({ status: 'skipped' });
    expect(logins()).toBe(1); // exactly one attempt, then escaped
    expect(c.answers.account).toEqual({ username: '', created: false, signedIn: false });
  });

  it('"Go back" after a failed login returns { status: "back" }', async () => {
    const { select } = await prompts();
    select.mockResolvedValueOnce('signin');
    select.mockResolvedValueOnce('back');
    const { fetchFn } = loginAlways401();

    expect(await runAccountStep(ctx(fetchFn))).toEqual({ status: 'back' });
  });

  it('mashing "Try again" is capped — the loop terminates as skipped instead of running forever', async () => {
    const { select } = await prompts();
    select.mockResolvedValue('retry'); // always choose retry
    select.mockResolvedValueOnce('signin'); // …except the very first (top-level) choice
    const { fetchFn, logins } = loginAlways401();
    const c = ctx(fetchFn);

    const result = await runAccountStep(c);

    expect(result).toEqual({ status: 'skipped' });
    // Bounded: MAX_SIGNIN_ATTEMPTS attempts, then auto-skip. Never unbounded.
    expect(logins()).toBe(5);
    expect(c.answers.account?.signedIn).toBe(false);
  });

  it('embedded install offers a "continue" path that never attempts a sign-in', async () => {
    const { select, password } = await prompts();
    password.mockClear();
    select.mockResolvedValueOnce('continue');
    const { fetchFn, logins } = loginAlways401();
    const c = ctx(fetchFn, true);

    const result = await runAccountStep(c);

    expect(result).toEqual({ status: 'skipped' });
    expect(logins()).toBe(0); // no login attempted
    expect(password).not.toHaveBeenCalled();
  });
});
