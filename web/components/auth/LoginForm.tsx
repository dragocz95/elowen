'use client';
import { useState } from 'react';
import { useLogin } from '../../lib/mutations';
import { setToken } from '../../lib/token';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';

export function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();
  const { toast } = useToast();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: ({ token }) => {
          setToken(token);
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
      <div className="bg-surface border border-border rounded-none p-8 w-full max-w-sm flex flex-col gap-4">
        <h1 className="uppercase tracking-wide text-sm text-text">Sign in to Orca</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="bg-bg border border-border rounded-none px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="bg-bg border border-border rounded-none px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <Button type="submit" variant="accent" disabled={login.isPending} className="w-full justify-center">
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
