import { describe, it, expect, vi } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveToken, login, clearToken, NeedsLogin, tokenFile, defaultIo, type TokenIo } from '../../../src/cli/chat/token.js';

function memIo(initial: Record<string, string> = {}): TokenIo & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    read: (p) => (p in store ? store[p]! : null),
    write: (p, d) => { store[p] = d; },
    remove: (p) => { delete store[p]; },
  };
}

const env = { HOME: '/home/x' } as NodeJS.ProcessEnv;

describe('chat token', () => {
  it('prefers ELOWEN_TOKEN from the env', () => {
    expect(resolveToken({ ...env, ELOWEN_TOKEN: 'env-tok' }, memIo())).toBe('env-tok');
  });

  it('falls back to the cached file', () => {
    const io = memIo({ [tokenFile(env)]: JSON.stringify({ token: 'file-tok' }) });
    expect(resolveToken(env, io)).toBe('file-tok');
  });

  it('throws NeedsLogin when nothing is available', () => {
    expect(() => resolveToken(env, memIo())).toThrow(NeedsLogin);
  });

  it('treats a corrupt cache file as no token', () => {
    const io = memIo({ [tokenFile(env)]: 'not json' });
    expect(() => resolveToken(env, io)).toThrow(NeedsLogin);
  });

  it('login posts credentials, caches the token, and returns it', async () => {
    const io = memIo();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'new-tok' }), { status: 200 })) as unknown as typeof fetch;
    const tok = await login('http://x', { username: 'a', password: 'b' }, env, io, fetchImpl);
    expect(tok).toBe('new-tok');
    expect(fetchImpl).toHaveBeenCalledWith('http://x/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(io.store[tokenFile(env)]!)).toEqual({ token: 'new-tok' });
  });

  it('login surfaces a bad status as an error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(login('http://x', { username: 'a', password: 'b' }, env, memIo(), fetchImpl)).rejects.toThrow('HTTP 401');
  });

  it('clearToken removes the cached file', () => {
    const io = memIo({ [tokenFile(env)]: '{"token":"t"}' });
    clearToken(env, io);
    expect(io.store[tokenFile(env)]).toBeUndefined();
  });

  it('defaultIo writes the cache file 0600', () => {
    const dir = join(tmpdir(), `elowen-tok-${process.pid}`);
    const realEnv = { HOME: dir } as NodeJS.ProcessEnv;
    defaultIo.write(tokenFile(realEnv), JSON.stringify({ token: 't' }));
    const mode = statSync(tokenFile(realEnv)).mode & 0o777;
    expect(mode).toBe(0o600);
    defaultIo.remove(tokenFile(realEnv));
  });
});
