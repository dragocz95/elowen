import { beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService, type BrainDeps } from '../../src/brain/brainService.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

type Provider = { id: string; label: string; type: 'openai'; baseUrl: string; models: string[]; apiKey: string };

const relay = (id = 'relay', model = 'm'): Provider =>
  ({ id, label: id, type: 'openai', baseUrl: `http://${id}/v1`, models: [model], apiKey: 'k' });

/** A throwaway PI session double: `prompt` either records a fake assistant reply or rejects, exactly
 *  what smokeTest reads back via extractText. */
function fakeSession(reply: string | Error) {
  const messages: { role: string; content: string }[] = [];
  return {
    sessionId: 'probe',
    messages,
    prompt: vi.fn(async (t: string) => {
      if (reply instanceof Error) throw reply;
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: reply });
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function makeService(opts: { providers?: Provider[]; reply?: string | Error } = {}) {
  const providers = opts.providers ?? [relay()];
  const session = fakeSession(opts.reply ?? 'OK');
  const createSession = vi.fn(async () => ({ session }));
  const db: Db = openDb(':memory:');
  const store = new BrainStore(db);
  const deps: BrainDeps = {
    store,
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'tok', get: () => null },
    config: { providers },
    prompts: { render: () => '' },
    url: 'http://x',
    // A real (throwaway) temp dir — smokeTest builds its OWN DefaultResourceLoader directly (unlike the
    // normal session path) so there's no injection seam for it; give it an empty, harmless cwd.
    cwd: mkdtempSync(join(tmpdir(), 'elowen-smoketest-')),
    createSession: createSession as unknown as BrainDeps['createSession'],
  };
  const svc = new BrainService(deps);
  return { svc, store, db, session, createSession };
}

describe('BrainService.resolvableModel', () => {
  it('resolves the configured default model id', () => {
    const { svc } = makeService();
    expect(svc.resolvableModel()).toBe('m');
  });

  it('picks the right model id for a multi-provider config (first provider, its first model)', () => {
    const { svc } = makeService({ providers: [relay('a', 'm1'), relay('b', 'm2')] });
    expect(svc.resolvableModel()).toBe('m1');
  });

  it('is null when no provider is configured', () => {
    const { svc } = makeService({ providers: [] });
    expect(svc.resolvableModel()).toBeNull();
  });
});

describe('BrainService.smokeTest', () => {
  it('runs one throwaway turn and reports ok + the resolved model + the reply', async () => {
    const { svc } = makeService({ reply: 'OK' });
    const r = await svc.smokeTest();
    expect(r).toEqual({ ok: true, model: 'm', reply: 'OK' });
  });

  it('never persists a conversation and never touches a user session', async () => {
    const { svc, db } = makeService({ reply: 'OK' });
    await svc.smokeTest();
    const n = (db.prepare('SELECT COUNT(*) AS n FROM brain_sessions').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('disposes the throwaway session after the probe', async () => {
    const { svc, session } = makeService({ reply: 'OK' });
    await svc.smokeTest();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('respects an explicit providerId/model selection', async () => {
    const { svc } = makeService({ providers: [relay('a', 'm1'), relay('b', 'm2')], reply: 'OK' });
    const r = await svc.smokeTest({ providerId: 'b', model: 'm2' });
    expect(r).toEqual({ ok: true, model: 'm2', reply: 'OK' });
  });

  it('reports {ok:false, error} when no brain provider is configured (never throws)', async () => {
    const { svc } = makeService({ providers: [] });
    const r = await svc.smokeTest();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no brain provider configured/);
  });

  it('swallows a model/transport failure into {ok:false, error}', async () => {
    const { svc } = makeService({ reply: new Error('connection refused') });
    const r = await svc.smokeTest();
    expect(r).toEqual({ ok: false, error: 'connection refused' });
  });

  it('reports an empty reply as a failure, carrying the resolved model', async () => {
    const { svc } = makeService({ reply: '' });
    const r = await svc.smokeTest();
    expect(r).toEqual({ ok: false, model: 'm', error: 'brain returned an empty reply' });
  });

  it('truncates an overlong reply to 200 chars', async () => {
    const { svc } = makeService({ reply: 'x'.repeat(500) });
    const r = await svc.smokeTest();
    expect(r.ok).toBe(true);
    expect(r.reply).toHaveLength(200);
  });
});
