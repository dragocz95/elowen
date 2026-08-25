import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

/** `POST /brain/command` refuses a name in two different words, and the difference is the contract.
 *
 *  "unknown command" means the catalog has no executable command by that name — a typo, or a kind this
 *  endpoint never runs (a picker, an info line). "command is not server-dispatchable" means the command
 *  is real and this is the wrong place to ask: /goal and /maskot are CLI overlays, /voice is the chat
 *  adapter's own state. A caller that shows the user "no such command" for the second case is lying to
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
    ['/goal, a CLI-local action', 'goal'],
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
