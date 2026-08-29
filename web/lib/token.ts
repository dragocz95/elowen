// The daemon token now lives in an httpOnly cookie the browser JS cannot read; there is no
// getToken/setToken/withToken anymore. We keep the "auth cleared" signal so a 401 (stale/expired
// session) or an explicit logout flips the auth gate to the login form without a reload.
export const AUTH_CLEARED_EVENT = 'elowen:auth-cleared';

/** End the session: ask the proxy to expire the httpOnly cookie (best-effort) and notify the auth
 *  gate. Kept dependency-free (no elowenClient import) to avoid an import cycle. */
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* network/daemon down: still signal the UI */ });
  window.dispatchEvent(new Event(AUTH_CLEARED_EVENT));
}

/** The display name of the user currently being impersonated, or null when not impersonating. Read
 *  from the JS-readable hint cookie the BFF sets (the real session token stays httpOnly). */
export function impersonatingAs(): string | null {
  if (typeof document === 'undefined') return null;
  // HTTPS deliberately ignores the legacy name. A sibling published-site subdomain can set a
  // parent-domain `elowen_as` cookie, but it cannot mint a browser-reserved `__Host-` cookie.
  const name = window.location.protocol === 'https:' ? '__Host-elowen_as' : 'elowen_as';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Admin "sign in as": swap the session to another user, then hard-reload so every query refetches as
 *  the new user. Throws on a non-OK response (e.g. the daemon refused a non-admin caller). */
export async function impersonateUser(userId: number): Promise<void> {
  const res = await fetch('/api/auth/impersonate', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`impersonate failed: ${res.status}`);
  window.location.assign('/');
}

/** End impersonation: restore the admin session, then hard-reload. */
export async function stopImpersonation(): Promise<void> {
  await fetch('/api/auth/stop-impersonate', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* still reload */ });
  window.location.assign('/');
}
