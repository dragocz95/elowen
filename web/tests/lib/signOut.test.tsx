import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';

const logout = vi.fn();
const clearToken = vi.fn();
vi.mock('../../lib/elowenClient', () => ({ elowenClient: { logout: () => logout() } }));
vi.mock('../../lib/token', () => ({ clearToken: () => clearToken(), AUTH_CLEARED_EVENT: 'elowen:auth-cleared' }));

import { useSignOut } from '../../lib/mutations';

const reload = vi.fn();

describe('useSignOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { value: { reload }, writable: true });
  });

  const run = () => {
    const { result } = renderHook(() => useSignOut(), { wrapper: createWrapper().wrapper });
    act(() => { result.current.signOut(); });
    return result;
  };

  it('clears the session and reloads once the daemon confirms', async () => {
    logout.mockResolvedValue({ ok: true });
    run();
    await waitFor(() => expect(clearToken).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The case that matters: an unreachable daemon must not leave the user inside a session the UI still
  // believes in. A logout that only works while the server answers is not a logout.
  it('clears the session and reloads even when the request fails', async () => {
    logout.mockRejectedValue(new Error('daemon unreachable'));
    run();
    await waitFor(() => expect(clearToken).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
