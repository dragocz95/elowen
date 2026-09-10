import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../../src/brain/credentialStore.js';
import {
  ANTHROPIC_OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_CHECK_INTERVAL_MS,
  refreshExpiringAnthropicCredential,
  startOAuthCredentialRefreshLoop,
} from '../../src/brain/oauthRefresh.js';
import { FakeClock } from '../../src/shared/clock.js';

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const fakeCredential = (expires: number): Credential => ({
  type: 'oauth',
  access: 'fake-access-old',
  refresh: 'fake-refresh-old',
  expires,
});

let dir: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('Anthropic OAuth proactive refresh', () => {
  it('rotates and persists the credential before the access token reaches the request-time window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dir = mkdtempSync(join(tmpdir(), 'elowen-oauth-refresh-'));
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      anthropic: fakeCredential(NOW + ANTHROPIC_OAUTH_REFRESH_LEAD_MS),
    }));

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://platform.claude.com/v1/oauth/token');
      expect(JSON.parse(String(init?.body))).toEqual({
        grant_type: 'refresh_token',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        refresh_token: 'fake-refresh-old',
      });
      return new Response(JSON.stringify({
        access_token: 'fake-access-rotated',
        refresh_token: 'fake-refresh-rotated',
        expires_in: 28_800,
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const credentials = new FileCredentialStore(authPath);
    const runtime = await ModelRuntime.create({ credentials, refreshOnCreate: false });
    const getStored = (): Credential | undefined => JSON.parse(readFileSync(authPath, 'utf8')).anthropic;

    await expect(refreshExpiringAnthropicCredential(runtime, { get: getStored })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getStored()).toMatchObject({
      type: 'oauth',
      access: 'fake-access-rotated',
      refresh: 'fake-refresh-rotated',
    });
  });

  it('does not refresh a credential just outside the four-hour lead window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dir = mkdtempSync(join(tmpdir(), 'elowen-oauth-refresh-'));
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      anthropic: fakeCredential(NOW + ANTHROPIC_OAUTH_REFRESH_LEAD_MS + 1),
    }));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const credentials = new FileCredentialStore(authPath);
    const runtime = await ModelRuntime.create({ credentials, refreshOnCreate: false });
    const getStored = (): Credential | undefined => JSON.parse(readFileSync(authPath, 'utf8')).anthropic;

    await expect(refreshExpiringAnthropicCredential(runtime, { get: getStored })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks immediately and while the daemon is idle, without overlapping refreshes', async () => {
    const clock = new FakeClock(NOW);
    let release: (() => void) | undefined;
    let refreshSignal: AbortSignal | undefined;
    const runtime = {
      getAuth: vi.fn((_provider: string, options?: { signal?: AbortSignal }) => {
        refreshSignal = options?.signal;
        return new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
      }),
    };
    const log = { info: vi.fn(), error: vi.fn() };
    const stop = startOAuthCredentialRefreshLoop({
      runtime,
      credentials: { get: () => fakeCredential(NOW + ANTHROPIC_OAUTH_REFRESH_LEAD_MS) },
      clock,
      log,
    });

    expect(runtime.getAuth).toHaveBeenCalledTimes(1);
    clock.advance(OAUTH_REFRESH_CHECK_INTERVAL_MS * 2);
    expect(runtime.getAuth).toHaveBeenCalledTimes(1);
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(OAUTH_REFRESH_CHECK_INTERVAL_MS);
    expect(runtime.getAuth).toHaveBeenCalledTimes(2);

    const stopped = stop();
    expect(refreshSignal?.aborted).toBe(true);
    release?.();
    await stopped;
    clock.advance(OAUTH_REFRESH_CHECK_INTERVAL_MS);
    expect(runtime.getAuth).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });
});
