import { describe, it, expect, vi } from 'vitest';
import { BrainOAuthManager } from '../../src/brain/oauth.js';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';

type Callbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: { userCode: string; verificationUri: string }) => void;
  onPrompt: (p: { message: string; allowEmpty?: boolean }) => Promise<string>;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (p: { options: { id: string; label: string }[] }) => Promise<string | undefined>;
};

function fakeAuth(loginImpl: (provider: string, cb: Callbacks) => Promise<void>) {
  const creds = new Set<string>();
  return {
    login: vi.fn(loginImpl),
    get: (p: string) => (creds.has(p) ? { type: 'oauth' } : undefined),
    remove: (p: string) => creds.delete(p),
    _connect: (p: string) => creds.add(p),
  } as unknown as AuthStorage & { _connect: (p: string) => void };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BrainOAuthManager', () => {
  it('runs an Anthropic-style flow: authUrl → pasted code → success', async () => {
    const auth = fakeAuth(async (_p, cb) => {
      cb.onAuth({ url: 'https://claude.ai/authorize', instructions: 'paste the code' });
      const code = await (cb.onManualCodeInput?.() ?? Promise.reject(new Error('no manual input')));
      if (code !== 'the-code') throw new Error('bad code');
    });
    const mgr = new BrainOAuthManager(auth);
    const started = mgr.start('anthropic');
    await tick();
    const waiting = mgr.get(started.id);
    expect(waiting?.status).toBe('action-required');
    expect(waiting?.authUrl).toBe('https://claude.ai/authorize');
    expect(waiting?.needsInput).toBe(true);
    expect(mgr.submitInput(started.id, 'the-code')).toBe(true);
    await tick();
    expect(mgr.get(started.id)?.status).toBe('success');
  });

  it('runs a device-code flow: url + userCode, no input needed', async () => {
    let finish: () => void = () => {};
    const auth = fakeAuth(async (_p, cb) => {
      cb.onDeviceCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
      await new Promise<void>((r) => { finish = r; });
    });
    const mgr = new BrainOAuthManager(auth);
    const started = mgr.start('github-copilot');
    await tick();
    const s = mgr.get(started.id);
    expect(s?.userCode).toBe('ABCD-1234');
    expect(s?.needsInput).toBe(false);
    finish();
    await tick();
    expect(mgr.get(started.id)?.status).toBe('success');
  });

  it('onSelect picks the requested login method, else falls back to the first option', async () => {
    const picks: (string | undefined)[] = [];
    const auth = fakeAuth(async (_p, cb) => {
      picks.push(await cb.onSelect({ options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }] }));
    });
    const mgr = new BrainOAuthManager(auth);
    mgr.start('openai-codex', { method: 'device_code' }); // exact match → device_code
    mgr.start('openai-codex');                            // no method → first option
    mgr.start('openai-codex', { method: 'nope' });        // unknown method → first option
    await tick();
    expect(picks).toEqual(['device_code', 'browser', 'browser']);
  });

  it('auto-answers empty-allowed prompts and surfaces login errors', async () => {
    const auth = fakeAuth(async (_p, cb) => {
      const domain = await cb.onPrompt({ message: 'GitHub domain', allowEmpty: true });
      if (domain !== '') throw new Error('unexpected');
      throw new Error('upstream boom');
    });
    const mgr = new BrainOAuthManager(auth);
    const started = mgr.start('github-copilot');
    await tick();
    const s = mgr.get(started.id);
    expect(s?.status).toBe('error');
    expect(s?.error).toContain('upstream boom');
  });

  it('submitInput returns false when nothing is waiting; connected reflects the store', () => {
    const auth = fakeAuth(async () => {});
    const mgr = new BrainOAuthManager(auth);
    expect(mgr.submitInput('nope', 'x')).toBe(false);
    expect(mgr.connected('anthropic')).toBe(false);
    auth._connect('anthropic');
    expect(mgr.connected('anthropic')).toBe(true);
    mgr.disconnect('anthropic');
    expect(mgr.connected('anthropic')).toBe(false);
  });
});
