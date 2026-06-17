'use client';
// Presence-based auth gate: checks for a stored token on mount.
// LIMITATION: if a mid-session query returns 401 (token cleared by orcaClient),
// the gate will NOT automatically re-render to show the login form — the user
// must reload the page. This is an accepted limitation for this slice; a
// proper solution would require a global auth-state context or router event.
import { useEffect, useState, type ReactNode } from 'react';
import { getToken } from '../../lib/token';
import { EventBridge } from '../../app/providers';
import { LoginForm } from './LoginForm';

export function LoginGate({ children }: { children: ReactNode }) {
  // Start false (SSR-safe) and sync on mount to avoid hydration mismatch.
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(getToken() != null);
  }, []);

  if (!hasToken) {
    return <LoginForm onAuthed={() => setHasToken(true)} />;
  }

  return (
    <>
      <EventBridge />
      {children}
    </>
  );
}
