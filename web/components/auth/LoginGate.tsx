'use client';
// Auth gate. The session lives in an httpOnly cookie the browser JS can't read, so we probe it with
// `me()` on mount: it succeeds → open the shell; a 401 → no/invalid session, fall through to
// setup-or-login. ANY later 401 fires AUTH_CLEARED_EVENT, which flips us straight to the login form
// and drops cached data — so a stale/expired/deleted-user session can't strand the user in a broken shell.
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_CLEARED_EVENT } from '../../lib/token';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';
import { EventBridge } from '../../app/providers';
import { LoginForm } from './LoginForm';

type Gate = 'checking' | 'login' | 'open';

export function LoginGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking');
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;
    // Probe the session: me() succeeds when the httpOnly cookie is a valid session → open the shell.
    // A 401 means no/invalid session → a brand-new install (no users yet) shows onboarding without a
    // login, otherwise the login form. A transient/network error is treated as "not authed" so we show
    // login rather than a blank gate.
    orcaClient.me()
      .then(() => { if (alive) setGate('open'); })
      .catch((err: unknown) => {
        if (!alive) return;
        const status = err instanceof OrcaApiError ? err.status : undefined;
        if (status !== 401) { setGate('login'); return; }
        orcaClient.setupStatus()
          .then((s) => {
            if (!alive) return;
            if (s.needsSetup) { setGate('open'); if (pathname !== '/onboarding') router.replace('/onboarding'); }
            else setGate('login');
          })
          .catch(() => { if (alive) setGate('login'); });
      });
    return () => { alive = false; };
  }, [pathname, router]);

  // Token dropped (stale-token validation 401, mid-session 401, or explicit logout): go to login with
  // no reload, and clear the cache so a re-login can never flash the previous user's data.
  useEffect(() => {
    const onCleared = () => { qc.clear(); setGate('login'); };
    window.addEventListener(AUTH_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(AUTH_CLEARED_EVENT, onCleared);
  }, [qc]);

  if (gate === 'checking') return null;
  if (gate === 'login') return <LoginForm onAuthed={() => setGate('open')} />;

  return (
    <>
      <EventBridge />
      {children}
    </>
  );
}
