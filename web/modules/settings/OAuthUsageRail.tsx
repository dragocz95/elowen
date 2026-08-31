import { useTranslation } from '../../lib/i18n';
import { Progress } from '../../components/ui/shadcn/progress';
import type { ProviderUsage } from '../../lib/types';

/** Human window label from its minute span, mirroring the CLI rail (300 → "5h", 10080 → "weekly"). */
export function usageWindowLabel(minutes: number | null, weekly: string, windowWord: string): string {
  if (minutes === 10_080) return weekly;
  if (minutes == null || minutes <= 0) return windowWord;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

/** Usage is pressure, and this is the ONE place its thresholds live: accent below 70 %, warning from
 *  70 %, danger from 90 %, matching the CLI meter. The subscription windows here and the chat rail's
 *  context meter both read it, so every meter in the product changes colour at the same number. */
function usagePressure(pct: number): 'normal' | 'warning' | 'critical' {
  return pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'normal';
}

/** The ramp addressed at a `Progress` fill. Spelled out per branch rather than composed from a colour
 *  name because Tailwind scans class names statically — an interpolated `bg-${tone}` would never be
 *  emitted into the stylesheet. */
export function usageProgressClass(pct: number): string {
  switch (usagePressure(pct)) {
    case 'critical': return 'bg-destructive';
    case 'warning': return 'bg-warning';
    default: return 'bg-primary';
  }
}

/** A tiny non-zero usage still shows a sliver, so a meter that is barely used never reads as untouched. */
export function usageMeterValue(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return clamped > 0 ? Math.max(clamped, 3) : 0;
}

function resetLabel(resetsAt: number | null): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return '';
  const at = new Date(resetsAt * 1_000);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The per-account subscription usage rail shown in a connected OAuth row's control column: one slim
 *  meter per window (e.g. 5h, weekly) with its used-percent, coloured by pressure. Renders nothing when
 *  the account reports no windows. Shared verbatim with the chat telemetry rail's limits section, so the
 *  two surfaces cannot drift apart. */
export function OAuthUsageRail({ usage }: { usage: ProviderUsage }) {
  const { t } = useTranslation();
  if (!usage.windows.length) return null;
  return (
    <div className="flex w-full flex-col gap-1.5">
      {usage.windows.map((w, i) => {
        const pct = Math.max(0, Math.min(100, w.usedPercent));
        const reset = resetLabel(w.resetsAt);
        return (
          <div
            key={i}
            data-testid="oauth-usage-window"
            className="flex items-center gap-2 text-xs"
            title={reset ? t.brain.usageResets.replace('{time}', reset) : undefined}
          >
            <span className="w-12 shrink-0 text-muted-foreground">
              {usageWindowLabel(w.windowMinutes, t.brain.usageWeekly, t.brain.usageWindow)}
            </span>
            <Progress
              data-testid="oauth-usage-track"
              className="flex-1"
              value={pct}
              indicatorValue={usageMeterValue(pct)}
              indicatorClassName={usageProgressClass(pct)}
              aria-label={usageWindowLabel(w.windowMinutes, t.brain.usageWeekly, t.brain.usageWindow)}
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-foreground">{Math.round(pct)}%</span>
          </div>
        );
      })}
    </div>
  );
}
