import { useTranslation } from '../../lib/i18n';
import type { ProviderUsage } from '../../lib/types';

/** Human window label from its minute span, mirroring the CLI rail (300 → "5h", 10080 → "weekly"). */
function windowLabel(minutes: number | null, weekly: string, windowWord: string): string {
  if (minutes === 10_080) return weekly;
  if (minutes == null || minutes <= 0) return windowWord;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

/** Usage is pressure: the fill shifts accent → warning (70 %) → danger (90 %), matching the CLI meter.
 *  Shared with the chat telemetry panel's context meter so every usage bar reads the same. */
export function usageFillClass(pct: number): string {
  return pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-primary';
}

function resetLabel(resetsAt: number | null): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return '';
  const at = new Date(resetsAt * 1_000);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The per-account subscription usage rail shown in a connected OAuth row's control column: one slim
 *  meter per window (e.g. 5h, weekly) with its used-percent, coloured by pressure. Renders nothing when
 *  the account reports no windows. A tiny non-zero usage still shows a sliver so it never reads as empty. */
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
            <span className="w-12 shrink-0 text-text-muted">
              {windowLabel(w.windowMinutes, t.brain.usageWeekly, t.brain.usageWindow)}
            </span>
            <span data-testid="oauth-usage-track" className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
              <span
                className={`block h-full rounded-full ${usageFillClass(pct)} transition-[width] duration-500`}
                style={{ width: `${pct > 0 ? Math.max(pct, 3) : 0}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right tabular-nums text-text">{Math.round(pct)}%</span>
          </div>
        );
      })}
    </div>
  );
}
