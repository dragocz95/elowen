'use client';
import { useHeatmap, usePresence } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { LoadingState } from '../../components/ui/states';
import type { LocaleDict } from '../../lib/i18n/types';
import type { HeatmapBucket, PresenceEntry } from '../../lib/types';

const DAYS = 14;
const HOURS = 24;

/** Initials for the rail: first letters of the first two words, so "Filip Džudža" reads as FD and a
 *  single-word username still shows something. Uses code points, not UTF-16 units, or a name starting
 *  with an astral character would render half a glyph. */
function initials(label: string): string {
  return label.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? '').join('').toUpperCase();
}

/** One dot per person, brightest for whoever is mid-turn. */
function PresenceRail({ people, t }: { people: PresenceEntry[]; t: LocaleDict }) {
  if (people.length === 0) return <p className="text-sm text-text-muted">{t.dashboard.pulseNobody}</p>;
  return (
    <ul className="flex flex-wrap items-center gap-2">
      {people.map((p) => (
        <li
          key={p.userId}
          title={p.working ? `${p.label} — ${t.dashboard.workingNow}` : p.label}
          className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[11px] transition-colors ${
            p.working ? 'border-accent/50 bg-accent/10 text-text' : 'border-border text-text-muted'
          }`}
        >
          <span
            aria-hidden
            className={`grid h-5 w-5 place-items-center rounded-full font-mono text-[9px] ${
              p.working ? 'bg-accent/25 text-text' : 'bg-surface text-text-muted'
            }`}
          >
            {initials(p.label)}
          </span>
          <span className="max-w-[9rem] truncate">{p.label}</span>
          {p.working ? <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-success" /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The last N days as YYYY-MM-DD in UTC, oldest first — the same key the daemon's rollup stores, so the
 *  two never disagree about which bucket a turn belongs to. */
function recentDays(): string[] {
  const today = Date.now();
  return Array.from({ length: DAYS }, (_, i) => new Date(today - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Five steps, so an ordinary hour is still visible next to a peak one. Level 0 is drawn as an empty
 *  cell rather than omitted, because the grid's shape is what makes the quiet hours readable. */
function level(count: number, max: number): number {
  if (count <= 0) return 0;
  return Math.min(4, Math.ceil((count / Math.max(max, 1)) * 4));
}

const LEVEL_CLASS = [
  'bg-border/25',
  'bg-accent/20',
  'bg-accent/40',
  'bg-accent/65',
  'bg-accent/90',
];

/** How busy the instance has been, hour by hour. */
export function TeamPulseTile() {
  const { t } = useTranslation();
  const heatmap = useHeatmap(DAYS);
  const people = usePresence().data ?? [];

  const buckets = heatmap.data ?? [];
  const byKey = new Map(buckets.map((b: HeatmapBucket) => [`${b.day}:${b.hour}`, b.count]));
  const max = buckets.reduce((n, b) => Math.max(n, b.count), 0);
  const days = recentDays();
  const total = buckets.reduce((n, b) => n + b.count, 0);

  return (
    <section aria-labelledby="dashboard-pulse" className="px-1 py-6 @sm:px-3 @2xl:px-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="dashboard-pulse" className="dash-label">{t.dashboard.pulse}</h2>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">
          {t.dashboard.pulseTurns.replace('{count}', String(total)).replace('{days}', String(DAYS))}
        </span>
      </header>

      <div className="mb-4"><PresenceRail people={people} t={t} /></div>

      {heatmap.isLoading ? (
        <LoadingState />
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-col gap-[3px]" role="img" aria-label={t.dashboard.pulseAria}>
            {days.map((day) => (
              <div key={day} className="flex items-center gap-[3px]">
                {Array.from({ length: HOURS }, (_, hour) => {
                  const count = byKey.get(`${day}:${hour}`) ?? 0;
                  return (
                    <span
                      key={hour}
                      title={`${day} ${String(hour).padStart(2, '0')}:00 — ${count}`}
                      className={`h-3 flex-1 rounded-[2px] ${LEVEL_CLASS[level(count, max)]}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* Only the ends and midday are labelled: 24 numbers under a 24-cell row is noise. */}
          <div className="flex justify-between font-mono text-[9px] tabular-nums text-text-muted">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>
      )}
    </section>
  );
}
