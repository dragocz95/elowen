// The daemon token lives in an httpOnly cookie the browser JS cannot read. Browser code coordinates only
// lifecycle signals: authentication cleared, or an account identity transition beginning/committing.
export const AUTH_CLEARED_EVENT = 'elowen:auth-cleared';
export const AUTH_TRANSITION_EVENT = 'elowen:auth-transition';
const AUTH_TRANSITION_STORAGE_KEY = 'elowen:auth-transition';

type AuthTransitionPhase = 'start' | 'commit' | 'rollback';
export interface AuthTransition {
  id: string;
  phase: AuthTransitionPhase;
}

let activeTransition: string | null = null;

function transitionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Publish locally and to sibling tabs. The storage value contains no identity or credential, and is
 *  removed immediately; its only purpose is making the browser emit a cross-tab `storage` event. */
function publishTransition(detail: AuthTransition): void {
  window.dispatchEvent(new CustomEvent<AuthTransition>(AUTH_TRANSITION_EVENT, { detail }));
  try {
    localStorage.setItem(AUTH_TRANSITION_STORAGE_KEY, JSON.stringify({ ...detail, nonce: Math.random() }));
    localStorage.removeItem(AUTH_TRANSITION_STORAGE_KEY);
  } catch { /* storage unavailable: the initiating tab still transitions safely */ }
}

export function subscribeAuthTransitions(listener: (transition: AuthTransition) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onLocal = (event: Event) => listener((event as CustomEvent<AuthTransition>).detail);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_TRANSITION_STORAGE_KEY || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as Partial<AuthTransition>;
      if (typeof parsed.id === 'string' && ['start', 'commit', 'rollback'].includes(String(parsed.phase))) {
        listener(parsed as AuthTransition);
      }
    } catch { /* malformed cross-tab state is ignored */ }
  };
  window.addEventListener(AUTH_TRANSITION_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(AUTH_TRANSITION_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

function beginTransition(): string {
  if (activeTransition) throw new Error('identity transition already in progress');
  activeTransition = transitionId();
  publishTransition({ id: activeTransition, phase: 'start' });
  return activeTransition;
}

function finishTransition(id: string, phase: 'commit' | 'rollback'): void {
  publishTransition({ id, phase });
  if (activeTransition === id) activeTransition = null;
}

/** End the session and notify the local auth gate. */
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* network/daemon down: still signal the UI */ });
  window.dispatchEvent(new Event(AUTH_CLEARED_EVENT));
}

/** The display name of the user currently being impersonated, or null when not impersonating. */
export function impersonatingAs(): string | null {
  if (typeof document === 'undefined') return null;
  const name = window.location.protocol === 'https:' ? '__Host-elowen_as' : 'elowen_as';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Swap to another account. The start signal synchronously tears down old account state before the BFF
 *  changes the cookie; commit then loads the new identity without a document reload. */
export async function impersonateUser(userId: number): Promise<void> {
  const id = beginTransition();
  try {
    const res = await fetch('/api/auth/impersonate', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`impersonate failed: ${res.status}`);
    finishTransition(id, 'commit');
  } catch (error) {
    finishTransition(id, 'rollback');
    throw error;
  }
}

/** A lost response is the one retryable failure here: the daemon keeps the exchange idempotent for a
 *  bounded window, so repeating the exact cookie-bound request cannot mint a second authority chain. */
async function requestStopImpersonation(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch('/api/auth/stop-impersonate', { method: 'POST', credentials: 'same-origin' });
    } catch (error) {
      if (attempt > 0) throw error;
      lastError = error;
      continue;
    }
    if (res.ok) return;
    const error = new Error(`stop impersonation failed: ${res.status}`);
    if (res.status < 500 || attempt > 0) throw error;
    lastError = error;
  }
  throw lastError instanceof Error ? lastError : new Error('stop impersonation failed');
}

/** Exchange the active target session and opaque return proof for a fresh admin session. */
export async function stopImpersonation(): Promise<void> {
  const id = beginTransition();
  try {
    await requestStopImpersonation();
    finishTransition(id, 'commit');
  } catch (error) {
    finishTransition(id, 'rollback');
    throw error;
  }
}
