'use client';
// Auth gate. The session lives in an httpOnly cookie the browser JS can't read, so we probe it with
// `me()` on mount: it succeeds → open the shell; a 401 → no/invalid session, fall through to
// setup-or-login. ANY later 401 fires AUTH_CLEARED_EVENT, which flips us straight to the login form
// and drops cached data — so a stale/expired/deleted-user session can't strand the user in a broken shell.
//
// While the session query is in flight the children (the app shell) ALREADY render: their queries race
// it instead of waiting for it, so the dashboard fills progressively rather than in a two-stage waterfall.
// That is safe because a child only ever renders data its own authenticated fetch returned — an
// unauthenticated visitor sees chrome and skeletons for a beat, every child query 401s, and the first
// 401 flips the gate to the login form (the same end state the probe would reach).
//
// The gate reads the session through the SAME useMe() query the rest of the app uses, rather than
// fetching /auth/me itself and seeding the result. Seeding cannot win the race now that children mount
// immediately: their useMe() fires on the same tick as the gate's own probe, so the app would ask twice.
// Sharing one query key makes the duplicate structurally impossible instead of merely unlikely.
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_CLEARED_EVENT } from '../../lib/token';
import { elowenClient } from '../../lib/elowenClient';
import { useMe } from '../../lib/queries';
import { EventBridge } from '../../app/providers';
import { LoginForm } from './LoginForm';
import { SetupPending } from './SetupPending';

type Gate = 'checking' | 'open' | 'login' | 'setup';

export function LoginGate({ children, initiallyAuthenticated = false, sessionPresent = true }: { children: ReactNode; initiallyAuthenticated?: boolean; sessionPresent?: boolean }) {
  // A server-prefetched identity already proved this exact request's httpOnly session. Conversely, the
  // server's absence of a cookie proves it is logged out. Only a present-but-unvalidated cookie checks.
  const [gate, setGate] = useState<Gate>(initiallyAuthenticated ? 'open' : sessionPresent ? 'checking' : 'login');
  const qc = useQueryClient();
  const me = useMe();
  const meSettled = !me.isPending;
  const meFailed = me.error;

  useEffect(() => {
    if (!meSettled) return;
    // The session query answers the gate: data means the httpOnly cookie is a valid session → open the
    // shell. A 401 means no/invalid session → on a box where the installer never finished there is no
    // account to sign in as, so we say that instead of showing a login nobody can pass. A transient/
    // network error is treated as "not authed" so we show login rather than a blank gate.
    setGate(meFailed ? 'login' : 'open');
  }, [meSettled, meFailed]);

  // Whether "log in" is even meaningful is a separate question from whether this session is valid, so it
  // gets its own probe. Hanging it off the session query does not work: a 401 clears the query cache
  // synchronously, which leaves useMe() pending forever and the probe unreachable — the bug that made the
  // old first-run route dead code. Keyed on the gate, it runs however we arrived at the login screen.
  useEffect(() => {
    if (gate !== 'login') return;
    let alive = true;
    elowenClient.setupStatus()
      .then((s) => { if (alive && s.needsSetup) setGate('setup'); })
      .catch(() => { /* unreachable daemon: the login form is still the honest fallback */ });
    return () => { alive = false; };
  }, [gate]);

  // Token dropped (stale-token validation 401, mid-session 401, or explicit logout): go to login with
  // no reload, and clear the cache so a re-login can never flash the previous user's data.
  useEffect(() => {
    const onCleared = () => { qc.clear(); setGate('login'); };
    window.addEventListener(AUTH_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(AUTH_CLEARED_EVENT, onCleared);
  }, [qc]);

  // The login form REPLACES the shell (an unauthenticated visitor must not reach the app), but the
  // 'checking' state renders children so the shell and its query fan-out start immediately.
  if (gate === 'setup') return <SetupPending />;
  if (gate === 'login') return <Suspense fallback={null}><LoginForm onAuthed={() => setGate('open')} /></Suspense>;

  return (
    <>
      {/* The SSE bridge stays gated on a confirmed session: mounted tokenless it would 401 once and
          EventSource has no hook to reconnect after login. */}
      {gate === 'open' ? <EventBridge /> : null}
      {/* Next still server-renders these client pages during the build, and several of them read
          useSearchParams(), which bails out of SSR unless a Suspense boundary catches it. While the gate
          returned null until the probe settled, the prerender never reached that call — now it does, and
          without this boundary `next build` fails on the first such page. One boundary here covers every
          route, so a new page cannot reintroduce the failure by forgetting its own. The fallback is null
          because it is only ever seen by the build: in the browser nothing here suspends. */}
      <Suspense fallback={null}>{children}</Suspense>
    </>
  );
}
