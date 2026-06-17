'use client';
import { useHealth } from '../../lib/queries';

export function TopBar() {
  const { data } = useHealth();
  const up = data?.ok === true;
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
      <span className="font-mono text-xs uppercase tracking-wide text-text-muted">orca</span>
      <span
        aria-label={up ? 'daemon up' : 'daemon down'}
        className={`inline-block h-2 w-2 rounded-none ${up ? 'bg-accent' : 'bg-text-muted'}`}
      />
    </header>
  );
}
