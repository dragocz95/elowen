import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';
import { openDb } from '../../src/store/db.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';

/** The reasoning effort has ONE home.
 *
 *  It used to have two: POST /brain/think moved the live conversation, while a reload spawned the next
 *  session from the account default nobody had touched. Changing the level and pressing F5 therefore put
 *  the old level back, and neither value could be called the real one. These tests pin the fix — the
 *  route persists what it applied — because the symptom is invisible until somebody reloads.
 */

/** An app whose brain reports the level it was handed, optionally clamping it the way a model would. */
async function appWithBrain(clampTo?: string) {
  const settings = new UserSettingStore(openDb(':memory:'));
  const app = await makeTestApp({
    extra: {
      userSettings: settings,
      brain: {
        setThinkingLevel: async (_userId: number, level: string) => {
          if (level === 'nonsense') throw new Error(`model does not support reasoning effort "${level}"`);
          return { thinkingLevel: clampTo ?? level };
        },
      } as never,
    },
  });
  return { ...app, settings };
}

const post = (token: string, body: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /brain/think', () => {
  it('makes the chosen level the account default, so a reload cannot undo it', async () => {
    const { app, token, settings } = await appWithBrain();
    expect(settings.cliSettings(1).thinkingLevel).toBe('');

    const res = await app.request('/brain/think', post(token, { level: 'low' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { thinkingLevel: string }).thinkingLevel).toBe('low');

    // The value the next session is built from — the assertion the old behaviour failed.
    expect(settings.cliSettings(1).thinkingLevel).toBe('low');
  });

  it('persists what the model actually applied, not what was asked for', async () => {
    // A model may clamp the request. Storing the asked-for level would leave the account claiming one
    // effort while the conversation runs another — the same disagreement, just moved.
    const { app, token, settings } = await appWithBrain('medium');

    await app.request('/brain/think', post(token, { level: 'high' }));

    expect(settings.cliSettings(1).thinkingLevel).toBe('medium');
  });

  it('leaves the saved default alone when the level is refused', async () => {
    const { app, token, settings } = await appWithBrain();
    await app.request('/brain/think', post(token, { level: 'high' }));

    const res = await app.request('/brain/think', post(token, { level: 'nonsense' }));
    expect(res.status).toBe(409);

    expect(settings.cliSettings(1).thinkingLevel).toBe('high');
  });
});
