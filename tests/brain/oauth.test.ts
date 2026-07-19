import { describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction, Credential, OAuthCredential } from '@earendil-works/pi-ai';
import { BrainOAuthManager } from '../../src/brain/oauth.js';
import type { BrainCredentialAccess } from '../../src/brain/providerUsage.js';

const CRED: OAuthCredential = { type: 'oauth', access: 'a', refresh: 'r', expires: 0 };

/** A credential set both `connected` (via creds.get) and the fake runtime's logout read/write — the
 *  runtime's persistent store, in miniature. */
function fakeCreds() {
  const connected = new Set<string>();
  const creds: BrainCredentialAccess = {
    get: (p) => (connected.has(p) ? CRED : undefined),
    getApiKey: async (p) => (connected.has(p) ? CRED.access : undefined),
  };
  return { creds, connected };
}

/** A fake ModelRuntime that drives login through PI 0.80.8's unified AuthInteraction (`notify` streams the
 *  browser URL / device code, `prompt` asks for a selection or a pasted code). `loginImpl` plays the
 *  provider; on success the shared credential set gains the provider, so `connected` flips exactly as the
 *  real persistent store would. `logout` clears it. */
function fakeRuntime(
  connected: Set<string>,
  loginImpl: (provider: string, interaction: AuthInteraction) => Promise<void>,
) {
  return {
    login: vi.fn(async (provider: string, _type: string, interaction: AuthInteraction) => {
      await loginImpl(provider, interaction);
      connected.add(provider);
      return CRED as Credential;
    }),
    logout: vi.fn(async (provider: string) => { connected.delete(provider); }),
  } as unknown as ModelRuntime;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BrainOAuthManager', () => {
  it('runs an Anthropic-style flow: authUrl → pasted code → success', async () => {
    const { creds, connected } = fakeCreds();
    const runtime = fakeRuntime(connected, async (_p, i) => {
      i.notify({ type: 'auth_url', url: 'https://claude.ai/authorize', instructions: 'paste the code' });
      const code = await i.prompt({ type: 'manual_code', message: 'Paste the authorization code' });
      if (code !== 'the-code') throw new Error('bad code');
    });
    const mgr = new BrainOAuthManager(runtime, creds);
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
    const { creds, connected } = fakeCreds();
    const runtime = fakeRuntime(connected, async (_p, i) => {
      i.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
      await new Promise<void>((r) => { finish = r; });
    });
    const mgr = new BrainOAuthManager(runtime, creds);
    const started = mgr.start('github-copilot');
    await tick();
    const s = mgr.get(started.id);
    expect(s?.userCode).toBe('ABCD-1234');
    expect(s?.needsInput).toBe(false);
    finish();
    await tick();
    expect(mgr.get(started.id)?.status).toBe('success');
  });

  it('a select prompt picks the requested login method, else falls back to the first option', async () => {
    const picks: (string | undefined)[] = [];
    const { creds, connected } = fakeCreds();
    const runtime = fakeRuntime(connected, async (_p, i) => {
      picks.push(await i.prompt({
        type: 'select', message: 'Choose a sign-in method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      }));
    });
    const mgr = new BrainOAuthManager(runtime, creds);
    mgr.start('openai-codex', { method: 'device_code' }); // exact match → device_code
    mgr.start('openai-codex');                            // no method → first option
    mgr.start('openai-codex', { method: 'nope' });        // unknown method → first option
    await tick();
    expect(picks).toEqual(['device_code', 'browser', 'browser']);
  });

  it('auto-answers an optional text prompt (no UI wait) and still surfaces a login error', async () => {
    const { creds, connected } = fakeCreds();
    const runtime = fakeRuntime(connected, async (_p, i) => {
      // GitHub Copilot emits an OPTIONAL enterprise-domain prompt BEFORE its device code. The manager must
      // auto-answer it empty — as the old `allowEmpty` path did — rather than strand the flow waiting on a
      // contextless input the code-submit endpoint would reject. If it ever regresses to waiting, the prompt
      // never resolves (no submitInput), login never settles, and the error assertion below fails.
      const domain = await i.prompt({ type: 'text', message: 'GitHub domain' });
      expect(domain).toBe('');
      throw new Error('upstream boom');
    });
    const mgr = new BrainOAuthManager(runtime, creds);
    const started = mgr.start('github-copilot');
    await tick();
    // The optional prompt was auto-answered — the flow never blocked on input.
    expect(mgr.get(started.id)?.needsInput).toBe(false);
    const s = mgr.get(started.id);
    expect(s?.status).toBe('error');
    expect(s?.error).toContain('upstream boom');
  });

  it('submitInput returns false when nothing is waiting; connected reflects the store', async () => {
    const { creds, connected } = fakeCreds();
    const runtime = fakeRuntime(connected, async () => {});
    const mgr = new BrainOAuthManager(runtime, creds);
    expect(mgr.submitInput('nope', 'x')).toBe(false);
    expect(mgr.connected('anthropic')).toBe(false);
    connected.add('anthropic');
    expect(mgr.connected('anthropic')).toBe(true);
    await mgr.disconnect('anthropic');
    expect(mgr.connected('anthropic')).toBe(false);
  });
});
