'use client';
import type { Tone } from './tone';
import { useCountUp } from '../../lib/useCountUp';

const VALUE_TONE: Record<Tone, string> = {
  default: 'text-text',
  accent: 'text-accent',
  muted: 'text-text-muted',
  danger: 'text-danger',
  success: 'text-success',
  warning: 'text-warning',
};

export function StatCard({ label, value, hint, tone = 'default' }: { label: string; value: string | number; hint?: string; tone?: Tone }) {
  const numeric = typeof value === 'number' ? value : 0;
  const animated = useCountUp(numeric);
  const display = typeof value === 'number' ? animated : value;
  return (
    <div className="card-interactive animate-fade-up flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
      <span className="font-mono uppercase tracking-widest text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>{label}</span>
      <span className={`font-mono tabular-nums ${VALUE_TONE[tone]}`} style={{ fontSize: 'var(--text-display)' }}>{display}</span>
      {hint ? <span className="text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>{hint}</span> : null}
    </div>
  );
}
