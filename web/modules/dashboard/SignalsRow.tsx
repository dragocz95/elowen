'use client';
import Link from 'next/link';
import { Radio, ShieldQuestion, Coins, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { TONE_TEXT, type Tone } from '../../components/ui/tone';

/** One big, meaningful number — muted at rest, toned when it demands attention. Optionally a link
 *  (a waiting decision jumps to the escalations inbox). The value stays legible (text-text) at rest;
 *  only accent/warning tones tint it. */
function Signal({ value, label, icon: Icon, tone, href }: { value: string; label: string; icon: LucideIcon; tone: Tone; href?: string }) {
  const quiet = tone === 'default' || tone === 'muted';
  const body = (
    <div className="flex flex-1 flex-col gap-2 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong" style={{ boxShadow: 'var(--shadow-card)' }}>
      <Icon size={18} className={quiet ? 'text-text-muted' : TONE_TEXT[tone]} aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span className={`font-display text-3xl font-semibold leading-none tabular-nums ${quiet ? 'text-text' : TONE_TEXT[tone]}`}>{value}</span>
        <span className="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
      </div>
    </div>
  );
  return href ? <Link href={href} className="flex flex-1">{body}</Link> : body;
}

/** The headline metrics: only numbers that mean something right now — agents actively working,
 *  decisions a human owes an answer to, and this month's spend. Each stays neutral at zero and lights
 *  up when it matters. */
export function SignalsRow({ agentsActive, decisionsWaiting, monthCost }: { agentsActive: number; decisionsWaiting: number; monthCost: string }) {
  const { t } = useTranslation();
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Signal
        value={String(agentsActive)}
        label={t.dashboard.signalAgentsActive}
        icon={Radio}
        tone={agentsActive > 0 ? 'accent' : 'muted'}
      />
      <Signal
        value={String(decisionsWaiting)}
        label={t.dashboard.signalDecisionsWaiting}
        icon={ShieldQuestion}
        tone={decisionsWaiting > 0 ? 'warning' : 'muted'}
        href={decisionsWaiting > 0 ? '/escalations' : undefined}
      />
      <Signal
        value={monthCost}
        label={t.dashboard.signalMonthCost}
        icon={Coins}
        tone="default"
      />
    </section>
  );
}
