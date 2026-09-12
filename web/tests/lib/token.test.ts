import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearToken, AUTH_CLEARED_EVENT, AUTH_TRANSITION_EVENT, impersonateUser, stopImpersonation, subscribeAuthTransitions } from '../../lib/token';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); fetchMock.mockResolvedValue(new Response('{}', { status: 200 })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('clearToken', () => {
  it('asks the proxy to expire the cookie and fires AUTH_CLEARED_EVENT', () => {
    const fired = vi.fn();
    window.addEventListener(AUTH_CLEARED_EVENT, fired);
    clearToken();
    window.removeEventListener(AUTH_CLEARED_EVENT, fired);

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    expect(fired).toHaveBeenCalledOnce();
  });

  it('still fires the event when the logout request rejects (daemon down)', () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const fired = vi.fn();
    window.addEventListener(AUTH_CLEARED_EVENT, fired);
    clearToken();
    window.removeEventListener(AUTH_CLEARED_EVENT, fired);

    expect(fired).toHaveBeenCalledOnce();
  });
});

describe('identity transitions', () => {
  it('debounces a rapid duplicate and commits without a document navigation', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const phases: string[] = [];
    const listener = (event: Event) => phases.push((event as CustomEvent<{ phase: string }>).detail.phase);
    window.addEventListener(AUTH_TRANSITION_EVENT, listener);

    const first = impersonateUser(2);
    await expect(impersonateUser(2)).rejects.toThrow('identity transition already in progress');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['start']);

    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await first;
    expect(phases).toEqual(['start', 'commit']);
    window.removeEventListener(AUTH_TRANSITION_EVENT, listener);
  });

  it('retries one lost stop response before committing the identity', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const phases: string[] = [];
    const off = subscribeAuthTransitions((event) => phases.push(event.phase));
    await stopImpersonation();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['start', 'commit']);
    off();
  });

  it('rolls the transition back when the BFF refuses it', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    const phases: string[] = [];
    const off = subscribeAuthTransitions((event) => phases.push(event.phase));
    await expect(stopImpersonation()).rejects.toThrow('stop impersonation failed: 403');
    expect(phases).toEqual(['start', 'rollback']);
    off();
  });

  it('delivers a transition from another tab through the storage event', () => {
    const seen: string[] = [];
    const off = subscribeAuthTransitions((event) => seen.push(`${event.id}:${event.phase}`));
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'elowen:auth-transition',
      newValue: JSON.stringify({ id: 'other-tab', phase: 'commit', nonce: 1 }),
    }));
    expect(seen).toEqual(['other-tab:commit']);
    off();
  });
});
