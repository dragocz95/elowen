import type { ReactNode } from 'react';
import type { Tone } from './tone';

const TONES: Record<Tone, string> = {
  default: 'border-border bg-elevated text-text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  muted: 'border-border bg-elevated text-text-muted',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  success: 'border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]',
  warning: 'border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b]',
};

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}
