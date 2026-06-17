import type { ActivityEvent } from '../../lib/types';

const HOURS = 12;
const HOUR_MS = 3_600_000;

export function bucketByHour(events: ActivityEvent[], now: number): { label: string; count: number }[] {
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const buckets = Array.from({ length: HOURS }, (_, i) => {
    const start = currentHourStart - (HOURS - 1 - i) * HOUR_MS;
    const h = new Date(start).getUTCHours();
    return { start, label: `${String(h).padStart(2, '0')}:00`, count: 0 };
  });
  for (const e of events) {
    const t = Date.parse(e.ts.includes('T') ? e.ts : e.ts.replace(' ', 'T') + 'Z'); // sqlite 'YYYY-MM-DD HH:MM:SS' → ISO UTC
    if (Number.isNaN(t)) continue;
    const bucketStart = Math.floor(t / HOUR_MS) * HOUR_MS;
    const idx = buckets.findIndex((b) => b.start === bucketStart);
    if (idx >= 0) buckets[idx].count += 1;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}
