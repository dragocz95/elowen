// The daemon token now lives in an httpOnly cookie the browser JS cannot read; there is no
// getToken/setToken/withToken anymore. We keep the "auth cleared" signal so a 401 (stale/expired
// session) or an explicit logout flips the auth gate to the login form without a reload.
export const AUTH_CLEARED_EVENT = 'orca:auth-cleared';

/** End the session: ask the proxy to expire the httpOnly cookie (best-effort) and notify the auth
 *  gate. Kept dependency-free (no orcaClient import) to avoid an import cycle. */
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* network/daemon down: still signal the UI */ });
  window.dispatchEvent(new Event(AUTH_CLEARED_EVENT));
}
