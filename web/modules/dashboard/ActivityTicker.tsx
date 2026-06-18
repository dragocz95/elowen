'use client';
import { useActivity } from '../../lib/queries';
import { eventIcon } from '../timeline/eventMeta';
import { useTranslation } from '../../lib/i18n';
import type { ActivityEvent } from '../../lib/types';

function rel(ts: string): string {
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Item({ e }: { e: ActivityEvent }) {
  const Icon = eventIcon(e.type);
  return (
    <span className="mx-3 inline-flex items-center gap-1.5 text-xs text-text-muted">
      <Icon size={12} className="shrink-0 text-text-muted" aria-hidden />
      <span className="text-text">{e.target}</span>
      {e.detail ? <span className="truncate">{e.detail}</span> : null}
      <span className="font-mono text-[10px] text-text-muted">· {rel(e.ts)}</span>
    </span>
  );
}

export function ActivityTicker() {
  const activity = useActivity();
  const { t } = useTranslation();
  const events = (activity.data ?? []).slice(0, 14);
  if (events.length === 0) return null;
  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-surface px-4 py-2.5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#10b981]">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-[#10b981]" style={{ ['--live-ring' as string]: 'rgba(16,185,129,0.5)' }} aria-hidden />
        {t.common.live}
      </span>
      <div className="marquee-mask min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        <div className="marquee-track">
          {[...events, ...events].map((e, i) => <Item key={`${e.id}-${i}`} e={e} />)}
        </div>
      </div>
    </div>
  );
}
