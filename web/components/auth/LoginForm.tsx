'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLogin } from '../../lib/mutations';
import { elowenClient } from '../../lib/elowenClient';
import { safeSsoNext, ssoErrorCode } from '../../lib/authSso';
import { useToast } from '../ui/Toast';
import { Button, buttonClassName } from '../ui/Button';
import { Input } from '../ui/Input';
import { ControlSurfaceDocument } from '../ui/ControlSurface';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 23 23" width="16" height="16" aria-hidden>
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}

export function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();
  // The provider list is PUBLIC instance metadata, not session data, so it deliberately does not live in
  // the react-query cache: any 401 calls clearToken(), and LoginGate's AUTH_CLEARED_EVENT handler answers
  // with qc.clear(), wiping the cache wholesale. The login screen provokes those 401s itself (/auth/me,
  // /config) while this list is in flight, so it was a race the list usually LOST — measured live, clear
  // ran at 160ms and 168ms against a response at 178ms. A cached list is dropped on arrival when its
  // query is already gone, and nothing refetches it, so the button silently never appeared.
  const [ssoProviders, setSsoProviders] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void elowenClient.ssoProviders()
      .then((list) => { if (!cancelled) setSsoProviders(list); })
      // No reachable provider list means SSO is simply not offered; the password form stands on its own.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const { toast } = useToast();
  const { t } = useTranslation();
  const brand = useBrand();
  const router = useRouter();
  const searchParams = useSearchParams();
  const shownError = useRef<string | null>(null);
  const error = searchParams.get('sso_error');

  useEffect(() => {
    if (!error || shownError.current === error) return;
    shownError.current = error;
    const code = ssoErrorCode(error);
    toast(t.auth.ssoErrors[code], 'error');
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('sso_error');
    const query = nextParams.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [error, router, searchParams, t.auth.ssoErrors, toast]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          // The proxy set the httpOnly session cookie; nothing to store client-side.
          onAuthed();
        },
        onError: (err) => {
          toast(String(err), 'error');
        },
      },
    );
  }

  const currentTarget = typeof window === 'undefined'
    ? '/'
    : safeSsoNext(`${window.location.pathname}${window.location.search}`);
  const showMicrosoft = ssoProviders.length > 0;

  return (
    <div className="flex h-screen items-center justify-center bg-bg">
      <ControlSurfaceDocument className="animate-pop-in flex w-full max-w-sm flex-col gap-4 p-8">
        <img src={brand.logoSrc} alt={brand.appName} className="logo-adaptive mx-auto h-auto w-64" />
        <h1 className="text-center text-sm uppercase tracking-wide text-text-muted">{t.auth.signIn}</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input type="text" placeholder={t.auth.usernamePlaceholder} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <Input type="password" placeholder={t.auth.passwordPlaceholder} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <Button type="submit" variant="accent" disabled={login.isPending} className="w-full justify-center">
            {t.auth.signIn}
          </Button>
        </form>
        {showMicrosoft ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 text-xs text-text-muted" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              <span>{t.auth.or}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <a
              href={`/api/auth/sso/microsoft/start?next=${encodeURIComponent(currentTarget)}`}
              className={buttonClassName('ghost', 'w-full justify-center')}
            >
              <MicrosoftLogo />
              {t.auth.signInWithMicrosoft}
            </a>
          </div>
        ) : null}
      </ControlSurfaceDocument>
    </div>
  );
}
