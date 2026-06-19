'use client';
// Presence-based auth gate: checks for a stored token on mount.
// LIMITATION: if a mid-session query returns 401 (token cleared by orcaClient),
// the gate will NOT automatically re-render to show the login form — the user
// must reload the page. This is an accepted limitation for this slice; a
// proper solution would require a global auth-state context or router event.
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken } from '../../lib/token';
import { orcaClient } from '../../lib/orcaClient';
import { EventBridge } from '../../app/providers';
import { LoginForm } from './LoginForm';

type Gate = 'checking' | 'login' | 'open';

export function LoginGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking');
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (getToken() != null) { setGate('open'); return; }
    // No token: a brand-new install (no users yet) shows onboarding without a login; a configured
    // instance shows the login form.
    let alive = true;
    orcaClient.setupStatus()
      .then((s) => {
        if (!alive) return;
        if (s.needsSetup) { setGate('open'); if (pathname !== '/onboarding') router.replace('/onboarding'); }
        else setGate('login');
      })
      .catch(() => { if (alive) setGate('login'); });
    return () => { alive = false; };
  }, [pathname, router]);

  if (gate === 'checking') return null;
  if (gate === 'login') return <LoginForm onAuthed={() => setGate('open')} />;

  return (
    <>
      <EventBridge />
      {children}
    </>
  );
}
