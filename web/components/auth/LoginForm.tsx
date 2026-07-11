'use client';
import { useState } from 'react';
import { useLogin } from '../../lib/mutations';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ControlSurfaceDocument } from '../ui/ControlSurface';
import { useTranslation } from '../../lib/i18n';

export function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();
  const { toast } = useToast();
  const { t } = useTranslation();

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

  return (
    <div className="flex h-screen items-center justify-center bg-bg">
      <ControlSurfaceDocument className="animate-pop-in flex w-full max-w-sm flex-col gap-4 p-8">
        <img src="/elowen-logo.png" alt="Elowen" className="logo-adaptive mx-auto h-auto w-64" />
        <h1 className="text-center text-sm uppercase tracking-wide text-text-muted">{t.auth.signIn}</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input type="text" placeholder={t.auth.usernamePlaceholder} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <Input type="password" placeholder={t.auth.passwordPlaceholder} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <Button type="submit" variant="accent" disabled={login.isPending} className="w-full justify-center">
            {t.auth.signIn}
          </Button>
        </form>
      </ControlSurfaceDocument>
    </div>
  );
}
